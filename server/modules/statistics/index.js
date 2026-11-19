import { createHash, timingSafeEqual } from "node:crypto";
import { nativeSources, reportPeriod } from "../../../shared/statistics.js";
import { validateNativePacket } from "./validation.js";
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
  const now = options.now || Date.now;
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
        return {
          ...s,
          connected: !!latest.generated_at,
          source: nativeSources[s.host] || null,
          lastSyncedAt: latest.generated_at || null,
          lastReceivedAt: latest.received_at || null,
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
  function report(id, key) {
    const s = getSite(id),
      range = reportPeriod(key, now());
    const saved = db
      .prepare(
        "SELECT * FROM statistics_native_reports WHERE site_id=? AND period=? AND source_host=?",
      )
      .get(id, key, s.host);
    if (saved) {
      const value = JSON.parse(saved.report),
        stale =
          now() - Date.parse(saved.generated_at) > 180000 ||
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
        checkedAt: new Date(now()).toISOString(),
        provider: nativeSources[s.host]?.label || "Статистика сайта",
        leadsOrigin: "native",
        ...Object.fromEntries(
          ["totals", "daily", "sources", "pages", "articles"].map((k) => [
            k,
            value[k],
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
    return {
      site: s,
      period: { key, from: range.from, to: range.to, group: range.group },
      status: "unconfigured",
      error: null,
      fetchedAt: null,
      receivedAt: null,
      checkedAt: new Date(now()).toISOString(),
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
    };
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
  return { register, receive: wrap(receive), report, list };
}
