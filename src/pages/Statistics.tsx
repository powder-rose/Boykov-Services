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
import { api, dateTime, errorText, number } from "../api";
import { Empty, Notice, PageHead } from "../components/Common";
import "./Statistics.css";
import StatisticsOverview from "../features/statistics-overview/StatisticsOverview";

type Period = "24h" | "7" | "30" | "90";
type Site = {
  id: string;
  name: string;
  host: string;
  connected: boolean;
  source: { kind: string; label: string } | null;
  lastSyncedAt: string | null;
};
type Point = {
  at: string;
  end: string;
  visits: number | null;
  views: number | null;
  articles: number | null;
  leads: number;
};
type PageRow = {
  path: string;
  url: string;
  title: string;
  views: number;
  host?: string;
};
type Report = {
  site: { id: string; name: string; host: string };
  period: { key: Period; from: string; to: string; group: "hour" | "day" };
  status: "ready" | "unconfigured" | "error" | "stale";
  error: string | null;
  fetchedAt: string | null;
  checkedAt: string;
  coverageFrom?: string;
  provider: string;
  leadsOrigin: "native" | "hub";
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
  const hasViews = points.some((p) => p.views !== null);
  const hasVisits = points.some((p) => p.visits !== null);
  const available = hasViews || hasVisits;
  if (!available)
    return (
      <div className="stats-chart-empty">
        <BarChart3 size={32} strokeWidth={1.3} />
        <p>Здесь появится динамика посещаемости</p>
        <span>После подключения статистики сайта</span>
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
  const known = points
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.views !== null || p.visits !== null);
  const line = (key: "views" | "visits") =>
    known.map(({ p, i }) => `${x(i)},${y(p[key] || 0)}`).join(" ");
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
          {metric(point.views)} <small>просмотров</small>
        </b>
        <b>
          {metric(point.visits)} <small>визитов</small>
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
        {hasViews && (
          <polygon
            className="stats-chart-area"
            points={`${x(known[0].i)},${y(0)} ${line("views")} ${x(known[known.length - 1].i)},${y(0)}`}
          />
        )}
        {hasViews && (
          <polyline className="stats-chart-views" points={line("views")} />
        )}
        {hasVisits && (
          <polyline className="stats-chart-visits" points={line("visits")} />
        )}
        {selected !== null &&
          (point.views !== null || point.visits !== null) && (
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
                cy={y(point.views ?? point.visits ?? 0)}
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
  onClose,
}: {
  site: Site;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog ref={dialog} className="stats-dialog" onCancel={onClose}>
      <div className="stats-dialog-heading">
        <div>
          <span className="eyebrow">СТАТИСТИКА САЙТА</span>
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
      <div className="stats-token-form">
        <h3>{site.source?.label || "Источник ещё не подключён"}</h3>
        <p>
          {site.source?.kind === "wordpress"
            ? "Собственный счётчик учитывает посещения основного сайта и поддоменов. История начинается с установки. Состояние отправки видно в настройках Boykov Services в WordPress."
            : site.source
              ? "Сервис получает готовые отчёты из существующей системы статистики сайта. История остаётся на сайте и доступна в его админке."
              : "Для этого сайта пока нет подключённой выгрузки статистики. Недоступные показатели отмечены прочерком."}
        </p>
        <p>
          {site.lastSyncedAt
            ? `Последний отчёт: ${dateTime(site.lastSyncedAt)} · Москва`
            : "Ожидаем первый отчёт сайта."}
        </p>
      </div>
      {site.source && (
        <p>
          Инструкции установки синхронизации находятся в архиве обновления.
          Используется существующее защищённое подключение сайта к разделу
          «Заявки».
        </p>
      )}
      <div className="stats-dialog-actions">
        <button className="button primary" onClick={onClose}>
          Понятно
        </button>
      </div>
    </dialog>
  );
}

function SiteStatistics({
  active,
  revision,
  requested,
}: {
  active: boolean;
  revision: number;
  requested: { id: string; period: Period } | null;
}) {
  const [sites, setSites] = useState<Site[]>([]),
    [selected, setSelected] = useState(""),
    [period, setPeriod] = useState<Period>("24h"),
    [canConfigure, setCanConfigure] = useState(false);
  const [report, setReport] = useState<Report | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [sitesLoading, setSitesLoading] = useState(false),
    [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    if (requested) {
      setSelected(requested.id);
      setPeriod(requested.period);
    }
  }, [requested]);
  const sequence = useRef(0);
  const loadSites = useCallback(async () => {
    setSitesLoading(true);
    try {
      const data = await api<{
        sites: Site[];
        canConfigure: boolean;
      }>("/statistics/sites");
      setSites(data.sites);
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
  }, [active, loadSites, revision]);
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
          setSites((current) =>
            current.map((s) =>
              s.id === result.site.id
                ? {
                    ...s,
                    connected: result.status !== "unconfigured",
                    lastSyncedAt: result.fetchedAt,
                  }
                : s,
            ),
          );
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
      visible?.totals.visits !== null && visible?.totals.visits !== undefined;
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
      note:
        visible?.totals.views === null
          ? "Источник не ведёт этот показатель"
          : "По данным админки сайта",
    },
    {
      key: "articles" as const,
      label: "Просмотры статей",
      icon: Newspaper,
      tone: "pink",
      note:
        visible?.totals.articles === null
          ? "Источник не ведёт этот показатель"
          : "По сохранённым просмотрам материалов",
    },
    {
      key: "leads" as const,
      label: "Заявки с сайта",
      icon: Inbox,
      tone: "white",
      note:
        visible?.leadsOrigin === "native"
          ? "По данным админки сайта"
          : "Получены в Boykov Services",
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
          <div className="stats-report-meta" aria-busy={loading}>
            <div>
              <span className="stats-provider">
                {visible?.provider || site?.source?.label || "Статистика сайта"}
              </span>
              {visible?.coverageFrom && (
                <span>
                  Учёт посещений с {dateTime(visible.coverageFrom, true)}
                </span>
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
                  Посещаемость появится после первого отчёта из админки сайта.
                  Пока отображаются заявки, поступившие в Boykov Services.
                </p>
              </div>
              {canConfigure ? (
                <button
                  className="button primary"
                  onClick={() => setSettingsOpen(true)}
                >
                  Как подключить
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
                                {section.articles
                                  ? row.title
                                  : (row.host && row.host !== visible?.site.host
                                      ? row.host
                                      : "") + row.path}
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
                    {section.articles && visible?.totals.articles === null
                      ? "В источнике пока нет отдельного учёта просмотров статей."
                      : !section.articles && visible?.totals.views === null
                        ? "Источник не ведёт отдельный учёт просмотров страниц."
                        : connected
                          ? "За выбранный период просмотров пока нет."
                          : "Данные появятся после подключения статистики сайта."}
                  </p>
                )}
              </section>
            ))}
          </div>
          <footer className="stats-footnote">
            <CircleHelp size={18} />
            <div>
              <p>
                Проверка обновлений — каждые 30 секунд. Сайты передают отчёты
                раз в минуту. Все показатели относятся к указанному интервалу по
                московскому времени.
              </p>
              <p>
                {visible?.leadsOrigin === "native"
                  ? "Заявки и посещаемость берутся из админки сайта с её правилами подсчёта. История ограничена сохранёнными на сайте данными."
                  : "До подключения статистики учитываются только заявки центрального сервиса, включая корзину."}{" "}
                Прочерк означает, что источник не передаёт показатель.
              </p>
            </div>
          </footer>
        </>
      )}
      {settingsOpen && site && canConfigure && (
        <ConnectionDialog site={site} onClose={() => setSettingsOpen(false)} />
      )}
    </>
  );
}

