import { moscowText, parseMoscow, hostMatches } from "./period.js";

const ORIGIN = "https://api-metrika.yandex.net";
const failure = (message, status = 503) =>
  Object.assign(new Error(message), { status });
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const count = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw failure("Метрика вернула некорректные значения.");
  return Math.round(value);
};
const sourceLabels = {
  direct: "Прямой заход",
  organic: "Поисковые системы",
  referral: "Переходы с сайтов",
  internal: "Со страниц сайта",
  ad: "Реклама",
  social: "Социальные сети",
  messenger: "Мессенджеры",
  recommend: "Рекомендательные системы",
  saved: "Сохранённые страницы",
};

export class MetrikaClient {
  constructor({ fetcher = fetch, timeout = 12000 } = {}) {
    this.fetcher = fetcher;
    this.timeout = timeout;
    this.active = 0;
    this.waiting = [];
    this.cooldown = 0;
  }
  async request(route, params, token) {
    if (Date.now() < this.cooldown)
      throw failure(
        "Метрика ограничила частоту запросов. Данные обновятся после паузы.",
      );
    if (this.active >= 2)
      await new Promise((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      if (Date.now() < this.cooldown)
        throw failure(
          "Метрика ограничила частоту запросов. Данные обновятся после паузы.",
        );
      const url = new URL(route, ORIGIN);
      for (const [key, value] of Object.entries(params || {}))
        url.searchParams.set(key, String(value));
      let response;
      try {
        response = await this.fetcher(url, {
          headers: { Authorization: "OAuth " + token },
          signal: AbortSignal.timeout(this.timeout),
          redirect: "error",
        });
      } catch {
        throw failure(
          "Не удалось получить данные Метрики. Сохранённый отчёт остаётся доступен.",
        );
      }
      if (response.status === 401 || response.status === 403)
        throw failure(
          "Нет доступа к счётчику. Проверьте токен Метрики и права аккаунта.",
          403,
        );
      if (response.status === 429) {
        this.cooldown = Date.now() + 60000;
        throw failure(
          "Достигнут лимит запросов Метрики. Повторим после паузы.",
        );
      }
      if (!response.ok)
        throw failure(
          response.status === 400
            ? "Метрика отклонила параметры отчёта. Проверьте подключение."
            : "Метрика временно недоступна.",
        );
      const text = await response.text();
      if (Buffer.byteLength(text) > 5000000)
        throw failure("Ответ Метрики слишком большой.");
      try {
        return JSON.parse(text);
      } catch {
        throw failure("Не удалось прочитать ответ Метрики.");
      }
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
  async counters(token) {
    const result = await this.request(
      "/management/v1/counters",
      { per_page: 1000 },
      token,
    );
    if (!Array.isArray(result.counters))
      throw failure("Не удалось прочитать список счётчиков.");
    return result.counters.map((c) => ({
      id: String(c.id),
      name: String(c.name || c.site || c.id),
      site: String(c.site2?.site || c.site || ""),
      status: c.status,
    }));
  }
  async verify(ids, token) {
    for (const id of ids) {
      const data = await this.request(
        "/management/v1/counter/" + id,
        {},
        token,
      );
      if (String(data.counter?.id) !== id || data.counter?.status === "Deleted")
        throw failure("Этот счётчик недоступен.", 400);
    }
  }
  filters(site, settings, range, kind, articles = false) {
    const field = kind === "s" ? "ym:s:startURLDomain" : "ym:pv:URLDomain";
    const domain = site.host.split(".").map(escapeRegex).join("[.]");
    const hostPattern = settings.includeSubdomains
      ? "(^|[.])" + domain + "$"
      : "^(www[.])?" + domain + "$";
    let filter = `${field}=~'${hostPattern}' AND ym:${kind}:dateTime>='${moscowText(range.start)}' AND ym:${kind}:dateTime<'${moscowText(range.end)}'`;
    if (articles) {
      const paths = settings.articlePrefixes.map(escapeRegex).join("|");
      filter += ` AND ym:pv:URLPath=~'^(?:${paths})[^/]+/?$'`;
    }
    return filter;
  }
  async report(site, settings, range, token) {
    const common = {
      ids: settings.counterIds.join(","),
      date1: range.date1,
      date2: range.date2,
      timezone: "+03:00",
      accuracy: "full",
      lang: "ru",
      include_undefined: true,
    };
    const series = (kind, articles = false) =>
      this.request(
        "/stat/v1/data/bytime",
        {
          ...common,
          metrics: kind === "s" ? "ym:s:visits" : "ym:pv:pageviews",
          group: range.group,
          filters: this.filters(site, settings, range, kind, articles),
        },
        token,
      );
    const table = (kind, dimensions, extra = {}, articles = false) =>
      this.request(
        "/stat/v1/data",
        {
          ...common,
          metrics: kind === "s" ? "ym:s:visits" : "ym:pv:pageviews",
          dimensions,
          sort: kind === "s" ? "-ym:s:visits" : "-ym:pv:pageviews",
          filters: this.filters(site, settings, range, kind, articles),
          limit: 1000,
          ...extra,
        },
        token,
      );
    const hasArticles = settings.articlePrefixes.length > 0;
    const data = await Promise.all([
      series("s"),
      series("pv"),
      table(
        "s",
        "ym:s:lastTrafficSource,ym:s:lastSearchEngineRoot,ym:s:lastReferalSource",
      ),
      table("pv", "ym:pv:URLDomain,ym:pv:URLPath"),
      hasArticles ? series("pv", true) : null,
      hasArticles
        ? table("pv", "ym:pv:URLDomain,ym:pv:URLPath,ym:pv:title", {}, true)
        : null,
    ]);
    const toSeries = (response) => {
      if (
        !Array.isArray(response.time_intervals) ||
        !Array.isArray(response.data)
      )
        throw failure("Метрика вернула неполный график.");
      const values = response.data[0]?.metrics?.[0] || [];
      if (
        response.time_intervals.length !== values.length &&
        response.data.length
      )
        throw failure("Метрика вернула неполный график.");
      const result = new Map();
      response.time_intervals.forEach((interval, i) => {
        if (!Array.isArray(interval))
          throw failure("Некорректный интервал графика.");
        result.set(parseMoscow(interval[0]), count(values[i] ?? 0));
      });
      return result;
    };
    const visits = toSeries(data[0]),
      views = toSeries(data[1]),
      articleViews = hasArticles ? toSeries(data[4]) : null;
    const daily = range.buckets.map((b) => ({
      at: new Date(b.from).toISOString(),
      end: new Date(b.to).toISOString(),
      visits: visits.get(b.key) || 0,
      views: views.get(b.key) || 0,
      articles: articleViews ? articleViews.get(b.key) || 0 : null,
    }));
    const totals = {
      visits: daily.reduce((n, r) => n + r.visits, 0),
      views: daily.reduce((n, r) => n + r.views, 0),
      articles: articleViews ? daily.reduce((n, r) => n + r.articles, 0) : null,
    };
    if (
      !Array.isArray(data[2].data) ||
      !Array.isArray(data[3].data) ||
      (hasArticles && !Array.isArray(data[5].data))
    )
      throw failure("Метрика вернула неполные таблицы.");
    const sourceMap = new Map();
    for (const row of data[2].data) {
      const type = row.dimensions?.[0]?.id,
        engine = row.dimensions?.[1]?.name,
        ref = row.dimensions?.[2]?.name;
      let name =
        sourceLabels[type] ||
        row.dimensions?.[0]?.name ||
        "Источник не определён";
      if (type === "organic" && engine && engine !== "Не определено")
        name = engine;
      if (type === "referral" && ref) {
        try {
          name = new URL(ref.includes("://") ? ref : "https://" + ref).hostname;
        } catch {
          name = "Переходы с сайтов";
        }
      }
      sourceMap.set(name, (sourceMap.get(name) || 0) + count(row.metrics?.[0]));
    }
    const sources = [...sourceMap]
      .map(([name, visits]) => ({ name, visits }))
      .sort((a, b) => b.visits - a.visits || a.name.localeCompare(b.name));
    const pages = (response, article = false) => {
      const grouped = new Map();
      for (const row of response.data) {
        const host = String(
            row.dimensions?.[0]?.name || site.host,
          ).toLowerCase(),
          raw = String(row.dimensions?.[1]?.name || "/");
        if (
          !hostMatches(host, site.host, settings.includeSubdomains) ||
          !raw.startsWith("/") ||
          raw.startsWith("//") ||
          /[\u0000-\u001f]/.test(raw)
        )
          continue;
        const url = new URL(raw, "https://" + host);
        if (url.hostname !== host) continue;
        url.search = "";
        url.hash = "";
        const key = url.href,
          old = grouped.get(key);
        const views = count(row.metrics?.[0]);
        if (old) old.views += views;
        else
          grouped.set(key, {
            path: (host === site.host ? "" : host) + url.pathname,
            url: key,
            title: article
              ? String(row.dimensions?.[2]?.name || url.pathname)
              : url.pathname,
            views,
          });
      }
      return [...grouped.values()]
        .sort((a, b) => b.views - a.views || a.path.localeCompare(b.path))
        .slice(0, 20);
    };
    return {
      totals,
      daily,
      sources: sources.slice(0, 12),
      pages: pages(data[3]),
      articles: hasArticles ? pages(data[5], true) : [],
      sampled: data.some((r) => r?.sampled === true),
      dataLag: Math.max(0, ...data.map((r) => Number(r?.data_lag) || 0)),
      truncated: data.some((r) => r && Number(r.total_rows) > 1000),
      provider: "Яндекс Метрика",
    };
  }
}
