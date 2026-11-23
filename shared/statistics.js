const DAY = 86400000,
  HOUR = 3600000,
  OFFSET = 3 * HOUR;
export const statisticsPeriods = ["24h", "7", "30", "90"];
export const nativeSources = {
  "energo-365.ru": {
    kind: "wordpress",
    label: "WordPress · Энерго 365 и поддомены",
  },
  "nwdelectricity.ru": { kind: "nwd", label: "Редакция NWD" },
  "pasport-dostupnosty.ru": {
    kind: "accessibility",
    label: "Админка Паспорта доступности",
  },
  "pasport-bezopasnosty.ru": {
    kind: "security",
    label: "Админка Паспорта безопасности",
  },
};
export function reportPeriod(key, now = Date.now()) {
  if (!statisticsPeriods.includes(key))
    throw Object.assign(new Error("Выберите доступный период отчёта."), {
      status: 400,
    });
  const end = Math.floor(now / 60000) * 60000;
  const today = Math.floor((end + OFFSET) / DAY) * DAY - OFFSET;
  const start = key === "24h" ? end - DAY : today - (Number(key) - 1) * DAY;
  const step = key === "24h" ? HOUR : DAY;
  const first = Math.floor((start + OFFSET) / step) * step - OFFSET;
  const buckets = [];
  for (let t = first; t < end; t += step)
    buckets.push({
      key: t,
      from: Math.max(t, start),
      to: Math.min(t + step, end),
    });
  return {
    key,
    start,
    end,
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    group: key === "24h" ? "hour" : "day",
    buckets,
  };
}
export function cleanPath(value) {
  if (
    typeof value !== "string" ||
    value.length > 1800 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u001f]/.test(value)
  )
    return null;
  const url = new URL(value, "https://path.invalid");
  return url.pathname;
}
export function sourceLabel(value) {
  const source = String(value || "unknown").slice(0, 160);
  if (source.startsWith("utm:")) return "UTM · " + source.slice(4);
  if (source.startsWith("ref:"))
    return source.slice(4).split(/[/?#]/)[0] || "Источник не определён";
  return (
    {
      direct: "Прямой заход",
      internal: "Со страниц сайта",
      unknown: "Источник не определён",
    }[source] || source
  );
}
// The adapters feed native records into the same four half-open time windows.
export class NativeReportBuilder {
  constructor({ host, kind, now = Date.now(), views = true, articles = true }) {
    if (nativeSources[host]?.kind !== kind)
      throw new Error("UNKNOWN_NATIVE_SOURCE");
    this.host = host;
    this.kind = kind;
    this.generatedAt = new Date(Math.floor(now / 60000) * 60000).toISOString();
    this.frames = statisticsPeriods.map((key) => {
      const range = reportPeriod(key, now);
      return {
        key,
        range,
        daily: range.buckets.map((b) => ({
          at: new Date(b.from).toISOString(),
          end: new Date(b.to).toISOString(),
          visits: 0,
          views: views ? 0 : null,
          articles: articles ? 0 : null,
          leads: 0,
        })),
        sources: new Map(),
        pages: new Map(),
        articles: new Map(),
      };
    });
  }
  record(metric, time, { path, title, source } = {}) {
    if (!["visits", "views", "leads"].includes(metric))
      throw new Error("UNKNOWN_NATIVE_METRIC");
    if (!Number.isFinite(time)) return;
    const safePath = cleanPath(path);
    for (const frame of this.frames) {
      const r = frame.range;
      if (time < r.start || time >= r.end) continue;
      const step = r.group === "hour" ? HOUR : DAY;
      const slot = Math.floor((time - r.buckets[0].key) / step);
      const point = frame.daily[slot];
      if (point[metric] === null) throw new Error("UNAVAILABLE_NATIVE_METRIC");
      point[metric]++;
      if (metric === "visits") {
        const label = sourceLabel(source);
        frame.sources.set(label, (frame.sources.get(label) || 0) + 1);
      }
      if (metric === "views" && safePath) {
        const row = frame.pages.get(safePath) || {
          path: safePath,
          title: safePath,
          views: 0,
        };
        row.views++;
        frame.pages.set(safePath, row);
        if (title && point.articles !== null) {
          point.articles++;
          const article = frame.articles.get(safePath) || {
            path: safePath,
            title: String(title).slice(0, 500),
            views: 0,
          };
          article.views++;
          frame.articles.set(safePath, article);
        }
      }
    }
  }
  packet() {
    return {
      version: 1,
      host: this.host,
      source: this.kind,
      generatedAt: this.generatedAt,
      reports: this.frames.map((f) => ({
        key: f.key,
        period: { from: f.range.from, to: f.range.to, group: f.range.group },
        totals: Object.fromEntries(
          ["visits", "views", "articles", "leads"].map((k) => [
            k,
            f.daily.length && f.daily[0][k] === null
              ? null
              : f.daily.reduce((n, d) => n + (d[k] || 0), 0),
          ]),
        ),
        daily: f.daily,
        sources: [...f.sources]
          .map(([name, visits]) => ({ name, visits }))
          .sort((a, b) => b.visits - a.visits || a.name.localeCompare(b.name))
          .slice(0, 20),
        pages: [...f.pages.values()]
          .sort((a, b) => b.views - a.views || a.path.localeCompare(b.path))
          .slice(0, 20),
        articles: [...f.articles.values()]
          .sort((a, b) => b.views - a.views || a.path.localeCompare(b.path))
          .slice(0, 20),
      })),
    };
  }
}