export default function Statistics({ active }: { active: boolean }) {
  const [view, setView] = useState<"overview" | "site">("overview"),
    [revision, setRevision] = useState(0),
    [requested, setRequested] = useState<{ id: string; period: Period } | null>(
      null,
    );
  const tabs = useRef<HTMLDivElement>(null);
  return (
    <>
      <PageHead
        eyebrow="МАРКЕТИНГ И РЕЗУЛЬТАТЫ"
        title="Статистика сайтов"
        description="Все сайты в одном обзоре. Посещаемость, динамика и обращения клиентов."
      >
        <div className="stats-head-actions">
          <span className="stats-auto">
            <RefreshCw size={14} />
            Автообновление · 30 с
          </span>
          <button
            className="button secondary"
            onClick={() => setRevision((v) => v + 1)}
          >
            <RefreshCw size={16} />
            Обновить
          </button>
        </div>
      </PageHead>
      <div
        className="so-view-tabs"
        role="tablist"
        aria-label="Вид статистики"
        ref={tabs}
        onKeyDown={(e) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
            e.preventDefault();
            const next =
              e.key === "Home"
                ? "overview"
                : e.key === "End"
                  ? "site"
                  : view === "overview"
                    ? "site"
                    : "overview";
            setView(next);
            tabs.current
              ?.querySelector<HTMLButtonElement>(`[id="stats-${next}-tab"]`)
              ?.focus();
          }
        }}
      >
        <button
          type="button"
          role="tab"
          id="stats-overview-tab"
          aria-controls="stats-overview-panel"
          aria-selected={view === "overview"}
          tabIndex={view === "overview" ? 0 : -1}
          onClick={() => setView("overview")}
        >
          <BarChart3 size={17} />
          Все сайты
        </button>
        <button
          type="button"
          role="tab"
          id="stats-site-tab"
          aria-controls="stats-site-panel"
          aria-selected={view === "site"}
          tabIndex={view === "site" ? 0 : -1}
          onClick={() => setView("site")}
        >
          <Globe2 size={17} />
          Отчёт по сайту
        </button>
      </div>
      <div
        role="tabpanel"
        id="stats-overview-panel"
        aria-labelledby="stats-overview-tab"
        hidden={view !== "overview"}
      >
        <StatisticsOverview
          active={active && view === "overview"}
          revision={revision}
          onOpenSite={(id, period) => {
            setRequested({ id, period });
            setView("site");
          }}
        />
      </div>
      <div
        role="tabpanel"
        id="stats-site-panel"
        aria-labelledby="stats-site-tab"
        hidden={view !== "site"}
      >
        <SiteStatistics
          active={active && view === "site"}
          revision={revision}
          requested={requested}
        />
      </div>
    </>
  );
}
