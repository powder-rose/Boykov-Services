export type Period = "24h" | "7" | "30" | "90";
export type Metric = "visits" | "views" | "articles" | "leads";
export type Values = Record<Metric, number | null>;
export type Point = Values & {
  at: string;
  end: string;
  from: string;
  to: string;
  partial: boolean;
};
export type OverviewSite = {
  id: string;
  name: string;
  host: string;
  color: string;
  status: "ready" | "unconfigured" | "stale" | "error";
  error: string | null;
  source: { kind: string; label: string } | null;
  lastSyncedAt: string | null;
  leadsOrigin: "native" | "hub" | "unavailable";
  sourcePeriod: {
    key: Period;
    from: string;
    to: string;
    group: "hour" | "day";
  } | null;
  totals: Values;
  points: Point[];
};
export type Overview = {
  checkedAt: string;
  period: { key: Period; from: string; to: string; group: "hour" | "day" };
  intervalsDiffer: boolean;
  timeline: { at: string; end: string }[];
  sites: OverviewSite[];
};
export const metrics: {
  key: Metric;
  label: string;
  short: string;
  tone: string;
}[] = [
  { key: "visits", label: "Визиты", short: "визитов", tone: "lime" },
  {
    key: "views",
    label: "Просмотры страниц",
    short: "просмотров",
    tone: "white",
  },
  {
    key: "articles",
    label: "Просмотры статей",
    short: "просмотров статей",
    tone: "pink",
  },
  { key: "leads", label: "Заявки", short: "заявок", tone: "white" },
];
export function totalMetric(sites: OverviewSite[], metric: Metric) {
  const available = sites.filter((s) => s.totals[metric] !== null);
  return {
    value: available.length
      ? available.reduce((n, s) => n + s.totals[metric]!, 0)
      : null,
    available: available.length,
    total: sites.length,
  };
}
export function seriesPoints(
  site: OverviewSite,
  timeline: Overview["timeline"],
  metric: Metric,
  cumulative: boolean,
) {
  const points = new Map(site.points.map((p) => [p.at, p]));
  let sum = 0;
  return timeline.map(({ at }, index) => {
    const point = points.get(at);
    const value = point?.[metric] ?? null;
    if (value === null) return { index, value: null, point: point || null };
    sum += value;
    return { index, value: cumulative ? sum : value, point: point! };
  });
}
export function lineSegments<T extends { value: number | null }>(points: T[]) {
  const segments: T[][] = [];
  let current: T[] = [];
  for (const point of points) {
    if (point.value === null) {
      if (current.length) segments.push(current);
      current = [];
    } else current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}
