import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/auth.js";
import { createInitialAdmin } from "../server/accounts.js";
import {
  reportPeriod,
  validateSettings,
  parseMoscow,
  hostMatches,
} from "../server/modules/statistics/period.js";
import { MetrikaClient } from "../server/modules/statistics/metrika.js";
import { metrikaFixture } from "./helpers/metrika-fixture.js";

const password = "statistics-fixture-password",
  passwordHash = await hashPassword(password),
  oauth = "fixture-metrika-token-no-real-access";
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "boykov-statistics-")),
    remote = metrikaFixture();
  let clock = Date.parse("2026-11-19T13:34:50.000Z");
  const app = await createApp({
    dataDir: directory,
    passwordHash,
    now: () => clock,
    secureCookies: false,
    allowedOrigins: [],
    statisticsFetch: remote.fetcher,
    worker: async () => Response.json({ jobs: [], ok: true }),
    isConfigured: () => false,
  });
  await createInitialAdmin(app.locals.db, {
    login: "stats.admin",
    name: "Тестовый администратор",
    password,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    app.locals.db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = (route, method = "GET", body, session = "") =>
    fetch(base + "/api" + route, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Boykov-Request": "1",
        Cookie: session,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const adminResponse = await request("/auth/login", "POST", {
    login: "stats.admin",
    password,
  });
  const admin = adminResponse.headers.get("set-cookie").split(";")[0];
  const sharedResponse = await request("/auth/login", "POST", { password });
  const shared = sharedResponse.headers.get("set-cookie").split(";")[0];
  const api = (route, method = "GET", body, session = admin) =>
    request(route, method, body, session);
  const report = async (key = "24h", site = "nwd") =>
    await (await api(`/statistics/report?site=${site}&period=${key}`)).json();
  const connect = async () => {
    const r = await api("/statistics/connection", "POST", { token: oauth });
    assert.equal(r.status, 200, await r.clone().text());
  };
  return {
    app,
    base,
    api,
    request,
    admin,
    shared,
    remote,
    report,
    connect,
    directory,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test("statistics uses rolling 24 hours, Moscow calendar days and exact half-open boundaries", () => {
  const now = Date.parse("2026-01-01T00:21:46Z"),
    day = reportPeriod("24h", now);
  assert.equal(day.end - day.start, 86400000);
  assert.equal(day.group, "hour");
  assert.equal(day.buckets.length, 25);
  assert.equal(day.buckets[0].from, day.start);
  assert.equal(day.buckets.at(-1).to, day.end);
  assert.equal(reportPeriod("7", now).from, "2025-12-25T21:00:00.000Z");
  assert.equal(reportPeriod("90", now).buckets.length, 90);
  assert.equal(
    parseMoscow("2026-01-01 03:21:00"),
    Date.parse("2026-01-01T00:21:00Z"),
  );
  assert.throws(() => reportPeriod("365", now));
  assert.equal(hostMatches("lp.energo-365.ru", "energo-365.ru", true), true);
  assert.equal(
    hostMatches("energo-365.ru.attacker.invalid", "energo-365.ru", true),
    false,
  );
  assert.throws(() =>
    validateSettings({
      counterIds: ["1' OR 1"],
      articlePrefixes: [],
      includeSubdomains: false,
    }),
  );
  assert.throws(() =>
    validateSettings({
      counterIds: ["123456"],
      articlePrefixes: ["/blog/');"],
      includeSubdomains: false,
    }),
  );
});

test("statistics is private; shared sessions can view reports and cannot read or change credentials", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/statistics/sites")).status, 401);
  const sites = await f.api("/statistics/sites", "GET", undefined, f.shared);
  assert.equal(sites.status, 200);
  assert.equal((await sites.json()).canConfigure, false);
  for (const [route, method, body] of [
    ["/statistics/connection", "POST", { token: oauth }],
    ["/statistics/counters", "GET", undefined],
    [
      "/statistics/sites/nwd",
      "PATCH",
      {
        counterIds: ["114341229"],
        articlePrefixes: [],
        includeSubdomains: false,
        version: 1,
      },
    ],
  ])
    assert.equal((await f.api(route, method, body, f.shared)).status, 403);
  const report = await f.report();
  assert.equal(report.status, "unconfigured");
  assert.equal(report.totals.visits, null);
  assert.equal(report.totals.views, null);
  assert.equal(report.totals.leads, 0);
  assert.equal(f.remote.calls.length, 0);
});

test("statistics token stays in a private server file and known accessible counters connect automatically", async (t) => {
  const f = await fixture(t);
  await f.connect();
  const response = await f.api("/statistics/sites"),
    text = await response.text();
  assert.doesNotMatch(text, new RegExp(oauth));
  assert.ok(JSON.parse(text).sites.find((s) => s.id === "nwd").connected);
  const secret = path.join(f.directory, "statistics/metrika.json");
  assert.equal(JSON.parse(await readFile(secret, "utf8")).token, oauth);
  assert.ok((await stat(secret)).isFile());
  // Windows uses ACLs; stat().mode does not represent Unix access permissions.
  if (process.platform !== "win32") {
    assert.equal((await stat(secret)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(secret))).mode & 0o777, 0o700);
  }
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("statistics requests use Moscow dates, matching domain filters and exact time constraints", async (t) => {
  const f = await fixture(t);
  await f.connect();
  const result = await f.report();
  assert.equal(result.status, "ready");
  const calls = f.remote.calls.filter((c) =>
    c.url.pathname.startsWith("/stat/"),
  );
  assert.equal(calls.length, 6);
  for (const { url, options } of calls) {
    assert.equal(url.origin, "https://api-metrika.yandex.net");
    assert.equal(url.searchParams.get("timezone"), "+03:00");
    assert.equal(options.headers.Authorization, "OAuth " + oauth);
    assert.equal(options.redirect, "error");
    assert.doesNotMatch(url.href, new RegExp(oauth));
    assert.match(url.searchParams.get("filters"), /dateTime>=/);
    assert.match(url.searchParams.get("filters"), /nwdelectricity/);
  }
  assert.equal(result.daily.length, 25);
  assert.equal(result.totals.visits, 75);
  assert.equal(result.totals.views, 175);
  assert.equal(result.totals.articles, 50);
  assert.equal(result.articles[0].views, 10);
  assert.equal(result.sources.find((s) => s.name === "dzen.ru").visits, 3);
  assert.ok(
    result.pages.every((p) => new URL(p.url).hostname === "nwdelectricity.ru"),
  );
});

test("statistics deduplicates concurrent reports, caches traffic and keeps precise counts including trash", async (t) => {
  const f = await fixture(t);
  await f.connect();
  f.remote.state.delay = 5;
  const range = reportPeriod("24h", f.now());
  const add = (when, deleted = null) => {
    const id = randomUUID();
    f.app.locals.db
      .prepare(
        "INSERT INTO sales_leads(id,site_id,event_id,payload_hash,payload,search_text,created_at,received_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(id, "nwd", id, "hash", "{}", "", when, when, when, deleted);
  };
  add(range.from);
  add(new Date(range.end - 1).toISOString(), new Date(f.now()).toISOString());
  add(range.to);
  add(new Date(range.start - 1).toISOString());
  const [one, two] = await Promise.all([f.report(), f.report()]);
  assert.equal(one.totals.leads, 2);
  assert.deepEqual(one, two);
  assert.equal(
    one.daily.reduce((n, r) => n + r.leads, 0),
    2,
  );
  const before = f.remote.calls.length;
  await f.report();
  assert.equal(f.remote.calls.length, before);
  assert.ok(f.remote.state.maxActive <= 2);
  await f.report("7");
  assert.ok(f.remote.calls.length > before);
});

test("statistics preserves the exact last report window after outage and never replaces values with zero", async (t) => {
  const f = await fixture(t);
  await f.connect();
  const first = await f.report();
  f.advance(180000);
  f.remote.state.fail = true;
  const stale = await f.report();
  assert.equal(stale.status, "stale");
  assert.deepEqual(stale.period, first.period);
  assert.equal(stale.totals.views, first.totals.views);
  assert.equal(stale.fetchedAt, first.fetchedAt);
  assert.doesNotMatch(stale.error, /must never expose/);
  const calls = f.remote.calls.length;
  await f.report();
  assert.equal(f.remote.calls.length, calls);
  const absent = await f.report("90");
  assert.equal(absent.status, "error");
  assert.equal(absent.totals.views, null);
});

test("statistics settings cannot be overwritten concurrently or bypass counter validation", async (t) => {
  const f = await fixture(t);
  await f.connect();
  const initial = (await (await f.api("/statistics/sites")).json()).sites.find(
    (s) => s.id === "nwd",
  );
  const value = {
    ...initial.settings,
    counterIds: ["114341229"],
    articlePrefixes: ["/zhurnal/"],
    includeSubdomains: false,
  };
  assert.equal(
    (await f.api("/statistics/sites/nwd", "PATCH", value)).status,
    200,
  );
  assert.equal(
    (await f.api("/statistics/sites/nwd", "PATCH", value)).status,
    409,
  );
  assert.equal(
    (
      await f.api("/statistics/sites/nwd", "PATCH", {
        ...value,
        version: value.version + 1,
        articlePrefixes: ["/x/../../"],
      })
    ).status,
    400,
  );
});

test("Metrika request queue reserves at most two slots and redacts provider errors", async () => {
  const fixture = metrikaFixture();
  fixture.state.delay = 8;
  const client = new MetrikaClient({ fetcher: fixture.fetcher });
  await Promise.all(Array.from({ length: 8 }, () => client.counters(oauth)));
  assert.ok(fixture.state.maxActive <= 2);
  const failed = new MetrikaClient({
    fetcher: async () => Response.json({ token: oauth }, { status: 401 }),
  });
  await assert.rejects(
    () => failed.counters(oauth),
    (e) => e.status === 403 && !e.message.includes(oauth),
  );
});

test("statistics persists a coherent snapshot across restart and refreshes at Moscow midnight", async (t) => {
  const f = await fixture(t);
  await f.connect();
  const initial = await f.report("30");
  const calls = f.remote.calls.length;
  const { createStatisticsModule } =
    await import("../server/modules/statistics/index.js");
  const restarted = await createStatisticsModule(f.app.locals.db, {
    dataDir: f.directory,
    now: f.now,
    statisticsFetch: f.remote.fetcher,
  });
  const recovered = await restarted.report("nwd", "30");
  assert.deepEqual(recovered, initial);
  assert.equal(f.remote.calls.length, calls);
  f.advance(Date.parse("2026-11-19T20:59:20Z") - f.now());
  const before = await f.report("30");
  const beforeCalls = f.remote.calls.length;
  f.advance(80000);
  const after = await f.report("30");
  assert.notEqual(after.period.from, before.period.from);
  assert.ok(f.remote.calls.length > beforeCalls);
  assert.equal(after.period.to, "2026-11-19T21:00:00.000Z");
});

test("statistics refuses a report whose configuration changed during collection", async (t) => {
  const f = await fixture(t);
  await f.connect();
  f.remote.state.delay = 30;
  const collecting = f.app.locals.statistics.report("nwd", "24h");
  await new Promise((r) => setTimeout(r, 10));
  f.app.locals.db
    .prepare(
      "UPDATE statistics_settings SET version=version+1 WHERE site_id='nwd'",
    )
    .run();
  const report = await collecting;
  assert.equal(report.status, "error");
  assert.equal(report.totals.visits, null);
  assert.equal(
    f.app.locals.db
      .prepare("SELECT count(*) amount FROM statistics_cache")
      .get().amount,
    0,
  );
});
