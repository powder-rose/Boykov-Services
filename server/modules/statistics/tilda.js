import express from "express";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cleanPath, sourceLabel } from "../../../shared/statistics.js";

const hosts = new Set(["boykovgroup.ru", "elektrolaboratoriya-techotchet.ru"]);
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DAY = 86400000;
const SESSION = 1800000;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const failure = (status, message) =>
  Object.assign(new Error(message), { status });
const counter = readFileSync(
  new URL("./tilda-counter.js", import.meta.url),
  "utf8",
);

export function isTildaStatisticsHost(host) {
  return hosts.has(host);
}

function originHost(origin) {
  for (const host of hosts) {
    if (origin === `https://${host}` || origin === `https://www.${host}`)
      return host;
  }
  return null;
}

function viewPayload(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "eventId,path,sessionId,source" ||
    typeof value.eventId !== "string" ||
    !uuid.test(value.eventId) ||
    typeof value.sessionId !== "string" ||
    !uuid.test(value.sessionId) ||
    typeof value.path !== "string" ||
    value.path.length > 1000 ||
    cleanPath(value.path) !== value.path ||
    typeof value.source !== "string" ||
    !/^(?:direct|internal|unknown|utm:[A-Za-z0-9_.-]{1,64}|ref:[a-z0-9](?:[a-z0-9.-]{0,148}[a-z0-9])?)$/.test(
      value.source,
    )
  ) {
    throw failure(400, "Некорректное событие посещаемости.");
  }
  return value;
}

