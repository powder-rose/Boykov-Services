const DAY = 86400000,
  HOUR = 3600000,
  OFFSET = 3 * HOUR;
export const periods = ["24h", "7", "30", "90"];
export const moscowText = (ms) =>
  new Date(ms + OFFSET).toISOString().slice(0, 19).replace("T", " ");
export function reportPeriod(key, now = Date.now()) {
  if (!periods.includes(key))
    throw Object.assign(new Error("Выберите доступный период отчёта."), {
      status: 400,
    });
  const end = Math.floor(now / 60000) * 60000;
  const today = Math.floor((end + OFFSET) / DAY) * DAY - OFFSET;
  const start = key === "24h" ? end - DAY : today - (Number(key) - 1) * DAY;
  const step = key === "24h" ? HOUR : DAY;
  const first = Math.floor((start + OFFSET) / step) * step - OFFSET;
  const buckets = [];
  for (let time = first; time < end; time += step)
    buckets.push({
      key: time,
      from: Math.max(time, start),
      to: Math.min(time + step, end),
    });
  return {
    key,
    start,
    end,
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    date1: moscowText(start).slice(0, 10),
    date2: moscowText(Math.max(start, end - 1)).slice(0, 10),
    group: key === "24h" ? "hour" : "day",
    buckets,
  };
}
export function parseMoscow(value) {
  if (typeof value !== "string") throw new Error("INVALID_METRIKA_TIME");
  const normalized =
    value.length === 10 ? value + "T00:00:00+03:00" : value.replace(" ", "T");
  const ms = Date.parse(
    /(?:Z|[+-]\d\d:\d\d)$/.test(normalized)
      ? normalized
      : normalized + "+03:00",
  );
  if (!Number.isFinite(ms)) throw new Error("INVALID_METRIKA_TIME");
  return ms;
}
export function defaults(host) {
  const presets = {
    "nwdelectricity.ru": [["114341229"], ["/articles/", "/zhurnal/"]],
    "pasport-dostupnosty.ru": [["114185674"], ["/blog/"]],
    "pasport-bezopasnosty.ru": [["112564818"], ["/blog/"]],
    "boykovgroup.ru": [["106986222"], []],
    "energo-365.ru": [["87477971", "113826112"], []],
    "elektrolaboratoriya-techotchet.ru": [["113216650"], []],
  };
  const preset = presets[host] || [[], []];
  return {
    counterIds: preset[0],
    articlePrefixes: preset[1],
    includeSubdomains: host === "energo-365.ru",
  };
}
export function validateSettings(input) {
  if (
    !input ||
    !Array.isArray(input.counterIds) ||
    !input.counterIds.length ||
    input.counterIds.length > 10 ||
    input.counterIds.some(
      (id) => typeof id !== "string" || !/^[1-9]\d{3,11}$/.test(id),
    ) ||
    new Set(input.counterIds).size !== input.counterIds.length
  )
    throw Object.assign(
      new Error("Укажите от одного до десяти разных номеров счётчиков."),
      { status: 400 },
    );
  if (
    !Array.isArray(input.articlePrefixes) ||
    input.articlePrefixes.length > 10 ||
    input.articlePrefixes.some(
      (p) =>
        typeof p !== "string" ||
        p.length > 200 ||
        !/^\/(?:[\p{L}\p{N}_-]+\/)+$/u.test(p),
    ) ||
    typeof input.includeSubdomains !== "boolean"
  )
    throw Object.assign(
      new Error("Проверьте разделы статей и настройку поддоменов."),
      { status: 400 },
    );
  return {
    counterIds: input.counterIds,
    articlePrefixes: [...new Set(input.articlePrefixes)],
    includeSubdomains: input.includeSubdomains,
  };
}
export function hostMatches(host, site, includeSubdomains) {
  return (
    host === site ||
    host === "www." + site ||
    (includeSubdomains && host.endsWith("." + site))
  );
}
