import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  CircleHelp,
  ChevronDown,
  Eye,
  Globe2,
  Inbox,
  MousePointer2,
  Newspaper,
  RefreshCw,
} from "lucide-react";
import { api, dateTime, errorText, number } from "../../api";
import { Empty, Loading, Notice } from "../../components/Common";
import { lineSegments, metrics, seriesPoints, totalMetric } from "./model";
import type { Metric, Overview, OverviewSite, Period } from "./model";
import "./statistics-overview.css";
const periods: { key: Period; label: string }[] = [
  { key: "24h", label: "24 часа" },
  { key: "7", label: "7 дней" },
  { key: "30", label: "30 дней" },
  { key: "90", label: "90 дней" },
];
const icons = {
  visits: MousePointer2,
  views: Eye,
  articles: Newspaper,
  leads: Inbox,
};
const amount = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : number(v);
const dateLabel = (at: string, hourly = false) =>
  new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    ...(hourly ? { hour: "2-digit", minute: "2-digit" } : {}),
    timeZone: "Europe/Moscow",
  }).format(new Date(at));
const timeLabel = (at: string, hourly: boolean) =>
  new Intl.DateTimeFormat(
    "ru-RU",
    hourly
      ? { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }
      : { day: "2-digit", month: "2-digit", timeZone: "Europe/Moscow" },
  ).format(new Date(at));
function ColorDot({ color }: { color: string }) {
  return (
    <svg
      className="so-color-dot"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="5" fill={color} />
    </svg>
  );
}
const statusText = (site: OverviewSite) =>
  site.status === "ready"
    ? "Данные актуальны"
    : site.status === "unconfigured"
      ? "Только заявки"
      : site.status === "stale"
        ? "Отчёт устарел"
        : "Ошибка отчёта";
