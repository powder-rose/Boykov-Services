import { useCallback, useEffect, useRef, useState } from "react";
import {
  BarChart3,
  ChevronDown,
  CircleHelp,
  Eye,
  Globe2,
  Inbox,
  MousePointer2,
  Newspaper,
  RefreshCw,
  Settings2,
  X,
} from "lucide-react";
import { api, dateTime, errorText, number, post } from "../api";
import { Empty, Notice, PageHead } from "../components/Common";
import "./Statistics.css";

type Period = "24h" | "7" | "30" | "90";
type Site = {
  id: string;
  name: string;
  host: string;
  connected: boolean;
  settings: {
    counterIds: string[];
    articlePrefixes: string[];
    includeSubdomains: boolean;
    version: number;
  };
};
type Point = {
  at: string;
  end: string;
  visits: number | null;
  views: number | null;
  articles: number | null;
  leads: number;
};
type PageRow = { path: string; url: string; title: string; views: number };
type Report = {
  site: { id: string; name: string; host: string };
  period: { key: Period; from: string; to: string; group: "hour" | "day" };
  status: "ready" | "unconfigured" | "error" | "stale";
  error: string | null;
  fetchedAt: string | null;
  checkedAt: string;
  dataLag: number;
  sampled: boolean;
  truncated: boolean;
  totals: {
    visits: number | null;
    views: number | null;
    articles: number | null;
    leads: number;
  };
  daily: Point[];
  sources: { name: string; visits: number }[];
  pages: PageRow[];
  articles: PageRow[];
  articlePrefixes: string[];
  leadsSince: string;
  counterIds: string[];
};
const periods: { key: Period; label: string }[] = [
  { key: "24h", label: "24 часа" },
  { key: "7", label: "7 дней" },
  { key: "30", label: "30 дней" },
  { key: "90", label: "90 дней" },
];
const labelDate = (value: string, hour = false) =>
  new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    ...(hour ? { hour: "2-digit", minute: "2-digit" } : {}),
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
const hourLabel = (value: string) =>
  new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
const metric = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : number(value);

