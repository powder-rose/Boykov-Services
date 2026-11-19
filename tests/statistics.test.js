import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/auth.js";
import { createStatisticsModule } from "../server/modules/statistics/index.js";
import {
  NativeReportBuilder,
  reportPeriod,
  cleanPath,
} from "../shared/statistics.js";
import {
  collectAccessibility,
  collectSecurity,
} from "../integrations/statistics/collect.mjs";
import {
  runNativeCycle,
  statisticsEndpoint,
} from "../integrations/statistics/agent.mjs";
const password = "native-statistics-fixture-password",
  passwordHash = await hashPassword(password),
  key = "d".repeat(64),
  nowValue = Date.parse("2026-11-19T13:34:50Z");
function packet(now = nowValue, host = "nwdelectricity.ru", kind = "nwd") {
  const b = new NativeReportBuilder({ host, kind, now });
  const end = b.frames[0].range.end;
  for (let i = 0; i < 4; i++)
    b.record("visits", end - (i + 1) * 3600000, {
      source: i === 0 ? "ref:yandex.ru" : "direct",
    });
  for (let i = 0; i < 7; i++)
    b.record("views", end - (i + 1) * 3600000, {
      path: i % 2 ? "/" : "/zhurnal/test/",
      title: i % 2 ? undefined : "Тестовая статья",
    });
  b.record("leads", end - 60000);
  return b.packet();
}
async function fixture(t) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "boykov-native-statistics-"),
  );
  let clock = nowValue;
  const app = await createApp({
    dataDir: directory,
    passwordHash,
    secureCookies: false,
    allowedOrigins: [],
    now: () => clock,
    statisticsFetch: () => {
      throw Error("NO_EXTERNAL_STATISTICS_ALLOWED");
    },
    worker: async () => Response.json({ jobs: [], ok: true }),
    isConfigured: () => false,
  });
  const db = app.locals.db;
  db.prepare("UPDATE sales_sites SET token_hash=? WHERE id='nwd'").run(
    createHash("sha256").update(key).digest("hex"),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Boykov-Request": "1" },
    body: JSON.stringify({ password }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  t.after(async () => {
    await new Promise((r) => server.close(r));
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    app,
    db,
    directory,
    now: () => clock,
    advance: (ms) => (clock += ms),
    post: (value, token = key, site = "nwd") =>
      fetch(base + "/hooks/statistics/" + site, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify(value),
      }),
    api: (route, auth = true, method = "GET", body) =>
      fetch(base + "/api/statistics" + route, {
        method,
        headers: {
          Cookie: auth ? cookie : "",
          "Content-Type": "application/json",
          "X-Boykov-Request": "1",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
  };
}
test("native statistics uses exact rolling 24 hours and Moscow calendar boundaries", () => {
  const r = reportPeriod("24h", nowValue);
  assert.equal(r.end - r.start, 86400000);
  assert.equal(r.buckets.length, 25);
  assert.equal(r.buckets[0].from, r.start);
  assert.equal(r.buckets.at(-1).to, r.end);
  assert.equal(
    reportPeriod("7", Date.parse("2026-01-01T00:21:00Z")).from,
    "2025-12-25T21:00:00.000Z",
  );
  assert.throws(() => reportPeriod("365", nowValue));
  assert.equal(cleanPath("/test/?email=private#hash"), "/test/");
  assert.equal(cleanPath("//attacker.invalid/"), null);
  assert.equal(cleanPath("/\\attacker.invalid/"), null);
});
test("native reports remain private and do not require a Metrika connection", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api("/sites", false)).status, 401);
  const sites = await f.api("/sites");
  assert.equal(sites.headers.get("cache-control"), "private, no-store");
  assert.equal((await sites.json()).canConfigure, false);
  const report = await (await f.api("/report?site=nwd&period=24h")).json();
  assert.equal(report.status, "unconfigured");
  assert.equal(report.totals.visits, null);
  assert.equal(report.leadsOrigin, "hub");
  assert.equal(
    (await f.api("/connection", true, "POST", { token: "unused" })).status,
    404,
  );
});
test("native ingestion validates source credentials and host identity before storing reports", async (t) => {
  const f = await fixture(t),
    p = packet();
  assert.equal((await f.post(p, "e".repeat(64))).status, 401);
  assert.equal((await f.post(p, key, "unknown")).status, 401);
  assert.equal((await f.post({ ...p, host: "attacker.invalid" })).status, 400);
  assert.equal((await f.post({ ...p, source: "security" })).status, 400);
  assert.equal(
    f.db.prepare("SELECT count(*) amount FROM statistics_native_reports").get()
      .amount,
    0,
  );
});
test("native ingestion commits all four coherent reports and uses source-side lead totals", async (t) => {
  const f = await fixture(t),
    p = packet(),
    r = await f.post(p);
  assert.equal(r.status, 201, await r.clone().text());
  const ack = await r.json();
  assert.equal(ack.generatedAt, p.generatedAt);
  assert.equal(
    f.db.prepare("SELECT count(*) amount FROM statistics_native_reports").get()
      .amount,
    4,
  );
  const report = await (await f.api("/report?site=nwd&period=24h")).json();
  assert.equal(report.status, "ready");
  assert.deepEqual(report.totals, {
    visits: 4,
    views: 7,
    articles: 4,
    leads: 1,
  });
  assert.equal(report.leadsOrigin, "native");
  assert.equal(
    f.db.prepare("SELECT count(*) amount FROM sales_leads").get().amount,
    0,
  );
  assert.equal(
    report.daily.reduce((n, p) => n + p.leads, 0),
    1,
  );
  assert.equal(report.pages[0].url, "https://nwdelectricity.ru/zhurnal/test/");
  assert.ok(!JSON.stringify(report).includes(key));
});
test("native retries are idempotent, conflicts and older packets cannot replace a fresh snapshot", async (t) => {
  const f = await fixture(t),
    p = packet();
  await f.post(p);
  assert.equal((await (await f.post(p)).json()).duplicate, true);
  const conflict = structuredClone(p);
  conflict.reports[0].articles[0].title = "Другой заголовок";
  assert.equal((await f.post(conflict)).status, 409);
  const older = packet(nowValue - 60000);
  assert.equal((await (await f.post(older)).json()).ignored, true);
  assert.equal(
    f.app.locals.statistics.report("nwd", "24h").fetchedAt,
    p.generatedAt,
  );
  f.advance(60000);
  const newer = packet(f.now());
  assert.equal((await f.post(newer)).status, 201);
  assert.equal(
    f.app.locals.statistics.report("nwd", "24h").fetchedAt,
    newer.generatedAt,
  );
});
test("incomplete reports, inconsistent totals, unsafe paths and future frames do not damage saved data", async (t) => {
  const f = await fixture(t),
    p = packet();
  await f.post(p);
  const changes = [
    (v) => v.reports.pop(),
    (v) => (v.reports[0].daily[0] = null),
    (v) => (v.reports[0].sources[0] = null),
    (v) => (v.reports[0].pages[0] = null),
    (v) => v.reports[0].totals.views++,
    (v) => (v.reports[0].pages[0].path = "//attacker.invalid/"),
    (v) => (v.reports[0].daily[0].at = "2020-01-01T00:00:00.000Z"),
    (v) => (v.reports[0].daily[0].visits = -1),
    (v) => (v.generatedAt = new Date(nowValue + 3600000).toISOString()),
  ];
  for (const change of changes) {
    const input = structuredClone(p);
    change(input);
    assert.equal((await f.post(input)).status, 400);
  }
  assert.equal(f.app.locals.statistics.report("nwd", "24h").totals.views, 7);
});
test("native snapshots survive application restart and stale reports preserve their original interval and figures", async (t) => {
  const f = await fixture(t),
    p = packet();
  await f.post(p);
  const before = f.app.locals.statistics.report("nwd", "24h");
  f.advance(240000);
  const restarted = await createStatisticsModule(f.db, { now: f.now });
  const after = restarted.report("nwd", "24h");
  assert.equal(after.status, "stale");
  assert.deepEqual(after.period, before.period);
  assert.deepEqual(after.totals, before.totals);
});
async function accessibilityDatabase(directory) {
  const file = path.join(directory, "site.sqlite"),
    db = new DatabaseSync(file);
  db.exec(
    `CREATE TABLE analytics_visits(id TEXT,started_at INTEGER,source TEXT);CREATE TABLE analytics_pageviews(id TEXT,visit_id TEXT,path TEXT,created_at INTEGER);CREATE TABLE leads(id TEXT,created_at TEXT);CREATE TABLE articles(slug TEXT,payload TEXT);`,
  );
  const r = reportPeriod("24h", nowValue);
  db.prepare("INSERT INTO articles VALUES(?,?)").run(
    "test",
    JSON.stringify({ title: "Материал сайта" }),
  );
  for (const [i, time] of [r.start - 1, r.start, r.end - 1, r.end].entries()) {
    db.prepare("INSERT INTO analytics_visits VALUES(?,?,?)").run(
      "v" + i,
      time,
      "ref:yandex.ru",
    );
    db.prepare("INSERT INTO analytics_pageviews VALUES(?,?,?,?)").run(
      "p" + i,
      "v" + i,
      "/blog/test/",
      time,
    );
    db.prepare("INSERT INTO leads VALUES(?,?)").run(
      "l" + i,
      new Date(time).toISOString(),
    );
  }
  db.close();
  return file;
}
test("Accessibility adapter reads native SQLite events consistently, including hour edges and article aliases", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "native-pd-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await accessibilityDatabase(dir);
  const value = collectAccessibility({ sourceFile: file, now: nowValue })
    .reports[0];
  assert.deepEqual(value.totals, {
    visits: 2,
    views: 2,
    articles: 2,
    leads: 2,
  });
  assert.equal(value.articles[0].title, "Материал сайта");
  assert.equal(value.sources[0].name, "yandex.ru");
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) amount FROM leads").get().amount, 4);
  db.close();
});
test("Security adapter preserves native visit bot filtering and never invents missing pageviews", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "native-pb-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const visits = path.join(dir, "visits.jsonl"),
    leads = path.join(dir, "leads.jsonl"),
    date = new Date(nowValue - 60000).toISOString();
  await writeFile(
    visits,
    [
      {
        receivedAt: date,
        referrer: "https://yandex.ru/search?secret=private",
        meta: { userAgent: "Mozilla/5.0 Firefox/120" },
      },
      { receivedAt: date, meta: { userAgent: "Googlebot" } },
      { receivedAt: date, meta: { userAgent: "" } },
    ]
      .map(JSON.stringify)
      .join("\n") + '\n{"partial":',
  );
  await writeFile(leads, JSON.stringify({ receivedAt: date }) + "\n");
  const value = (
    await collectSecurity({
      sourceFile: visits,
      leadsFile: leads,
      now: nowValue,
    })
  ).reports[0];
  assert.deepEqual(value.totals, {
    visits: 1,
    views: null,
    articles: null,
    leads: 1,
  });
  assert.equal(value.sources[0].name, "yandex.ru");
  assert.equal(value.pages.length, 0);
  assert.ok(!JSON.stringify(value).includes("secret"));
});
test("native delivery retains a complete packet for retries and requires a matching server acknowledgement", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "native-delivery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sourceFile = await accessibilityDatabase(dir),
    stateDir = path.join(dir, "state");
  const config = {
    kind: "accessibility",
    host: "pasport-dostupnosty.ru",
    sourceFile,
    stateDir,
    leadsEndpoint: "https://boykov-services.ru/hooks/leads/accessibility",
    token: key,
  };
  let received;
  const fetcher = async (url, options) => {
    assert.equal(
      url,
      "https://boykov-services.ru/hooks/statistics/accessibility",
    );
    assert.equal(options.headers.Authorization, "Bearer " + key);
    assert.equal(options.redirect, "error");
    received = JSON.parse(options.body);
    return Response.json({
      ok: true,
      siteId: "accessibility",
      generatedAt: received.generatedAt,
    });
  };
  assert.equal(
    (await runNativeCycle(config, { fetcher, now: nowValue })).ok,
    true,
  );
  await rm(sourceFile);
  assert.equal(
    (await runNativeCycle(config, { fetcher, now: nowValue + 240000 })).ok,
    false,
  );
  assert.equal(
    received.generatedAt,
    new Date(Math.floor(nowValue / 60000) * 60000).toISOString(),
  );
  await assert.rejects(() =>
    runNativeCycle(config, {
      fetcher: async () => Response.json({ ok: true, siteId: "wrong" }),
      now: nowValue,
    }),
  );
  assert.ok(
    JSON.parse(await readFile(path.join(stateDir, "last-packet.json"), "utf8"))
      .reports.length === 4,
  );
  assert.throws(() =>
    statisticsEndpoint("https://attacker@boykov-services.ru/hooks/leads/nwd"),
  );
  assert.throws(() =>
    statisticsEndpoint("http://boykov-services.ru/hooks/leads/nwd"),
  );
});

