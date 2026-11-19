import {
  parseMoscow,
  moscowText,
} from "../../server/modules/statistics/period.js";
export function metrikaFixture() {
  const calls = [],
    state = { fail: false, delay: 0, active: 0, maxActive: 0 };
  const ids = [
    "114341229",
    "114185674",
    "112564818",
    "106986222",
    "87477971",
    "113826112",
    "113216650",
  ];
  async function fetcher(input, options) {
    const url = new URL(input);
    calls.push({ url, options });
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    try {
      if (state.delay) await new Promise((r) => setTimeout(r, state.delay));
      if (url.pathname === "/management/v1/counters")
        return Response.json({
          counters: ids.map((id) => ({
            id: Number(id),
            name: "Счётчик " + id,
            site: "https://nwdelectricity.ru",
            status: "Active",
          })),
        });
      if (url.pathname.startsWith("/management/v1/counter/"))
        return Response.json({
          counter: {
            id: Number(url.pathname.split("/").at(-1)),
            status: "Active",
          },
        });
      if (state.fail)
        return Response.json(
          { error: "must never expose raw provider errors" },
          { status: 503 },
        );
      const params = url.searchParams,
        filter = params.get("filters") || "";
      const start = parseMoscow(filter.match(/dateTime>='([^']+)'/)?.[1]);
      const end = parseMoscow(filter.match(/dateTime<'([^']+)'/)?.[1]);
      const article = filter.includes("URLPath=~"),
        visits = params.get("metrics") === "ym:s:visits";
      const host = params.get("ids")?.includes("112564818")
        ? "pasport-bezopasnosty.ru"
        : params.get("ids")?.includes("87477971")
          ? "energo-365.ru"
          : "nwdelectricity.ru";
      if (url.pathname.endsWith("/bytime")) {
        const step = params.get("group") === "hour" ? 3600000 : 86400000;
        const first = parseMoscow(params.get("date1")),
          last = parseMoscow(params.get("date2")) + 86400000;
        const time_intervals = [],
          values = [];
        for (let t = first; t < last; t += step) {
          time_intervals.push([moscowText(t), moscowText(t + step - 1)]);
          values.push(
            t + step <= start || t >= end ? 0 : article ? 2 : visits ? 3 : 7,
          );
        }
        return Response.json({
          time_intervals,
          data: [{ dimensions: [], metrics: [values] }],
          sampled: false,
          data_lag: 90,
        });
      }
      if (visits)
        return Response.json({
          data: [
            {
              dimensions: [
                { id: "direct", name: "Прямые заходы" },
                { id: null, name: "Не определено" },
                { id: null, name: "Не определено" },
              ],
              metrics: [25],
            },
            {
              dimensions: [
                { id: "organic", name: "Поиск" },
                { id: "yandex", name: "Яндекс" },
                { id: null, name: "Не определено" },
              ],
              metrics: [17],
            },
            {
              dimensions: [
                { id: "organic", name: "Поиск" },
                { id: "google", name: "Google" },
                { id: null, name: "Не определено" },
              ],
              metrics: [10],
            },
            {
              dimensions: [
                { id: "referral", name: "Сайты" },
                { id: null, name: "Не определено" },
                {
                  id: "https://dzen.ru/article/?secret=x",
                  name: "https://dzen.ru/article/?secret=x",
                },
              ],
              metrics: [3],
            },
          ],
          total_rows: 4,
          sampled: false,
        });
      const row = (pathname, title, value, domain = host) => ({
        dimensions: [
          { name: domain },
          { name: pathname },
          ...(article ? [{ name: title }] : []),
        ],
        metrics: [value],
      });
      return Response.json({
        data: article
          ? [
              row(
                "/articles/test/",
                "Назначение ответственного за электрохозяйство",
                8,
              ),
              row("/articles/test/", "Старый заголовок", 2),
              row("/articles/second/", "Порядок технического обслуживания", 5),
            ]
          : [
              row("/", "", 92),
              row("/services/", "", 34),
              row("/ceny/", "", 13),
              row("/kontakty/", "", 12),
              row("//attacker.invalid/leak", "", 1),
              row("/bad/", "", 9, "nwdelectricity.ru.attacker.invalid"),
            ],
        total_rows: 6,
        sampled: false,
      });
    } finally {
      state.active--;
    }
  }
  return { fetcher, calls, state, ids };
}