function TrafficChart({
  points,
  hourly,
}: {
  points: Point[];
  hourly: boolean;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => setSelected(null), [points]);
  const available = points.length > 0 && points[0].views !== null;
  if (!available)
    return (
      <div className="stats-chart-empty">
        <BarChart3 size={32} strokeWidth={1.3} />
        <p>Здесь появится динамика посещаемости</p>
        <span>После подключения счётчика Яндекс Метрики</span>
      </div>
    );
  const max = Math.max(
      1,
      ...points.map((p) => Math.max(p.views || 0, p.visits || 0)),
    ),
    ceiling =
      Math.ceil(max / Math.pow(10, Math.floor(Math.log10(max)))) *
      Math.pow(10, Math.floor(Math.log10(max)));
  const width = 760,
    height = 245,
    left = 38,
    right = 15,
    top = 18,
    bottom = 30;
  const x = (i: number) =>
      left + ((width - left - right) * i) / Math.max(1, points.length - 1),
    y = (n: number) => top + (height - top - bottom) * (1 - n / ceiling);
  const line = (key: "views" | "visits") =>
    points.map((p, i) => `${x(i)},${y(p[key] || 0)}`).join(" ");
  const index =
      selected === null
        ? points.length - 1
        : Math.min(selected, points.length - 1),
    point = points[index];
  const ticks = [
    ...new Set([
      0,
      Math.floor((points.length - 1) / 3),
      Math.floor((2 * (points.length - 1)) / 3),
      points.length - 1,
    ]),
  ];
  return (
    <div className="stats-chart-wrap">
      <div className="stats-chart-readout" aria-live="polite">
        <span>{labelDate(point.at, hourly)}</span>
        <b>
          {number(point.views || 0)} <small>просмотров</small>
        </b>
        <b>
          {number(point.visits || 0)} <small>визитов</small>
        </b>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        tabIndex={0}
        aria-label="Динамика трафика. Стрелки влево и вправо выбирают точку графика."
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            setSelected(
              Math.min(
                points.length - 1,
                Math.max(0, index + (e.key === "ArrowLeft" ? -1 : 1)),
              ),
            );
          }
        }}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect(),
            relative = ((e.clientX - r.left) / r.width) * width;
          setSelected(
            Math.max(
              0,
              Math.min(
                points.length - 1,
                Math.round(
                  ((relative - left) / (width - left - right)) *
                    (points.length - 1),
                ),
              ),
            ),
          );
        }}
        onPointerLeave={() => setSelected(null)}
      >
        <title>Просмотры страниц и визиты по {hourly ? "часам" : "дням"}</title>
        {[0, 0.5, 1].map((r) => (
          <g key={r}>
            <line
              className="stats-gridline"
              x1={left}
              x2={width - right}
              y1={y(ceiling * r)}
              y2={y(ceiling * r)}
            />
            <text className="stats-axis-label" x={0} y={y(ceiling * r) + 4}>
              {number(Math.round(ceiling * r))}
            </text>
          </g>
        ))}
        <polygon
          className="stats-chart-area"
          points={`${x(0)},${y(0)} ${line("views")} ${x(points.length - 1)},${y(0)}`}
        />
        <polyline className="stats-chart-views" points={line("views")} />
        <polyline className="stats-chart-visits" points={line("visits")} />
        {selected !== null && (
          <g>
            <line
              className="stats-chart-cursor"
              x1={x(index)}
              x2={x(index)}
              y1={top}
              y2={y(0)}
            />
            <circle
              className="stats-chart-point"
              cx={x(index)}
              cy={y(point.views || 0)}
              r={4}
            />
          </g>
        )}
        {ticks.map((i) => (
          <text
            key={i}
            className="stats-axis-label"
            x={x(i)}
            y={height - 5}
            textAnchor={
              i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"
            }
          >
            {hourly ? hourLabel(points[i].at) : labelDate(points[i].at)}
          </text>
        ))}
      </svg>
      {!points.some((p) => p.views || p.visits) && (
        <p className="stats-chart-zero">
          За выбранный период визитов пока нет.
        </p>
      )}
    </div>
  );
}

