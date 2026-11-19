import path from "node:path";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { MetrikaClient } from "./metrika.js";
import { defaults, validateSettings, reportPeriod } from "./period.js";

const bad = (message, status = 400) =>
  Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) =>
  Promise.resolve()
    .then(() => fn(req, res))
    .catch(next);
export async function createStatisticsModule(db, options) {
  db.exec(`CREATE TABLE IF NOT EXISTS statistics_settings (
    site_id TEXT PRIMARY KEY,counter_ids TEXT NOT NULL,article_prefixes TEXT NOT NULL,
    include_subdomains INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,verified_at TEXT);
    CREATE TABLE IF NOT EXISTS statistics_cache (
      site_id TEXT NOT NULL,period TEXT NOT NULL,signature TEXT NOT NULL,report TEXT NOT NULL,fetched_at INTEGER NOT NULL,
      PRIMARY KEY(site_id,period));`);
  const now = options.now || Date.now,
    client = new MetrikaClient({ fetcher: options.statisticsFetch || fetch });
  const privateDirectory = path.join(options.dataDir, "statistics");
  const secretFile = path.join(privateDirectory, "metrika.json");
  let credentials = null;
  try {
    const saved = JSON.parse(await readFile(secretFile, "utf8"));
    if (typeof saved.token === "string" && typeof saved.revision === "string")
      credentials = saved;
  } catch {}
  if (options.statisticsToken)
    credentials = { token: options.statisticsToken, revision: "fixture" };
  let counterList = [],
    counterListAt = 0;
  const inflight = new Map(),
    failures = new Map();
  function site(id) {
    const row = db
      .prepare("SELECT id,name,host,created_at FROM sales_sites WHERE id=?")
      .get(id);
    if (!row) throw bad("Сайт не найден.", 404);
    return row;
  }
  function settings(id) {
    const s = site(id),
      preset = defaults(s.host);
    db.prepare(
      "INSERT OR IGNORE INTO statistics_settings(site_id,counter_ids,article_prefixes,include_subdomains) VALUES(?,?,?,?)",
    ).run(
      id,
      JSON.stringify(preset.counterIds),
      JSON.stringify(preset.articlePrefixes),
      Number(preset.includeSubdomains),
    );
    const row = db
      .prepare("SELECT * FROM statistics_settings WHERE site_id=?")
      .get(id);
    return {
      counterIds: JSON.parse(row.counter_ids),
      articlePrefixes: JSON.parse(row.article_prefixes),
      includeSubdomains: !!row.include_subdomains,
      version: row.version,
      verifiedAt: row.verified_at,
    };
  }
  function list() {
    return db
      .prepare("SELECT id FROM sales_sites ORDER BY name COLLATE NOCASE,host")
      .all()
      .map(({ id }) => {
        const s = site(id),
          p = settings(id);
        return {
          ...s,
          settings: p,
          connected: !!(credentials && p.verifiedAt),
        };
      });
  }
  async function counters() {
    if (!credentials) throw bad("Подключите доступ к Яндекс Метрике.", 409);
    if (now() - counterListAt > 300000 || !counterListAt) {
      counterList = await client.counters(credentials.token);
      counterListAt = now();
    }
    return counterList;
  }
  async function connect(token) {
    if (typeof token !== "string" || !/^[\x21-\x7e]{20,4096}$/.test(token))
      throw bad("Вставьте токен без пробелов и префикса OAuth.");
    const accessible = await client.counters(token),
      revision = randomUUID();
    if (!accessible.length)
      throw bad(
        "У этого аккаунта нет доступных счётчиков Метрики. Проверьте аккаунт Яндекса и права просмотра.",
        403,
      );
    await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
    const temporary = path.join(privateDirectory, ".metrika-" + randomUUID());
    try {
      await writeFile(temporary, JSON.stringify({ token, revision }), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, secretFile);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw bad("Не удалось сохранить подключение Метрики.", 500);
    }
    credentials = { token, revision };
    counterList = accessible;
    counterListAt = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const s of list()) {
        const ids = s.settings.counterIds;
        const verified =
          ids.length &&
          ids.every((id) =>
            accessible.some((c) => c.id === id && c.status !== "Deleted"),
          );
        db.prepare(
          "UPDATE statistics_settings SET verified_at=?,version=version+1 WHERE site_id=?",
        ).run(verified ? new Date(now()).toISOString() : null, s.id);
      }
      db.exec("DELETE FROM statistics_cache; COMMIT");
      failures.clear();
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { ok: true, counters: accessible.length };
  }
  async function saveSettings(id, input) {
    const old = settings(id),
      next = validateSettings(input);
    if (input.version !== old.version)
      throw bad("Подключение уже изменилось. Обновите страницу.", 409);
    if (!credentials) throw bad("Сначала подключите доступ к Метрике.", 409);
    const revision = credentials.revision;
    await client.verify(next.counterIds, credentials.token);
    if (credentials.revision !== revision)
      throw bad("Токен изменился. Повторите сохранение.", 409);
    const result = db
      .prepare(
        "UPDATE statistics_settings SET counter_ids=?,article_prefixes=?,include_subdomains=?,verified_at=?,version=version+1 WHERE site_id=? AND version=?",
      )
      .run(
        JSON.stringify(next.counterIds),
        JSON.stringify(next.articlePrefixes),
        Number(next.includeSubdomains),
        new Date(now()).toISOString(),
        id,
        old.version,
      );
    if (result.changes !== 1)
      throw bad("Подключение уже изменилось. Обновите страницу.", 409);
    db.prepare("DELETE FROM statistics_cache WHERE site_id=?").run(id);
    for (const key of failures.keys())
      if (key.startsWith(id + ":")) failures.delete(key);
    return { ok: true };
  }
  function signature(s, p) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          s.host,
          p.counterIds,
          p.articlePrefixes,
          p.includeSubdomains,
          p.version,
          credentials?.revision,
        ]),
      )
      .digest("hex");
  }
  function leads(id, range) {
    const total = db
      .prepare(
        "SELECT COUNT(*) amount FROM sales_leads WHERE site_id=? AND created_at>=? AND created_at<?",
      )
      .get(id, range.from, range.to).amount;
    const step = range.group === "hour" ? 3600000 : 86400000,
      first = range.buckets[0]?.key || range.start;
    const rows = db
      .prepare(
        "SELECT CAST((unixepoch(created_at)*1000-?)/? AS INTEGER) slot,COUNT(*) amount FROM sales_leads WHERE site_id=? AND created_at>=? AND created_at<? GROUP BY slot",
      )
      .all(first, step, id, range.from, range.to);
    const slots = new Map(rows.map((r) => [r.slot, r.amount]));
    return { total, slots };
  }
  function emptyTraffic(range) {
    return {
      totals: { visits: null, views: null, articles: null },
      daily: range.buckets.map((b) => ({
        at: new Date(b.from).toISOString(),
        end: new Date(b.to).toISOString(),
        visits: null,
        views: null,
        articles: null,
      })),
      sources: [],
      pages: [],
      articles: [],
      sampled: false,
      dataLag: 0,
      truncated: false,
      provider: "Яндекс Метрика",
    };
  }
  async function report(id, key) {
    const s = site(id),
      p = settings(id),
      range = reportPeriod(key, now()),
      sig = signature(s, p),
      cacheKey = id + ":" + key;
    const saved = db
      .prepare(
        "SELECT * FROM statistics_cache WHERE site_id=? AND period=? AND signature=?",
      )
      .get(id, key, sig);
    let value = saved ? JSON.parse(saved.report) : null,
      status = "ready",
      error = null,
      fetchedAt = saved?.fetched_at || null;
    const ttl = key === "24h" ? 120000 : 600000;
    const connected = !!(credentials && p.verifiedAt);
    if (!connected) {
      value = { traffic: emptyTraffic(range), range };
      status = "unconfigured";
    } else if (
      !saved ||
      now() - saved.fetched_at >= ttl ||
      saved.fetched_at > now() ||
      (key !== "24h" &&
        (value.range.date1 !== range.date1 ||
          value.range.date2 !== range.date2))
    ) {
      const failed = failures.get(cacheKey);
      if (failed && failed.until > now()) {
        error = failed.message;
        status = saved ? "stale" : "error";
      } else {
        const flightKey = cacheKey + ":" + sig;
        if (!inflight.has(flightKey)) {
          const credential = credentials;
          const pending = (async () => {
            const traffic = await client.report(s, p, range, credential.token);
            if (signature(site(id), settings(id)) !== sig)
              throw bad("Подключение изменилось. Обновите отчёт.", 409);
            const output = { traffic, range },
              time = now();
            db.prepare(
              "INSERT INTO statistics_cache(site_id,period,signature,report,fetched_at) VALUES(?,?,?,?,?) ON CONFLICT(site_id,period) DO UPDATE SET signature=excluded.signature,report=excluded.report,fetched_at=excluded.fetched_at",
            ).run(id, key, sig, JSON.stringify(output), time);
            failures.delete(cacheKey);
            return { value: output, fetchedAt: time };
          })().finally(() => inflight.delete(flightKey));
          inflight.set(flightKey, pending);
        }
        try {
          const result = await inflight.get(flightKey);
          value = result.value;
          fetchedAt = result.fetchedAt;
        } catch (e) {
          error = e.message;
          failures.set(cacheKey, { message: error, until: now() + 60000 });
          status = saved ? "stale" : "error";
        }
      }
    }
    if (!value) value = { traffic: emptyTraffic(range), range };
    const local = leads(id, value.range),
      t = value.traffic;
    return {
      site: { id: s.id, name: s.name, host: s.host },
      period: {
        key,
        from: value.range.from,
        to: value.range.to,
        group: value.range.group,
      },
      status,
      error,
      fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
      checkedAt: new Date(now()).toISOString(),
      refreshSeconds: 30,
      trafficRefreshSeconds: ttl / 1000,
      provider: t.provider,
      dataLag: t.dataLag,
      sampled: t.sampled,
      truncated: t.truncated,
      totals: { ...t.totals, leads: local.total },
      daily: t.daily.map((d, i) => ({ ...d, leads: local.slots.get(i) || 0 })),
      sources: t.sources,
      pages: t.pages,
      articles: t.articles,
      articlePrefixes: p.articlePrefixes,
      leadsSince: s.created_at,
      counterIds: p.counterIds,
    };
  }
  const admin = (req) => {
    if (req.actor?.role !== "admin")
      throw bad("Настраивать статистику может администратор.", 403);
  };
  function register(app) {
    app.use("/api/statistics", (req, res, next) => {
      res.set("Cache-Control", "private, no-store");
      next();
    });
    app.get(
      "/api/statistics/sites",
      wrap((req, res) =>
        res.json({
          sites: list(),
          oauthConfigured: !!credentials,
          canConfigure: req.actor?.role === "admin",
        }),
      ),
    );
    app.get(
      "/api/statistics/report",
      wrap(async (req, res) =>
        res.json(
          await report(
            String(req.query.site || ""),
            String(req.query.period || "30"),
          ),
        ),
      ),
    );
    app.get(
      "/api/statistics/counters",
      wrap(async (req, res) => {
        admin(req);
        res.json({ counters: await counters() });
      }),
    );
    app.post(
      "/api/statistics/connection",
      wrap(async (req, res) => {
        admin(req);
        res.json(await connect(req.body?.token));
      }),
    );
    app.patch(
      "/api/statistics/sites/:id",
      wrap(async (req, res) => {
        admin(req);
        res.json(await saveSettings(req.params.id, req.body));
      }),
    );
  }
  return { register, connect, report, list, saveSettings };
}