function ComparisonChart({
  data,
  sites,
  metric,
  cumulative,
}: {
  data: Overview;
  sites: OverviewSite[];
  metric: Metric;
  cumulative: boolean;
}) {
  const [chosen, setChosen] = useState<string | null>(null),
    [highlight, setHighlight] = useState<string | null>(null);
  const hourly = data.period.group === "hour",
    timeline = data.timeline;
  const series = useMemo(
    () =>
      sites.map((site) => ({
        site,
        points: seriesPoints(site, timeline, metric, cumulative),
      })),
    [sites, timeline, metric, cumulative],
  );
  const available = series.filter((s) =>
    s.points.some((p) => p.value !== null),
  );
  const found =
    chosen === null ? -1 : timeline.findIndex((p) => p.at === chosen);
  const index = found < 0 ? timeline.length - 1 : found;
  const max = Math.max(
    1,
    ...available.flatMap((s) => s.points.map((p) => p.value ?? 0)),
  );
  const step = 10 ** Math.floor(Math.log10(max)),
    ceiling = Math.max(2, Math.ceil((Math.ceil(max / step) * step) / 2) * 2);
  const width = 1000,
    height = 300,
    left = 60,
    right = 24,
    top = 20,
    bottom = 36;
  const x = (i: number) =>
      left + ((width - left - right) * i) / Math.max(1, timeline.length - 1),
    y = (v: number) => top + (height - top - bottom) * (1 - v / ceiling);
  const metricName = metrics.find((m) => m.key === metric)!;
  if (!sites.length)
    return (
      <div className="so-chart-empty">
        <Globe2 size={34} strokeWidth={1.2} />
        <h3>Выберите сайты для сравнения</h3>
        <p>Нажмите на теги выше или выберите «Показать все».</p>
      </div>
    );
  if (!available.length)
    return (
      <div className="so-chart-empty">
        <BarChart3 size={36} strokeWidth={1.2} />
        <h3>Для этого показателя пока нет данных</h3>
        <p>Выберите другой показатель или подключите статистику сайтов.</p>
      </div>
    );
  return (
    <>
      <div className="so-chart-date">
        <span>{dateLabel(timeline[index].at, hourly)} · МСК</span>
        <span>
          {cumulative
            ? "Сумма с начала отчёта каждого сайта"
            : hourly
              ? "За выбранный час"
              : "За выбранный день"}
        </span>
      </div>
      <svg
        className="so-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        tabIndex={0}
        aria-label={`${metricName.label} по сайтам. Стрелки выбирают дату, Home и End — начало и конец графика.`}
        onKeyDown={(e) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
            e.preventDefault();
            const next =
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? timeline.length - 1
                  : Math.min(
                      timeline.length - 1,
                      Math.max(0, index + (e.key === "ArrowLeft" ? -1 : 1)),
                    );
            setChosen(timeline[next].at);
          }
        }}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect(),
            position = ((e.clientX - rect.left) / rect.width) * width;
          const i = Math.max(
            0,
            Math.min(
              timeline.length - 1,
              Math.round(
                ((position - left) / (width - left - right)) *
                  (timeline.length - 1),
              ),
            ),
          );
          setChosen(timeline[i].at);
        }}
        onPointerLeave={() => setChosen(null)}
      >
        <title>
          {metricName.label}:{" "}
          {cumulative ? "накопительно" : hourly ? "по часам" : "по дням"},
          отдельная линия для каждого сайта
        </title>
        {[0, 0.5, 1].map((r) => (
          <g key={r}>
            <line
              x1={left}
              x2={width - right}
              y1={y(ceiling * r)}
              y2={y(ceiling * r)}
              className="so-gridline"
            />
            <text
              x={left - 12}
              y={y(ceiling * r) + 5}
              textAnchor="end"
              className="so-axis"
            >
              {new Intl.NumberFormat("ru-RU", {
                notation: ceiling >= 100000 ? "compact" : "standard",
                maximumFractionDigits: 1,
              }).format(ceiling * r)}
            </text>
          </g>
        ))}
        {available.map((s) => (
          <g
            key={s.site.id}
            className={
              highlight && highlight !== s.site.id ? "so-line-muted" : ""
            }
          >
            {lineSegments(s.points).map((segment, i) =>
              segment.length === 1 ? (
                <circle
                  key={i}
                  cx={x(segment[0].index)}
                  cy={y(segment[0].value!)}
                  r="3"
                  fill={s.site.color}
                />
              ) : (
                <polyline
                  key={i}
                  className="so-line"
                  stroke={s.site.color}
                  points={segment
                    .map((p) => `${x(p.index)},${y(p.value!)}`)
                    .join(" ")}
                />
              ),
            )}
          </g>
        ))}
        <line
          className="so-chart-cursor"
          x1={x(index)}
          x2={x(index)}
          y1={top}
          y2={y(0)}
        />
        {available.map((s) => {
          const p = s.points[index];
          return p?.value !== null && p?.value !== undefined ? (
            <circle
              key={s.site.id}
              cx={x(index)}
              cy={y(p.value)}
              r="4"
              fill={s.site.color}
              stroke="#fff"
              strokeWidth="2"
            />
          ) : null;
        })}
        {[
          ...new Set([
            0,
            Math.floor((timeline.length - 1) / 3),
            Math.floor((2 * (timeline.length - 1)) / 3),
            timeline.length - 1,
          ]),
        ].map((i) => (
          <text
            key={i}
            x={x(i)}
            y={height - 6}
            textAnchor={
              i === 0 ? "start" : i === timeline.length - 1 ? "end" : "middle"
            }
            className="so-axis"
          >
            {timeLabel(timeline[i].at, hourly)}
          </text>
        ))}
      </svg>
      <div
        className="so-chart-readout"
        aria-label="Значения выбранного интервала"
      >
        {series.map((s) => {
          const p = s.points[index];
          return (
            <div
              key={s.site.id}
              onPointerEnter={() => setHighlight(s.site.id)}
              onPointerLeave={() => setHighlight(null)}
            >
              <ColorDot color={s.site.color} />
              <span className="so-readout-name" title={s.site.name}>
                {s.site.name}
                <small>
                  {p?.point && p.value !== null
                    ? `${dateLabel(p.point.from, hourly || p.point.partial)} — ${dateLabel(p.point.to, hourly || p.point.partial)}${p.point.partial ? " · неполный интервал" : ""}`
                    : "Нет данных за этот интервал"}
                </small>
              </span>
              <strong>{amount(p?.value)}</strong>
            </div>
          );
        })}
      </div>
    </>
  );
}
export default function StatisticsOverview({
  active,
  revision,
  onOpenSite,
}: {
  active: boolean;
  revision: number;
  onOpenSite: (id: string, period: Period) => void;
}) {
  const [period, setPeriod] = useState<Period>("7"),
    [data, setData] = useState<Overview | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set()),
    [metric, setMetric] = useState<Metric>("visits"),
    [cumulative, setCumulative] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    if (!active) return;
    let disposed = false,
      controller: AbortController | null = null;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      const own = ++generation.current;
      setLoading(true);
      try {
        const result = await api<Overview>(
          "/statistics/overview?period=" + period,
          { signal: controller.signal },
        );
        if (!disposed && own === generation.current) {
          setData(result);
          setError("");
        }
      } catch (e) {
        if (
          !disposed &&
          own === generation.current &&
          !(e instanceof DOMException && e.name === "AbortError")
        )
          setError(errorText(e));
      } finally {
        if (!disposed && own === generation.current) setLoading(false);
      }
    };
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
      generation.current++;
      controller?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [active, period, revision]);
  const visible = data?.period.key === period ? data : null;
  const selected = useMemo(
    () => visible?.sites.filter((s) => !hidden.has(s.id)) || [],
    [visible, hidden],
  );
  const toggle = (id: string) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const unavailable = selected.filter((s) => s.totals.visits === null),
    stale = selected.filter(
      (s) => s.status === "stale" || s.status === "error",
    );
  const sorted = [...selected].sort(
    (a, b) =>
      (b.totals[metric] ?? -1) - (a.totals[metric] ?? -1) ||
      a.name.localeCompare(b.name, "ru"),
  );
  return (
    <div className="so-overview">
      <section className="so-scope" aria-label="Период общей статистики">
        <div>
          <span className="square-icon pink">
            <Globe2 size={22} />
          </span>
          <div>
            <strong>Общий обзор</strong>
            <p>Сравнивайте сайты на одном графике</p>
          </div>
        </div>
        <div className="stats-periods" aria-label="Период общего обзора">
          {periods.map((p) => (
            <button
              type="button"
              key={p.key}
              className={period === p.key ? "selected" : ""}
              aria-pressed={period === p.key}
              onClick={() => setPeriod(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </section>
      {error && (
        <Notice tone="error">
          {error}
          {visible ? " Показан последний полученный обзор." : ""}
        </Notice>
      )}
      {!visible ? (
        <Loading />
      ) : !visible.sites.length ? (
        <Empty
          title="Добавьте первый сайт"
          text="Сайты появятся после добавления источников в разделе «Заявки»."
        />
      ) : (
        <>
          <div className="stats-report-meta so-meta">
            <span>
              {dateLabel(visible.period.from, period === "24h")} —{" "}
              {dateLabel(visible.period.to, period === "24h")} · Москва
            </span>
            <span>
              <RefreshCw size={13} className={loading ? "spin" : ""} />
              Проверено {dateTime(visible.checkedAt)}
            </span>
          </div>
          <section
            className="stats-kpis so-metrics"
            aria-label="Показатели выбранных сайтов"
          >
            {metrics.map((m) => {
              const total = totalMetric(selected, m.key),
                Icon = icons[m.key];
              return (
                <button
                  type="button"
                  key={m.key}
                  className={`stats-kpi ${m.tone} ${metric === m.key ? "so-metric-selected" : ""}`}
                  aria-pressed={metric === m.key}
                  onClick={() => setMetric(m.key)}
                >
                  <div>
                    <span>{m.label}</span>
                    <Icon size={18} strokeWidth={1.6} />
                  </div>
                  <strong>{amount(total.value)}</strong>
                  <p>
                    {!total.total
                      ? "Выберите сайты"
                      : `Данные: ${total.available} из ${total.total} сайтов`}
                  </p>
                  <span className="stats-kpi-mark" aria-hidden="true">
                    +
                  </span>
                </button>
              );
            })}
          </section>
          {!!stale.length && (
            <Notice tone="warning">
              Нет свежих данных: {stale.map((s) => s.name).join(", ")}. Эти
              сайты исключены из сумм и линий графика. Последний сохранённый
              отчёт доступен отдельно.
            </Notice>
          )}
          <section
            className="panel so-traffic"
            aria-labelledby="so-traffic-title"
          >
            <div className="so-traffic-heading">
              <div>
                <span className="eyebrow">ДИНАМИКА ВЫБРАННЫХ САЙТОВ</span>
                <h2 id="so-traffic-title">
                  {metrics.find((m) => m.key === metric)!.label}
                </h2>
              </div>
              <div className="so-chart-modes" aria-label="Отображение динамики">
                <button
                  type="button"
                  aria-pressed={!cumulative}
                  onClick={() => setCumulative(false)}
                >
                  {period === "24h" ? "По часам" : "По дням"}
                </button>
                <button
                  type="button"
                  aria-pressed={cumulative}
                  onClick={() => setCumulative(true)}
                >
                  Накопительно
                </button>
              </div>
            </div>
            <section
              className="so-sites"
              aria-label="Выбор сайтов для сравнения"
            >
              <div className="so-sites-heading">
                <div>
                  <strong>Сайты на графике</strong>
                  <span>
                    {selected.length} из {visible.sites.length} выбрано
                  </span>
                </div>
                <div>
                  <button
                    className="text-button"
                    onClick={() => setHidden(new Set())}
                    disabled={selected.length === visible.sites.length}
                  >
                    Показать все
                  </button>
                  <button
                    className="text-button"
                    onClick={() =>
                      setHidden(new Set(visible.sites.map((s) => s.id)))
                    }
                    disabled={!selected.length}
                  >
                    Снять выбор
                  </button>
                </div>
              </div>
              <div className="so-site-tags">
                {visible.sites.map((site) => (
                  <button
                    type="button"
                    key={site.id}
                    className="so-site-tag"
                    aria-pressed={!hidden.has(site.id)}
                    title={`${site.host} · ${statusText(site)}`}
                    onClick={() => toggle(site.id)}
                  >
                    <ColorDot color={site.color} />
                    <span>{site.name}</span>
                    {site.totals[metric] === null && <small>Нет данных</small>}
                  </button>
                ))}
              </div>
              <p>
                Нажмите на тег, чтобы показать или скрыть сайт. Цвет тега
                совпадает с линией графика.
              </p>
            </section>
            <label className="so-metric-picker">
              <span>Показатель графика</span>
              <span className="so-select-wrap">
                <select
                  aria-label="Показатель графика"
                  value={metric}
                  onChange={(e) => setMetric(e.target.value as Metric)}
                >
                  {metrics.map((m) => (
                    <option value={m.key} key={m.key}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <ChevronDown size={16} />
              </span>
            </label>
            <ComparisonChart
              data={visible}
              sites={selected}
              metric={metric}
              cumulative={cumulative}
            />
          </section>
          <div className="so-coverage">
            <CircleHelp size={18} />
            <p>
              {unavailable.length
                ? `Посещаемость доступна для ${selected.length - unavailable.length} из ${selected.length} выбранных сайтов. Прочерк означает отсутствие данных, а не ноль визитов. `
                : "Суммируются визиты выбранных сайтов; это не число уникальных людей между сайтами. "}
              {visible.intervalsDiffer
                ? "Интервалы свежих отчётов могут немного отличаться по времени. "
                : ""}
              Крайние точки могут содержать неполный день или час. Счётчики
              берутся из админок сайтов.
            </p>
          </div>
          <section
            className="panel so-comparison"
            aria-labelledby="so-comparison-title"
          >
            <div className="so-traffic-heading">
              <div>
                <h2 id="so-comparison-title">Сайты в цифрах</h2>
                <p>
                  Выбранные сайты · нажмите на название для подробного отчёта
                </p>
              </div>
              <span>{selected.length} сайтов</span>
            </div>
            {!selected.length ? (
              <p className="so-table-empty">
                Выберите сайты с помощью тегов выше.
              </p>
            ) : (
              <div
                className="table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Сравнение показателей сайтов"
              >
                <table>
                  <thead>
                    <tr>
                      <th>Сайт</th>
                      {metrics.map((m) => (
                        <th key={m.key}>
                          {m.key === "views"
                            ? "Просмотры"
                            : m.key === "articles"
                              ? "Статьи"
                              : m.label}
                        </th>
                      ))}
                      <th>Обновление</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((site) => (
                      <tr key={site.id}>
                        <th scope="row">
                          <div className="so-site-cell">
                            <ColorDot color={site.color} />
                            <div>
                              <button
                                className="so-site-link"
                                onClick={() => onOpenSite(site.id, period)}
                              >
                                {site.name}
                              </button>
                              {site.name !== site.host && (
                                <small>{site.host}</small>
                              )}
                              <span
                                className={`so-status so-status-${site.status}`}
                              >
                                {statusText(site)}
                              </span>
                            </div>
                          </div>
                        </th>
                        {metrics.map((m) => (
                          <td
                            key={m.key}
                            className={
                              metric === m.key ? "so-active-value" : ""
                            }
                          >
                            {amount(site.totals[m.key])}
                          </td>
                        ))}
                        <td className="so-updated">
                          {site.lastSyncedAt
                            ? dateTime(site.lastSyncedAt)
                            : "Ожидает подключения"}
                          {site.leadsOrigin === "hub" && (
                            <small>Заявки из Boykov Services</small>
                          )}
                          {site.sourcePeriod && (
                            <small
                              title={`${dateTime(site.sourcePeriod.from, true)} — ${dateTime(site.sourcePeriod.to, true)} МСК`}
                            >
                              Интервал отчёта источника
                            </small>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <p className="so-footnote">
            Цвет сайта сохраняется для всей команды. Обзор проверяет обновления
            каждые 30 секунд. Накопительный график складывает значения с начала
            доступного отчёта каждого сайта; пробелы в данных не заполняются
            нулями.
          </p>
        </>
      )}
    </div>
  );
}
