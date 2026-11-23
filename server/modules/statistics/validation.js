import {
  nativeSources,
  statisticsPeriods,
  reportPeriod,
  cleanPath,
} from "../../../shared/statistics.js";
const bad = () =>
  Object.assign(new Error("Проверьте состав отчёта статистики."), {
    status: 400,
  });
const count = (n) => {
  if (!Number.isSafeInteger(n) || n < 0 || n > 1e12) throw bad();
  return n;
};
const text = (v, max) => {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > max ||
    /[\u0000-\u001f]/.test(v)
  )
    throw bad();
  return v.trim();
};
export function validateNativePacket(input, site, now) {
  const generated = Date.parse(input?.generatedAt);
  if (
    !input ||
    input.version !== 1 ||
    input.host !== site.host ||
    nativeSources[site.host]?.kind !== input.source ||
    !Number.isFinite(generated) ||
    input.generatedAt !== new Date(generated).toISOString() ||
    generated % 60000 ||
    generated > now + 120000 ||
    now - generated > 92 * 86400000 ||
    !Array.isArray(input.reports) ||
    input.reports.length !== 4
  )
    throw bad();
  let coverageFrom;
  const docs = input.source === "boykovdocs";
  if (input.source === "wordpress" || docs) {
    const since = Date.parse(input.coverageFrom);
    if (
      !Number.isFinite(since) ||
      input.coverageFrom !== new Date(since).toISOString() ||
      since > now + 120000 ||
      since <= 0 ||
      (docs && since >= generated)
    )
      throw bad();
    coverageFrom = input.coverageFrom;
  }
  let filteredSince;
  if (input.filteredSince !== undefined) {
    const value = Date.parse(input.filteredSince);
    if (
      !docs ||
      !Number.isFinite(value) ||
      new Date(value).toISOString() !== input.filteredSince ||
      value < Date.parse(coverageFrom) ||
      value >= generated
    )
      throw bad();
    filteredSince = input.filteredSince;
  }
  const seen = new Set();
  const reports = input.reports.map((report) => {
    if (
      !report ||
      !statisticsPeriods.includes(report.key) ||
      seen.has(report.key)
    )
      throw bad();
    seen.add(report.key);
    const range = reportPeriod(report.key, generated);
    if (
      report.period?.from !== range.from ||
      report.period?.to !== range.to ||
      report.period?.group !== range.group ||
      !Array.isArray(report.daily) ||
      report.daily.length !== range.buckets.length
    )
      throw bad();
    const totals = Object.fromEntries(
      ["visits", "views", "articles", "leads"].map((k) => [
        k,
        report.totals?.[k] === null && (k !== "leads" || docs)
          ? null
          : count(report.totals?.[k]),
      ]),
    );
    if (totals.visits === null) throw bad();
    if (
      docs &&
      (totals.views === null ||
        totals.visits > totals.views ||
        totals.articles !== null ||
        totals.leads !== null ||
        !Array.isArray(report.sources) ||
        report.sources.length ||
        !Array.isArray(report.pages) ||
        report.pages.length ||
        !Array.isArray(report.articles) ||
        report.articles.length)
    )
      throw bad();
    const daily = report.daily.map((point, i) => {
      if (
        !point ||
        point.at !== new Date(range.buckets[i].from).toISOString() ||
        point.end !== new Date(range.buckets[i].to).toISOString()
      )
        throw bad();
      return {
        at: point.at,
        end: point.end,
        ...Object.fromEntries(
          Object.keys(totals).map((k) => {
            if (totals[k] === null) {
              if (point[k] !== null) throw bad();
              return [k, null];
            }
            return [k, count(point[k])];
          }),
        ),
      };
    });
    if (
      coverageFrom &&
      daily.some(
        (p) =>
          Date.parse(p.end) <= Date.parse(coverageFrom) &&
          ["visits", "views", "articles"].some(
            (k) => p[k] !== null && p[k] !== 0,
          ),
      )
    )
      throw bad();
    for (const key of Object.keys(totals))
      if (
        totals[key] !== null &&
        totals[key] !== daily.reduce((n, p) => n + p[key], 0)
      )
        throw bad();
    if (
      totals.articles !== null &&
      (totals.views === null || totals.articles > totals.views)
    )
      throw bad();
    if (!Array.isArray(report.sources) || report.sources.length > 20)
      throw bad();
    const sources = report.sources.map((s) => {
      if (!s) throw bad();
      return { name: text(s.name, 160), visits: count(s.visits) };
    });
    if (
      new Set(sources.map((s) => s.name)).size !== sources.length ||
      sources.reduce((n, s) => n + s.visits, 0) > totals.visits
    )
      throw bad();
    function pages(rows, metric) {
      if (!Array.isArray(rows) || rows.length > 20) throw bad();
      const result = rows.map((p) => {
        if (!p) throw bad();
        const path = cleanPath(p.path);
        if (!path || path !== p.path) throw bad();
        let host = site.host;
        if (p.host !== undefined) {
          if (
            input.source !== "wordpress" ||
            typeof p.host !== "string" ||
            p.host.length > 253 ||
            !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*energo-365\.ru$/.test(
              p.host,
            )
          )
            throw bad();
          host = p.host;
        }
        return {
          path,
          ...(p.host === undefined ? {} : { host }),
          url: "https://" + host + path,
          title: text(p.title, 500),
          views: count(p.views),
        };
      });
      if (
        new Set(result.map((p) => p.url)).size !== result.length ||
        (totals[metric] === null && result.length) ||
        (totals[metric] !== null &&
          result.reduce((n, p) => n + p.views, 0) > totals[metric])
      )
        throw bad();
      return result;
    }
    return {
      key: report.key,
      ...(coverageFrom ? { coverageFrom } : {}),
      ...(filteredSince ? { filteredSince } : {}),
      period: { from: range.from, to: range.to, group: range.group },
      totals,
      daily,
      sources,
      pages: pages(report.pages, "views"),
      articles: pages(report.articles, "articles"),
    };
  });
  return {
    version: 1,
    ...(coverageFrom ? { coverageFrom } : {}),
    ...(filteredSince ? { filteredSince } : {}),
    host: site.host,
    source: input.source,
    generatedAt: new Date(generated).toISOString(),
    reports,
  };
}
