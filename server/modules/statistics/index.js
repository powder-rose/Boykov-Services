import { createHash, timingSafeEqual } from "node:crypto";
import { nativeSources, reportPeriod } from "../../../shared/statistics.js";
import { validateNativePacket } from "./validation.js";
import { buildStatisticsOverview, statisticsColor } from "./overview.js";
import { createTildaStatistics, isTildaStatisticsHost } from "./tilda.js";
const bad = (message, status = 400) =>
  Object.assign(new Error(message), { status });
const digest = (text) => createHash("sha256").update(text).digest("hex");
const wrap = (fn) => (req, res, next) =>
  Promise.resolve()
    .then(() => fn(req, res))
    .catch(next);
export async function createStatisticsModule(db, options) {
  db.exec(`CREATE TABLE IF NOT EXISTS statistics_native_reports (
    site_id TEXT NOT NULL, period TEXT NOT NULL, source_host TEXT NOT NULL, report TEXT NOT NULL,
    generated_at TEXT NOT NULL, received_at TEXT NOT NULL, packet_hash TEXT NOT NULL,
    PRIMARY KEY(site_id,period));`);
  db.exec(`CREATE TABLE IF NOT EXISTS statistics_site_colors (
    site_id TEXT PRIMARY KEY, color_index INTEGER NOT NULL UNIQUE CHECK(color_index>=0));`);
  const now = options.now || Date.now;
  const tilda = createTildaStatistics(db, now);
  const getSite = (id) => {
    const s = db
      .prepare("SELECT id,name,host,created_at FROM sales_sites WHERE id=?")
      .get(id);
    if (!s) throw bad("Сайт не найден.", 404);
    return s;
  };
  function list() {
    return db
      .prepare("SELECT id FROM sales_sites ORDER BY name COLLATE NOCASE,host")
      .all()
      .map(({ id }) => {
        const s = getSite(id),
          latest = db
            .prepare(
              "SELECT MAX(generated_at) generated_at,MAX(received_at) received_at FROM statistics_native_reports WHERE site_id=? AND source_host=?",
            )
            .get(id, s.host);
        const live = isTildaStatisticsHost(s.host) ? tilda.state(s) : null;
        return {
          ...s,
          connected: !!latest.generated_at || !!live,
          source: nativeSources[s.host] || null,
          lastSyncedAt: live
            ? new Date(live.last_at).toISOString()
            : latest.generated_at || null,
          lastReceivedAt: live
            ? new Date(live.last_at).toISOString()
            : latest.received_at || null,
        };
      });
  }
  function receive(req, res) {
    const site = db
      .prepare("SELECT * FROM sales_sites WHERE id=?")
      .get(req.params.siteId);
    const token = /^Bearer ([a-f0-9]{64})$/.exec(
      req.get("authorization") || "",
    )?.[1];
    const expected = Buffer.from(site?.token_hash || "0".repeat(64), "hex"),
      actual = Buffer.from(digest(token || ""), "hex");
    if (
      !token ||
      !site?.token_hash ||
      expected.length !== actual.length ||
      !timingSafeEqual(actual, expected)
    )
      throw bad("Нет доступа к приёму статистики.", 401);
    if (isTildaStatisticsHost(site.host))
      throw bad("Для Tilda используется собственный счётчик.");
    const packet = validateNativePacket(req.body, site, now()),
      hash = digest(JSON.stringify(packet));
    const saved = db
      .prepare(
        "SELECT generated_at,packet_hash FROM statistics_native_reports WHERE site_id=? AND source_host=? LIMIT 1",
      )
      .get(site.id, site.host);
    if (saved && packet.generatedAt < saved.generated_at)
      return res.json({
        ok: true,
        siteId: site.id,
        generatedAt: packet.generatedAt,
        ignored: true,
      });
    if (saved && packet.generatedAt === saved.generated_at) {
      if (hash !== saved.packet_hash)
        throw bad("Отчёт за это время уже сохранён с другими данными.", 409);
      return res.json({
        ok: true,
        siteId: site.id,
        generatedAt: packet.generatedAt,
        duplicate: true,
      });
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const save = db.prepare(
        "INSERT INTO statistics_native_reports(site_id,period,source_host,report,generated_at,received_at,packet_hash) VALUES(?,?,?,?,?,?,?) ON CONFLICT(site_id,period) DO UPDATE SET source_host=excluded.source_host,report=excluded.report,generated_at=excluded.generated_at,received_at=excluded.received_at,packet_hash=excluded.packet_hash",
      );
      for (const report of packet.reports)
        save.run(
          site.id,
          report.key,
          site.host,
          JSON.stringify(report),
          packet.generatedAt,
          new Date(now()).toISOString(),
          hash,
        );
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
    res
      .status(201)
      .json({ ok: true, siteId: site.id, generatedAt: packet.generatedAt });
  }
  function report(id, key, clock = now()) {
    const s = getSite(id),
      range = reportPeriod(key, clock);
    const saved = db
      .prepare(
        "SELECT * FROM statistics_native_reports WHERE site_id=? AND period=? AND source_host=?",
      )
      .get(id, key, s.host);
    if (saved && !isTildaStatisticsHost(s.host)) {
      const value = JSON.parse(saved.report),
        stale =
          clock - Date.parse(saved.generated_at) > 180000 ||
          (key !== "24h" && value.period.from !== range.from);
      return {
        site: s,
        period: { key, ...value.period },
        status: stale ? "stale" : "ready",
        error: stale
          ? "От сайта давно не поступал свежий отчёт. Проверьте синхронизацию."
          : null,
        fetchedAt: saved.generated_at,
        receivedAt: saved.received_at,
        checkedAt: new Date(clock).toISOString(),
        provider: nativeSources[s.host]?.label || "Статистика сайта",
        leadsOrigin: "native",
        ...(value.coverageFrom ? { coverageFrom: value.coverageFrom } : {}),
        ...Object.fromEntries(
          ["totals", "daily", "sources", "pages", "articles"].map((k) => [
            k,
            k === "daily" && value.coverageFrom
              ? value.daily.map((p) =>
                  Date.parse(p.end) <= Date.parse(value.coverageFrom)
                    ? { ...p, visits: null, views: null, articles: null }
                    : p,
                )
              : value[k],
          ]),
        ),
      };
    }
    const step = range.group === "hour" ? 3600000 : 86400000;
    const first = range.buckets[0]?.key ?? range.start;
    const counts = db
      .prepare(
        "SELECT CAST((unixepoch(created_at)*1000-?)/? AS INTEGER) slot,count(*) amount FROM sales_leads WHERE site_id=? AND created_at>=? AND created_at<? GROUP BY slot",
      )
      .all(first, step, id, range.from, range.to);
    const slots = new Map(counts.map((r) => [r.slot, r.amount]));
    const daily = range.buckets.map((b, i) => ({
      at: new Date(b.from).toISOString(),
      end: new Date(b.to).toISOString(),
      visits: null,
      views: null,
      articles: null,
      leads: slots.get(i) || 0,
    }));
    const live = isTildaStatisticsHost(s.host)
      ? tilda.report(s, range, daily)
      : null;
    return {
      site: s,
      period: { key, from: range.from, to: range.to, group: range.group },
      status: "unconfigured",
      error: null,
      fetchedAt: null,
      receivedAt: null,
      checkedAt: new Date(clock).toISOString(),
      provider: nativeSources[s.host]?.label || "Статистика сайта",
      leadsOrigin: "hub",
      totals: {
        visits: null,
        views: null,
        articles: null,
        leads: daily.reduce((n, p) => n + p.leads, 0),
      },
      daily,
      sources: [],
      pages: [],
      articles: [],
      ...(live || {}),
    };
  }
  function overview(key) {
    const clock = now();
    reportPeriod(key, clock);
    const sites = list();
    db.exec("BEGIN IMMEDIATE");
    try {
      const lookup = db.prepare(
        "SELECT color_index FROM statistics_site_colors WHERE site_id=?",
      );
      let next = db
        .prepare(
          "SELECT COALESCE(MAX(color_index),-1)+1 n FROM statistics_site_colors",
        )
        .get().n;
      for (const site of sites) {
        let row = lookup.get(site.id);
        if (!row) {
          row = { color_index: next++ };
          db.prepare("INSERT INTO statistics_site_colors VALUES(?,?)").run(
            site.id,
            row.color_index,
          );
        }
        site.color = statisticsColor(row.color_index);
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
    const reports = sites.map((site) => {
      try {
        const value = report(site.id, key, clock);
        if (
          !Array.isArray(value.daily) ||
          !value.totals ||
          !Number.isFinite(Date.parse(value.period.from)) ||
          !Number.isFinite(Date.parse(value.period.to)) ||
          !["visits", "views", "articles", "leads"].every((metric) =>
            value.totals[metric] === null
              ? value.daily.every((p) => p?.[metric] === null)
              : Number.isSafeInteger(value.totals[metric]) &&
                value.totals[metric] >= 0 &&
                value.totals[metric] ===
                  value.daily.reduce((sum, p) => sum + (p?.[metric] ?? 0), 0),
          ) ||
          !value.daily.every(
            (point) =>
              point &&
              Number.isFinite(Date.parse(point.at)) &&
              Number.isFinite(Date.parse(point.end)) &&
              ["visits", "views", "articles", "leads"].every(
                (metric) =>
                  point[metric] === null ||
                  (Number.isSafeInteger(point[metric]) && point[metric] >= 0),
              ),
          )
        )
          throw Error("INVALID_SAVED_STATISTICS");
        return value;
      } catch {
        return {
          status: "error",
          error:
            "Не удалось прочитать отчёт сайта. Откройте отдельную статистику для проверки.",
        };
      }
    });
    return buildStatisticsOverview(sites, reports, key, clock);
  }
  function register(app) {
    app.use("/api/statistics", (req, res, next) => {
      res.set("Cache-Control", "private, no-store");
      next();
    });
    app.get(
      "/api/statistics/sites",
      wrap((req, res) =>
        res.json({ sites: list(), canConfigure: req.actor?.role === "admin" }),
      ),
    );
    app.get(
      "/api/statistics/overview",
      wrap((req, res) => res.json(overview(String(req.query.period || "24h")))),
    );
    app.get(
      "/api/statistics/report",
      wrap((req, res) =>
        res.json(
          report(
            String(req.query.site || ""),
            String(req.query.period || "24h"),
          ),
        ),
      ),
    );
  }
  return {
    register,
    registerTilda: tilda.register,
    receive: wrap(receive),
    report,
    list,
    overview,
  };
}