function ConnectionDialog({
  site,
  oauthConfigured,
  onClose,
  onChange,
}: {
  site: Site;
  oauthConfigured: boolean;
  onClose: () => void;
  onChange: (close: boolean) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [token, setToken] = useState(""),
    [tokenOpen, setTokenOpen] = useState(!oauthConfigured),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [ids, setIds] = useState(site.settings.counterIds.join(", ")),
    [prefixes, setPrefixes] = useState(
      site.settings.articlePrefixes.join("\n"),
    ),
    [subdomains, setSubdomains] = useState(site.settings.includeSubdomains);
  const [counters, setCounters] = useState<
    { id: string; name: string; site: string }[]
  >([]);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    setIds(site.settings.counterIds.join(", "));
    setPrefixes(site.settings.articlePrefixes.join("\n"));
    setSubdomains(site.settings.includeSubdomains);
  }, [site.id, site.settings.version]);
  useEffect(() => {
    if (!oauthConfigured) return;
    const c = new AbortController();
    void api<{ counters: typeof counters }>("/statistics/counters", {
      signal: c.signal,
    })
      .then((r) => setCounters(r.counters))
      .catch(() => {});
    return () => c.abort();
  }, [oauthConfigured, site.settings.version]);
  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post("/statistics/connection", { token: token.trim() });
      setToken("");
      setTokenOpen(false);
      await onChange(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/statistics/sites/${site.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          counterIds: ids.split(/[\s,;]+/).filter(Boolean),
          articlePrefixes: prefixes
            .split(/[\n,;]+/)
            .map((v) => v.trim())
            .filter(Boolean),
          includeSubdomains: subdomains,
          version: site.settings.version,
        }),
      });
      await onChange(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog ref={dialog} className="stats-dialog" onCancel={onClose}>
      <div className="stats-dialog-heading">
        <div>
          <span className="eyebrow">ПОДКЛЮЧЕНИЕ СТАТИСТИКИ</span>
          <h2>{site.name}</h2>
          <p>{site.host}</p>
        </div>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Закрыть настройки"
        >
          <X size={21} />
        </button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {oauthConfigured && !tokenOpen && (
        <div className="stats-token-status">
          <span>Доступ к Метрике подключён</span>
          <button className="text-button" onClick={() => setTokenOpen(true)}>
            Изменить токен
          </button>
        </div>
      )}
      {tokenOpen && (
        <form onSubmit={connect} className="stats-token-form">
          <h3>Доступ к Яндекс Метрике</h3>
          <p>
            Один токен с правом просмотра для всех доступных вам счётчиков.{" "}
            <a
              href="https://yandex.ru/dev/metrika/ru/intro/authorization"
              target="_blank"
              rel="noopener noreferrer"
            >
              Как получить токен
            </a>
          </p>
          <label>
            Токен Метрики
            <input
              type="password"
              autoComplete="new-password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              placeholder="Вставьте токен"
            />
            <small>
              Токен сохраняется на сервере. Пароль Яндекса вводить не нужно.
            </small>
          </label>
          <button className="button secondary" disabled={busy || !token.trim()}>
            Подключить доступ
          </button>
        </form>
      )}
      <form onSubmit={save} className="stats-connection-form">
        <h3>Счётчики и материалы сайта</h3>
        <label>
          Номера счётчиков
          <input
            value={ids}
            onChange={(e) => setIds(e.target.value)}
            placeholder="Например, 114341229"
            required
            disabled={!oauthConfigured}
          />
          <small>
            Через запятую. Для поддоменов можно указать несколько счётчиков. Два
            счётчика на одной странице могут дублировать данные.
          </small>
        </label>
        {counters.length > 0 && (
          <details className="stats-counter-list">
            <summary>Доступные счётчики · {counters.length}</summary>
            <ul>
              {counters.map((c) => (
                <li key={c.id}>
                  <span>
                    {c.name}
                    <small>{c.site}</small>
                  </span>
                  <code>{c.id}</code>
                </li>
              ))}
            </ul>
          </details>
        )}
        <label className="stats-checkbox">
          <input
            type="checkbox"
            checked={subdomains}
            onChange={(e) => setSubdomains(e.target.checked)}
            disabled={!oauthConfigured}
          />
          Учитывать все поддомены этого сайта
        </label>
        <label>
          Разделы статей
          <textarea
            rows={3}
            value={prefixes}
            onChange={(e) => setPrefixes(e.target.value)}
            placeholder={"/blog/\n/articles/"}
            disabled={!oauthConfigured}
          />
          <small>
            По одному пути на строку. Считаются страницы вида
            /blog/название-статьи/. Пустое поле оставляет статистику статей без
            подключения.
          </small>
        </label>
        <div className="stats-dialog-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Закрыть
          </button>
          <button
            className="button primary"
            disabled={busy || !oauthConfigured}
          >
            {busy ? "Проверяем…" : "Сохранить подключение"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export default function Statistics({ active }: { active: boolean }) {
  const [sites, setSites] = useState<Site[]>([]),
    [selected, setSelected] = useState(""),
    [period, setPeriod] = useState<Period>("24h"),
    [oauth, setOauth] = useState(false),
    [canConfigure, setCanConfigure] = useState(false);
  const [report, setReport] = useState<Report | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [sitesLoading, setSitesLoading] = useState(false),
    [settingsOpen, setSettingsOpen] = useState(false),
    [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const loadSites = useCallback(async () => {
    setSitesLoading(true);
    try {
      const data = await api<{
        sites: Site[];
        oauthConfigured: boolean;
        canConfigure: boolean;
      }>("/statistics/sites");
      setSites(data.sites);
      setOauth(data.oauthConfigured);
      setCanConfigure(data.canConfigure);
      setSelected((value) =>
        data.sites.some((s) => s.id === value)
          ? value
          : data.sites[0]?.id || "",
      );
      setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSitesLoading(false);
    }
  }, []);
  useEffect(() => {
    if (active) void loadSites();
  }, [active, loadSites]);
  useEffect(() => {
    if (!active || !selected) return;
    let controller: AbortController | null = null;
    let disposed = false;
    async function load() {
      if (disposed) return;
      controller?.abort();
      controller = new AbortController();
      const own = ++sequence.current;
      setLoading(true);
      try {
        const result = await api<Report>(
          `/statistics/report?site=${encodeURIComponent(selected)}&period=${period}`,
          { signal: controller.signal },
        );
        if (!disposed && sequence.current === own) {
          setReport(result);
          setError("");
        }
      } catch (e) {
        if (
          !disposed &&
          sequence.current === own &&
          !(e instanceof DOMException && e.name === "AbortError")
        )
          setError(errorText(e));
      } finally {
        if (!disposed && sequence.current === own) setLoading(false);
      }
    }
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 30000);
    const visible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [active, selected, period, revision]);
  const site = sites.find((s) => s.id === selected),
    visible =
      report?.site.id === selected && report.period.key === period
        ? report
        : null;
  const hourly = period === "24h",
    connected =
      visible?.totals.views !== null && visible?.totals.views !== undefined;
  const metricCards = [
    {
      key: "visits" as const,
      label: "Визиты",
      icon: MousePointer2,
      tone: "lime",
      note: hourly ? "За последние 24 часа" : "За выбранный период",
    },
    {
      key: "views" as const,
      label: "Просмотры страниц",
      icon: Eye,
      tone: "white",
      note: "По данным Яндекс Метрики",
    },
    {
      key: "articles" as const,
      label: "Просмотры статей",
      icon: Newspaper,
      tone: "pink",
      note: visible?.articlePrefixes.length
        ? "Материалы в разделах сайта"
        : "Раздел статей не указан",
    },
    {
      key: "leads" as const,
      label: "Заявки с сайта",
      icon: Inbox,
      tone: "white",
      note: "Получены в Boykov Services",
    },
  ];
  const shownSources = visible?.sources.slice(0, 6) || [],
    otherSources = connected
      ? Math.max(
          0,
          (visible?.totals.visits || 0) -
            shownSources.reduce((n, s) => n + s.visits, 0),
        )
      : 0;
  return (
    <>
      <PageHead
        eyebrow="МАРКЕТИНГ И РЕЗУЛЬТАТЫ"
        title="Статистика сайтов"
        description="Посещаемость, популярные материалы и обращения клиентов."
      >
        <div className="stats-head-actions">
          <span className="stats-auto">
            <RefreshCw size={14} />
            Автообновление · 30 с
          </span>
          <button
            className="button secondary"
            onClick={() => {
              void loadSites();
              setRevision((r) => r + 1);
            }}
            disabled={loading || !site}
          >
            <RefreshCw size={16} className={loading ? "spin" : ""} />
            Обновить
          </button>
        </div>
      </PageHead>
      {error && <Notice tone="error">{error}</Notice>}
      {!sitesLoading && !sites.length ? (
        <Empty
          title="Добавьте первый сайт"
          text="Сайты для статистики появятся после добавления источников в разделе «Заявки»."
        />
      ) : (
        <>
          <section className="stats-scope" aria-label="Сайт и период отчёта">
            <div className="stats-site-picker">
              <span className="square-icon pink">
                <Globe2 size={22} />
              </span>
              <label>
                <span>Сайт</span>
                <span className="stats-select-wrap">
                  <select
                    value={selected}
                    onChange={(e) => setSelected(e.target.value)}
                    disabled={sitesLoading}
                    aria-label="Сайт для статистики"
                  >
                    {sites.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {s.host}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={16} />
                </span>
              </label>
            </div>
            <div className="stats-periods" aria-label="Период статистики">
              {periods.map((p) => (
                <button
                  key={p.key}
                  aria-pressed={period === p.key}
                  className={period === p.key ? "selected" : ""}
                  onClick={() => setPeriod(p.key)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {canConfigure && (
              <button
                className="stats-settings-button"
                onClick={() => setSettingsOpen(true)}
                disabled={!site}
                aria-label="Настроить статистику сайта"
              >
                <Settings2 size={19} />
              </button>
            )}
          </section>
          <div className="stats-report-meta">
            <div>
              <span className="stats-provider">Яндекс Метрика</span>
              {site?.settings.includeSubdomains && (
                <span>Включая поддомены</span>
              )}
              <span>
                {visible
                  ? `${labelDate(visible.period.from, hourly)} — ${labelDate(visible.period.to, hourly)}`
                  : "Загружаем период…"}{" "}
                · Москва
              </span>
            </div>
            <span>
              {visible?.fetchedAt
                ? `Обновлено ${dateTime(visible.fetchedAt)}`
                : site?.connected
                  ? "Получаем отчёт"
                  : "Ожидает подключения"}
            </span>
          </div>
          {visible?.status === "unconfigured" && (
            <div className="stats-connect-banner">
              <div>
                <b>Подключите статистику {site?.host}</b>
                <p>
                  Посещаемость появится после подключения Метрики. Обращения уже
                  считаются по данным сервиса.
                </p>
              </div>
              {canConfigure ? (
                <button
                  className="button primary"
                  onClick={() => setSettingsOpen(true)}
                >
                  Подключить Метрику
                </button>
              ) : (
                <span>Подключение выполняет администратор</span>
              )}
            </div>
          )}
          {(visible?.status === "error" || visible?.status === "stale") && (
            <Notice tone="warning">
              {visible.error}{" "}
              {visible.status === "stale"
                ? "Показан последний сохранённый отчёт за указанный интервал."
                : "Показатели посещаемости временно недоступны."}
            </Notice>
          )}
          <section className="stats-kpis" aria-label="Основные показатели">
            {metricCards.map((card) => (
              <article key={card.key} className={`stats-kpi ${card.tone}`}>
                <div>
                  <span>{card.label}</span>
                  <card.icon size={18} strokeWidth={1.6} />
                </div>
                <strong>{metric(visible?.totals[card.key])}</strong>
                <p>{card.note}</p>
                <span className="stats-kpi-mark" aria-hidden="true">
                  +
                </span>
              </article>
            ))}
          </section>
          <div className="stats-main-grid">
            <section className="panel stats-traffic">
              <div className="stats-section-heading">
                <h2>Динамика трафика</h2>
                <span>{hourly ? "ПО ЧАСАМ" : "ПО ДНЯМ"}</span>
              </div>
              <div className="stats-chart-legend">
                <span>Просмотры</span>
                <span>Визиты</span>
              </div>
              <TrafficChart points={visible?.daily || []} hourly={hourly} />
              <details className="stats-daily">
                <summary>Данные по {hourly ? "часам" : "дням"}</summary>
                <div
                  className="table-scroll"
                  tabIndex={0}
                  role="region"
                  aria-label={hourly ? "Таблица по часам" : "Таблица по дням"}
                >
                  <table>
                    <thead>
                      <tr>
                        <th>{hourly ? "Час · МСК" : "Дата"}</th>
                        <th>Визиты</th>
                        <th>Просмотры</th>
                        <th>Статьи</th>
                        <th>Заявки</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible?.daily
                        .slice()
                        .reverse()
                        .map((d) => (
                          <tr key={d.at}>
                            <th scope="row">{labelDate(d.at, hourly)}</th>
                            <td>{metric(d.visits)}</td>
                            <td>{metric(d.views)}</td>
                            <td>{metric(d.articles)}</td>
                            <td>{number(d.leads)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </section>
            <section className="panel stats-sources">
              <div className="stats-section-heading">
                <h2>Источники визитов</h2>
                <span>ПЕРЕХОДЫ</span>
              </div>
              {shownSources.length ? (
                <ul>
                  {[
                    ...shownSources,
                    ...(otherSources
                      ? [{ name: "Другие источники", visits: otherSources }]
                      : []),
                  ].map((s) => (
                    <li key={s.name}>
                      <div>
                        <span>{s.name}</span>
                        <strong>{number(s.visits)}</strong>
                      </div>
                      <svg
                        viewBox="0 0 100 3"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        <rect
                          width={100}
                          height={3}
                          className="stats-meter-track"
                        />
                        <rect
                          width={Math.min(
                            100,
                            (s.visits /
                              Math.max(1, visible?.totals.visits || 0)) *
                              100,
                          )}
                          height={3}
                          className="stats-meter-fill"
                        />
                      </svg>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="stats-list-empty">
                  <Globe2 size={25} strokeWidth={1.3} />
                  <p>
                    {connected
                      ? "За этот период переходов пока нет."
                      : "Источники появятся вместе с данными посещаемости."}
                  </p>
                </div>
              )}
            </section>
          </div>
          <div className="stats-bottom-grid">
            {[
              {
                title: "Популярные страницы",
                rows: visible?.pages || [],
                articles: false,
              },
              {
                title: "Статьи",
                rows: visible?.articles || [],
                articles: true,
              },
            ].map((section) => (
              <section className="panel stats-pages" key={section.title}>
                <div className="stats-section-heading">
                  <h2>{section.title}</h2>
                  <span>
                    {section.articles ? "МАТЕРИАЛЫ" : "ИНТЕРЕС АУДИТОРИИ"}
                  </span>
                </div>
                {section.rows.length ? (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>
                            {section.articles ? "Статья" : "Адрес страницы"}
                          </th>
                          <th>Просмотры</th>
                        </tr>
                      </thead>
                      <tbody>
                        {section.rows.slice(0, 8).map((row) => (
                          <tr key={row.url}>
                            <th scope="row">
                              <a
                                href={row.url}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {section.articles ? row.title : row.path}
                              </a>
                            </th>
                            <td>{number(row.views)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="stats-table-empty">
                    {section.articles && !visible?.articlePrefixes.length
                      ? "Укажите разделы статей в настройках этого сайта, чтобы видеть просмотры материалов."
                      : connected
                        ? "За выбранный период просмотров пока нет."
                        : "Данные появятся после подключения Метрики."}
                  </p>
                )}
              </section>
            ))}
          </div>
          <footer className="stats-footnote">
            <CircleHelp size={18} />
            <div>
              <p>
                Проверка обновлений — каждые 30 секунд. Полный отчёт обновляется{" "}
                {hourly ? "раз в две минуты" : "раз в десять минут"}. Все
                показатели относятся к указанному интервалу. Метрика может
                передавать новые данные с задержкой.
              </p>
              <p>
                Заявки учитываются вместе с корзиной. История обращений до
                подключения сайта может быть неполной. Просмотры статей
                считаются по указанным разделам.
              </p>
              {visible?.sampled && (
                <p>
                  Метрика использовала выборку: показатели посещаемости
                  оценочные.
                </p>
              )}
              {visible?.truncated && (
                <p>
                  Таблицы ограничены наиболее популярными адресами; суммарные
                  показатели рассчитаны за весь период.
                </p>
              )}
            </div>
          </footer>
        </>
      )}
      {settingsOpen && site && canConfigure && (
        <ConnectionDialog
          site={site}
          oauthConfigured={oauth}
          onClose={() => setSettingsOpen(false)}
          onChange={async (close) => {
            await loadSites();
            setRevision((r) => r + 1);
            if (close) setSettingsOpen(false);
          }}
        />
      )}
    </>
  );
}
