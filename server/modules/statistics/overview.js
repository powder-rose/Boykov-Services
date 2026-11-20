import { reportPeriod } from "../../../shared/statistics.js";
const HOUR = 3600000,
  DAY = 86400000,
  OFFSET = 3 * HOUR;
const palette = [
  "#728541",
  "#b06a89",
  "#5d7f9c",
  "#ad8241",
  "#8673a6",
  "#4f8981",
  "#aa6860",
  "#738098",
  "#9b7455",
  "#7d8d68",
  "#a166a0",
  "#4e8799",
];
export function statisticsColor(index) {
  return (
    palette[index] || `hsl(${((index * 137.508) % 360).toFixed(3)} 43% 43%)`
  );
}
// Counters belong to native source intervals. Align calendar buckets, never interpolate or invent zeroes.
export function buildStatisticsOverview(sites, reports, key, now) {
  const requested = reportPeriod(key, now),
    step = requested.group === "hour" ? HOUR : DAY;
  const bucketKey = (time) =>
    Math.floor((time + OFFSET) / step) * step - OFFSET;
  const canonical = new Set(),
    bounds = [];
  const rows = sites.map((site, i) => {
    const report = reports[i];
    const usable = report && ["ready", "unconfigured"].includes(report.status);
    const daily = usable ? report.daily : [];
    if (daily.length) bounds.push(report.period);
    const points = daily.map((p) => {
      const at = bucketKey(Date.parse(p.at)),
        end = Date.parse(p.end);
      if (!Number.isFinite(at) || !Number.isFinite(end))
        throw Error("INVALID_STATISTICS_TIME");
      canonical.add(at);
      return {
        at: new Date(at).toISOString(),
        end: new Date(at + step).toISOString(),
        from: p.at,
        to: p.end,
        partial: Date.parse(p.at) !== at || end !== at + step,
        visits: p.visits,
        views: p.views,
        articles: p.articles,
        leads: p.leads,
      };
    });
    return {
      id: site.id,
      name: site.name,
      host: site.host,
      color: site.color,
      status: report?.status || "error",
      error: report?.error || null,
      source: site.source,
      lastSyncedAt: report?.fetchedAt || null,
      leadsOrigin: report?.leadsOrigin || "hub",
      sourcePeriod: usable ? report.period : null,
      totals: usable
        ? report.totals
        : { visits: null, views: null, articles: null, leads: null },
      points,
    };
  });
  // With no usable source, show an empty axis for the chosen period rather than an old snapshot.
  if (!canonical.size) for (const b of requested.buckets) canonical.add(b.key);
  const keys = [...canonical].sort((a, b) => a - b),
    timeline = [];
  for (let time = keys[0]; time <= keys.at(-1); time += step)
    timeline.push({
      at: new Date(time).toISOString(),
      end: new Date(time + step).toISOString(),
    });
  return {
    checkedAt: new Date(now).toISOString(),
    period: {
      key,
      group: requested.group,
      from: bounds.length
        ? new Date(
            Math.min(...bounds.map((p) => Date.parse(p.from))),
          ).toISOString()
        : requested.from,
      to: bounds.length
        ? new Date(
            Math.max(...bounds.map((p) => Date.parse(p.to))),
          ).toISOString()
        : requested.to,
    },
    intervalsDiffer: new Set(bounds.map((p) => p.from + "|" + p.to)).size > 1,
    timeline,
    sites: rows,
  };
}