test(
  "NWD adapter executes the native MySQL aggregation with exact hour boundaries and source trash rules",
  { skip: !process.env.NATIVE_TEST_MYSQL_PORT },
  async () => {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(
      process.env.PHP_BIN || "php",
      ["tests/helpers/statistics-nwd-fixture.php"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout),
      r = value.reports[0];
    assert.deepEqual(r.totals, { visits: 2, views: 2, articles: 2, leads: 2 });
    assert.equal(r.daily.length, 25);
    assert.equal(r.sources[0].name, "yandex.ru");
    assert.equal(r.articles[0].title, "Статья редакции");
    const { validateNativePacket } =
      await import("../server/modules/statistics/validation.js");
    assert.equal(
      validateNativePacket(value, { host: "nwdelectricity.ru" }, nowValue)
        .reports.length,
      4,
    );
  },
);

test("native source list reflects delivered reports and renaming a domain does not inherit its old traffic", async (t) => {
  const f = await fixture(t);
  assert.equal(
    f.app.locals.statistics.list().find((s) => s.id === "nwd").connected,
    false,
  );
  const p = packet();
  await f.post(p);
  const listed = (await (await f.api("/sites")).json()).sites.find(
    (s) => s.id === "nwd",
  );
  assert.equal(listed.connected, true);
  assert.equal(listed.lastSyncedAt, p.generatedAt);
  f.db
    .prepare("UPDATE sales_sites SET host='renamed.invalid' WHERE id='nwd'")
    .run();
  assert.equal(
    f.app.locals.statistics.list().find((s) => s.id === "nwd").connected,
    false,
  );
  assert.equal(
    f.app.locals.statistics.report("nwd", "24h").status,
    "unconfigured",
  );
});

test("Security installer resolves the real dotenv file and project root with process-level precedence", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const python = process.env.PYTHON_BIN || "python3";
  if (spawnSync(python, ["--version"], { encoding: "utf8" }).status !== 0) {
    t.skip("Python 3 is required to check the Linux source installer.");
    return;
  }
  const code = String.raw`import sys,tempfile,pathlib
sys.path.insert(0,str(pathlib.Path('integrations/statistics').resolve()))
from source_config import security_paths
with tempfile.TemporaryDirectory() as directory:
 cwd=pathlib.Path(directory);shared=cwd/'shared';shared.mkdir()
 env=shared/'server.env';env.write_text('PASSPORT_PROJECT_ROOT=shared\nVISITS_FILE=private/visits.jsonl\nLEADS_FILE=private/leads.jsonl\nUNRELATED_SECRET="multiline\n')
 visits,leads=security_paths(cwd,{'SERVER_ENV_FILE':'shared/server.env','LEADS_FILE':'live/leads.jsonl'})
 assert visits==shared/'private/visits.jsonl'
 assert leads==shared/'live/leads.jsonl'
 visits,leads=security_paths(cwd,{'SERVER_ENV_FILE':str(env),'PASSPORT_PROJECT_ROOT':str(shared/'live')},str(shared/'override.jsonl'))
 assert visits==shared/'override.jsonl'
 assert leads==shared/'live/private/leads.jsonl'
print('NATIVE_SOURCE_LOCATION=OK')`;
  const result = spawnSync(python, ["-c", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NATIVE_SOURCE_LOCATION=OK/);
});