// This public intake accepts only anonymous browser events, never lead records or native reports.
// Origin is a browser scope check, not proof of a human visit. Fixed storage budgets bound abuse.
export function createTildaStatistics(db, now) {
  db.exec(`CREATE TABLE IF NOT EXISTS statistics_tilda_state (
    site_id TEXT NOT NULL, host TEXT NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
    PRIMARY KEY(site_id,host));
  CREATE TABLE IF NOT EXISTS statistics_tilda_views (
    site_id TEXT NOT NULL, host TEXT NOT NULL, event_id TEXT NOT NULL, digest TEXT NOT NULL,
    at INTEGER NOT NULL, path TEXT NOT NULL, visit INTEGER NOT NULL CHECK(visit IN (0,1)), source TEXT NOT NULL,
    PRIMARY KEY(site_id,host,event_id));
  CREATE INDEX IF NOT EXISTS statistics_tilda_time ON statistics_tilda_views(site_id,host,at);
  CREATE TABLE IF NOT EXISTS statistics_tilda_sessions (
    site_id TEXT NOT NULL, host TEXT NOT NULL, session_id TEXT NOT NULL, last_at INTEGER NOT NULL,
    PRIMARY KEY(site_id,host,session_id));
  CREATE INDEX IF NOT EXISTS statistics_tilda_sessions_expiry ON statistics_tilda_sessions(last_at);
  CREATE TABLE IF NOT EXISTS statistics_tilda_budget (
    site_id TEXT NOT NULL, host TEXT NOT NULL, day INTEGER NOT NULL, minute INTEGER NOT NULL,
    day_count INTEGER NOT NULL, minute_count INTEGER NOT NULL, PRIMARY KEY(site_id,host));`);
  const state = (site) =>
    db
      .prepare(
        "SELECT first_at,last_at FROM statistics_tilda_state WHERE site_id=? AND host=?",
      )
      .get(site.id, site.host);
  const budget = db.prepare(
    "SELECT day,minute,day_count,minute_count FROM statistics_tilda_budget WHERE site_id=? AND host=?",
  );
  function capture(site, input, at) {
    const event = viewPayload(input);
    const args = [site.id, site.host];
    const signature = hash(
      JSON.stringify([event.sessionId, event.path, event.source]),
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      const old = db
        .prepare(
          "SELECT digest FROM statistics_tilda_views WHERE site_id=? AND host=? AND event_id=?",
        )
        .get(...args, event.eventId);
      if (old) {
        if (old.digest !== signature)
          throw failure(409, "Событие уже принято с другими данными.");
        db.exec("COMMIT");
        return true;
      }
      const day = Math.floor(at / DAY),
        minute = Math.floor(at / 60000);
      const previous = budget.get(...args);
      const newDay = previous?.day !== day;
      const dayCount = newDay ? 1 : previous.day_count + 1;
      const minuteCount =
        previous?.minute === minute ? previous.minute_count + 1 : 1;
      if (dayCount > 10000 || minuteCount > 300)
        throw failure(429, "Лимит событий посещаемости.");
      db.prepare(
        `INSERT INTO statistics_tilda_budget VALUES(?,?,?,?,?,?)
        ON CONFLICT(site_id,host) DO UPDATE SET day=excluded.day,minute=excluded.minute,
        day_count=excluded.day_count,minute_count=excluded.minute_count`,
      ).run(...args, day, minute, dayCount, minuteCount);
      if (newDay) {
        db.prepare(
          "DELETE FROM statistics_tilda_views WHERE site_id=? AND host=? AND at<?",
        ).run(...args, at - 93 * DAY);
        db.prepare(
          "DELETE FROM statistics_tilda_sessions WHERE site_id=? AND host=? AND last_at<?",
        ).run(...args, at - DAY);
      }
      const sid = hash(site.host + ":" + event.sessionId);
      const session = db
        .prepare(
          "SELECT last_at FROM statistics_tilda_sessions WHERE site_id=? AND host=? AND session_id=?",
        )
        .get(...args, sid);
      const visit = !session || at - session.last_at >= SESSION ? 1 : 0;
      db.prepare(
        `INSERT INTO statistics_tilda_sessions VALUES(?,?,?,?) ON CONFLICT(site_id,host,session_id) DO UPDATE SET last_at=MAX(last_at,excluded.last_at)`,
      ).run(...args, sid, at);
      db.prepare(
        "INSERT INTO statistics_tilda_views VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        ...args,
        event.eventId,
        signature,
        at,
        event.path,
        visit,
        event.source,
      );
      db.prepare(
        `INSERT INTO statistics_tilda_state VALUES(?,?,?,?) ON CONFLICT(site_id,host) DO UPDATE SET last_at=MAX(last_at,excluded.last_at)`,
      ).run(...args, at, at);
      db.exec("COMMIT");
      return false;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
  function register(app) {
    const route = "/hooks/tilda-statistics/view";
    const scope = (req, res, next) => {
      const origin = req.get("origin"),
        host = originHost(origin);
      res.set("Cache-Control", "no-store");
      res.vary("Origin");
      if (!host) return res.status(403).json({ error: "Домен не подключён." });
      res.set("Access-Control-Allow-Origin", origin);
      req.tildaStatisticsHost = host;
      next();
    };
    app.get("/hooks/tilda-statistics/counter.js", (req, res) => {
      res.set("Cache-Control", "public, max-age=300");
      res.set("Cross-Origin-Resource-Policy", "cross-origin");
      res.type("application/javascript").send(counter);
    });
    app.options(route, scope, (req, res) => {
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      res.sendStatus(204);
    });
    app.post(
      route,
      scope,
      express.text({ type: "text/plain", limit: "4kb", inflate: false }),
      (req, res, next) => {
        try {
          if (!req.is("text/plain"))
            throw failure(415, "Неподдерживаемый формат.");
          let value;
          try {
            value = JSON.parse(req.body);
          } catch {
            throw failure(400, "Некорректное событие.");
          }
          const event = viewPayload(value);
          const site = db
            .prepare(
              "SELECT id,host FROM sales_sites WHERE host=? AND delivery_mode='tilda'",
            )
            .get(req.tildaStatisticsHost);
          if (!site) throw failure(404, "Источник не настроен.");
          if (
            req.get("dnt") === "1" ||
            req.get("sec-gpc") === "1" ||
            !req.get("user-agent") ||
            /bot|spider|crawler|headless|preview|facebookexternalhit|curl|wget|python/i.test(
              req.get("user-agent"),
            )
          ) {
            return res.json({
              ok: true,
              ignored: true,
              eventId: event.eventId,
            });
          }
          const duplicate = capture(site, event, now());
          res
            .status(duplicate ? 200 : 201)
            .json({ ok: true, eventId: event.eventId, duplicate });
        } catch (error) {
          next(error);
        }
      },
    );
  }
  function report(site, range, daily) {
    const connection = state(site);
    if (!connection) return null;
    const args = [site.id, site.host, range.start, range.end];
    const step = range.group === "hour" ? 3600000 : DAY;
    const first = range.buckets[0]?.key ?? range.start;
    const traffic = new Map(
      db
        .prepare(
          `SELECT CAST((at-?)/? AS INTEGER) slot,COUNT(*) views,SUM(visit) visits
      FROM statistics_tilda_views WHERE site_id=? AND host=? AND at>=? AND at<? GROUP BY slot`,
        )
        .all(first, step, ...args)
        .map((r) => [r.slot, r]),
    );
    for (const [i, point] of daily.entries()) {
      if (Date.parse(point.end) <= connection.first_at) continue;
      point.views = traffic.get(i)?.views || 0;
      point.visits = traffic.get(i)?.visits || 0;
    }
    const sources = new Map();
    for (const row of db
      .prepare(
        "SELECT source,COUNT(*) visits FROM statistics_tilda_views WHERE site_id=? AND host=? AND at>=? AND at<? AND visit=1 GROUP BY source",
      )
      .all(...args)) {
      const name = sourceLabel(row.source);
      sources.set(name, (sources.get(name) || 0) + row.visits);
    }
    const pages = db
      .prepare(
        "SELECT path,COUNT(*) views FROM statistics_tilda_views WHERE site_id=? AND host=? AND at>=? AND at<? GROUP BY path ORDER BY views DESC,path LIMIT 20",
      )
      .all(...args)
      .map(({ path, views }) => ({
        path,
        title: path,
        url: "https://" + site.host + path,
        views,
      }));
    const stamp = new Date(range.end).toISOString();
    return {
      status: "ready",
      error: null,
      fetchedAt: stamp,
      receivedAt: new Date(connection.last_at).toISOString(),
      coverageFrom: new Date(connection.first_at).toISOString(),
      totals: {
        visits: daily.some((p) => p.visits !== null)
          ? daily.reduce((n, p) => n + (p.visits || 0), 0)
          : null,
        views: daily.some((p) => p.views !== null)
          ? daily.reduce((n, p) => n + (p.views || 0), 0)
          : null,
        articles: null,
        leads: daily.reduce((n, p) => n + p.leads, 0),
      },
      daily,
      sources: [...sources]
        .map(([name, visits]) => ({ name, visits }))
        .sort((a, b) => b.visits - a.visits || a.name.localeCompare(b.name))
        .slice(0, 20),
      pages,
      articles: [],
    };
  }
  return { register, state, report };
}
