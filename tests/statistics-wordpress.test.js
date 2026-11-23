import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { webcrypto, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { NativeReportBuilder, reportPeriod } from "../shared/statistics.js";
import { validateNativePacket } from "../server/modules/statistics/validation.js";
import { createStatisticsModule } from "../server/modules/statistics/index.js";
const clock = Date.parse("2026-11-20T13:34:50Z");
const php = process.env.PHP_BIN || "php";
const probe = spawnSync(
  php,
  ["-r", "echo PHP_VERSION_ID.':'.(int)extension_loaded('pdo_sqlite');"],
  { encoding: "utf8" },
);
const available =
  probe.status === 0 && Number(probe.stdout?.split(":")[0]) >= 70300;
const sqlite = available && probe.stdout.trim().endsWith(":1");
const fixture = fileURLToPath(
  new URL("./helpers/wordpress-fixture.php", import.meta.url),
);
test(
  "WordPress keeps lead capture available when the optional statistics module cannot load or initialize",
  { skip: !available },
  async (t) => {
    const root = await mkdtemp(
      path.join(tmpdir(), "boykov-wordpress-isolation-"),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    await cp(
      fileURLToPath(
        new URL(
          "../integrations/leads/wordpress/boykov-leads",
          import.meta.url,
        ),
      ),
      root,
      { recursive: true },
    );
    const entry = path.join(root, "boykov-leads.php"),
      module = path.join(root, "includes/statistics.php");
    const call = (brokenDatabase = false) => {
      const r = spawnSync(php, [fixture, "statistics-isolation"], {
        encoding: "utf8",
        env: { ...process.env, WP_FIXTURE_PLUGIN_PATH: entry },
        input: JSON.stringify({ brokenDatabase }),
      });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      return JSON.parse(r.stdout);
    };
    assert.deepEqual(call(), { leads: true, statistics: true, error: null });
    assert.deepEqual(call(true), {
      leads: true,
      statistics: true,
      error: "STATISTICS_MODULE_UNAVAILABLE",
    });
    await writeFile(module, "<?php function invalid_fixture( {", "utf8");
    assert.deepEqual(call(), {
      leads: true,
      statistics: false,
      error: "STATISTICS_MODULE_UNAVAILABLE",
    });
    await rm(module);
    assert.deepEqual(call(), {
      leads: true,
      statistics: false,
      error: "STATISTICS_MODULE_UNAVAILABLE",
    });
  },
);
function run(mode, extra = {}) {
  const r = spawnSync(php, [fixture, mode], {
    encoding: "utf8",
    input: JSON.stringify({ now: Math.floor(clock / 1000), ...extra }),
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return JSON.parse(r.stdout);
}
function packet() {
  const b = new NativeReportBuilder({
    host: "energo-365.ru",
    kind: "wordpress",
    now: clock,
  });
  b.record("views", clock - 120000, { path: "/post/" });
  b.record("visits", clock - 120000, { source: "direct" });
  b.record("leads", clock - 5 * 86400000);
  return {
    ...b.packet(),
    coverageFrom: new Date(clock - 180000).toISOString(),
  };
}
test(
  "WordPress validates signed cached-page metadata and its session hash without exporting identifiers",
  { skip: !available },
  () => {
    const r = run("statistics-core");
    assert.equal(r.page.path, "/article/");
    assert.equal(r.page.title, "Полезная статья");
    assert.ok(r.errors.every((e) => e !== "accepted"));
    assert.match(r.event.sid, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(r.event), /22222222|private=|<b>/);
    for (const key of ["24h", "7", "30", "90"]) {
      const expected = reportPeriod(key, clock);
      assert.equal(r.periods[key].start * 1000, expected.start);
      assert.equal(r.periods[key].end * 1000, expected.end);
      assert.deepEqual(
        r.periods[key].daily.map((p) => [p.at, p.end]),
        expected.buckets.map((p) => [
          new Date(p.from).toISOString(),
          new Date(p.to).toISOString(),
        ]),
      );
    }
  },
);
for (const mode of ["statistics-ledger", "statistics-mysql"])
  test(
    "WordPress ledger: duplicate/out-of-order views, network isolation, UTC lead dates and rollback (" +
      mode +
      ")",
    {
      skip:
        !available ||
        (mode === "statistics-ledger" && !sqlite) ||
        (mode === "statistics-mysql" &&
          !(
            process.env.WP_TEST_MYSQL_SOCKET || process.env.WP_TEST_MYSQL_PORT
          )),
    },
    () => {
      const r = run(mode);
      assert.equal(r.duplicate, true);
      assert.equal(r.conflict, "STATISTICS_CONFLICT");
      assert.equal(r.missing, "STATISTICS_DATABASE");
      assert.equal(r.rows_before, r.rows_after);
      const normalized = validateNativePacket(
        r.packet,
        { host: "energo-365.ru" },
        clock,
      );
      assert.equal(normalized.reports.length, 4);
      for (const report of normalized.reports) {
        assert.equal(report.totals.views, 4);
        assert.equal(report.totals.visits, 2);
        assert.equal(report.totals.articles, 2);
        assert.equal(report.totals.leads, report.key === "90" ? 2 : 1);
      }
      assert.ok(
        normalized.reports[0].pages.some(
          (p) => p.url === "https://lp.energo-365.ru/same/",
        ),
      );
      assert.ok(
        normalized.reports[0].pages.some(
          (p) => p.url === "https://lp.energo-365.ru/Same/",
        ),
      );
    },
  );
test("WordPress reports keep subdomain page identity, reject foreign hosts and require coverage dates", () => {
  const p = packet();
  p.reports[0].totals.views = 2;
  p.reports[0].daily.find((d) => d.views === 1).views = 2;
  p.reports[0].pages = [
    { host: "energo-365.ru", path: "/", title: "Главная", views: 1 },
    { host: "lp.energo-365.ru", path: "/", title: "Главная", views: 1 },
  ];
  assert.equal(
    validateNativePacket(p, { host: p.host }, clock).reports[0].pages[1].url,
    "https://lp.energo-365.ru/",
  );
  for (const host of [
    "energo-365.ru.attacker.invalid",
    "badenergo-365.ru",
    "-bad.energo-365.ru",
    "evil.invalid",
  ]) {
    const bad = structuredClone(p);
    bad.reports[0].pages[1].host = host;
    assert.throws(() => validateNativePacket(bad, { host: p.host }, clock));
  }
  const missing = structuredClone(p);
  delete missing.coverageFrom;
  assert.throws(() => validateNativePacket(missing, { host: p.host }, clock));
});
test("WordPress hub delivery uses existing keys and hides unknown traffic history without hiding saved leads", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const key = "b".repeat(64);
  db.exec(
    "CREATE TABLE sales_sites(id TEXT,name TEXT,host TEXT,created_at TEXT,token_hash TEXT);CREATE TABLE sales_leads(site_id TEXT,created_at TEXT);",
  );
  db.prepare("INSERT INTO sales_sites VALUES(?,?,?,?,?)").run(
    "energo",
    "Энерго 365",
    "energo-365.ru",
    new Date(clock).toISOString(),
    createHash("sha256").update(key).digest("hex"),
  );
  const mod = await createStatisticsModule(db, { now: () => clock });
  const app = express();
  app.use(express.json());
  app.post("/hooks/statistics/:siteId", mod.receive);
  app.use("/api/statistics", (req, res, next) =>
    req.get("x-test-login") === "1" ? next() : res.sendStatus(401),
  );
  mod.register(app);
  app.use((e, req, res, next) =>
    res.status(e.status || 500).json({ error: e.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  const body = JSON.stringify(packet());
  assert.equal(
    (
      await fetch(base + "/hooks/statistics/energo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      })
    ).status,
    401,
  );
  for (const code of [201, 200]) {
    const r = await fetch(base + "/hooks/statistics/energo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key,
      },
      body,
    });
    assert.equal(r.status, code);
    assert.equal((await r.json()).ok, true);
  }
  const r = await fetch(base + "/api/statistics/report?site=energo&period=7", {
    headers: { "x-test-login": "1" },
  });
  const report = await r.json();
  assert.equal(report.coverageFrom, packet().coverageFrom);
  assert.equal(report.daily[0].visits, null);
  assert.equal(report.totals.leads, 1);
  assert.ok(report.daily.some((d) => d.leads === 1));
  const overview = await (
    await fetch(base + "/api/statistics/overview?period=7", {
      headers: { "x-test-login": "1" },
    })
  ).json();
  assert.equal(overview.sites[0].points[0].views, null);
  assert.ok(overview.sites[0].points.some((d) => d.leads === 1));
});
const script = await readFile(
  new URL(
    "../integrations/leads/wordpress/boykov-leads/assets/boykov-statistics.js",
    import.meta.url,
  ),
  "utf8",
);
async function browser({
  stored = [],
  ack = true,
  dnt = false,
  referrer = "",
  hidden = false,
  token = "public-signed-page",
  cookie = "",
  storageFails = false,
} = {}) {
  const data = new Map([
      ["boykov_statistics_pending_v1", JSON.stringify(stored)],
    ]),
    sent = [],
    events = {};
  let dc = cookie;
  const document = {
    visibilityState: hidden ? "hidden" : "visible",
    referrer,
    addEventListener: (n, f) => (events[n] = f),
    removeEventListener: (n) => delete events[n],
  };
  Object.defineProperty(document, "cookie", {
    get: () => dc,
    set: (v) => {
      dc = v;
    },
  });
  const window = {
    BoykovStatistics: {
      endpoint: "https://lp.energo-365.ru/wp-admin/admin-ajax.php",
      pageToken: token,
    },
    crypto: webcrypto,
    addEventListener: (n, f) => (events[n] = f),
  };
  const context = {
    window,
    document,
    navigator: { doNotTrack: dnt ? "1" : "0" },
    location: new URL(
      "https://lp.energo-365.ru/service/?utm_source=mail&email=private@example.invalid",
    ),
    localStorage: {
      getItem: (k) => data.get(k),
      setItem: (k, v) => {
        if (storageFails) throw Error("storage blocked");
        data.set(k, v);
      },
      removeItem: (k) => data.delete(k),
    },
    URL,
    URLSearchParams,
    Uint8Array,
    AbortSignal,
    Date,
    Number,
    setTimeout: () => 1,
    clearTimeout: () => {},
    fetch: async (url, options) => {
      const payload = Object.fromEntries(options.body);
      sent.push(payload);
      return {
        ok: ack,
        json: async () =>
          ack ? { ok: true, eventId: payload.eventId } : { ok: false },
      };
    },
  };
  runInNewContext(script, context);
  await new Promise((r) => setImmediate(r));
  return { sent, data, events, document, window, context, cookie: () => dc };
}
test("WordPress browser counter persists before sending, retries unchanged events and drains only exact acknowledgements", async () => {
  const first = await browser({ ack: false });
  assert.equal(first.sent.length, 1);
  const pending = JSON.parse(first.data.get("boykov_statistics_pending_v1"));
  assert.equal(pending.length, 1);
  assert.match(first.cookie(), /Domain=energo-365.ru/);
  const second = await browser({ stored: pending });
  assert.equal(second.sent.length, 2);
  assert.equal(second.sent[1].eventId, pending[0].eventId);
  assert.equal(second.data.get("boykov_statistics_pending_v1"), "[]");
  assert.doesNotMatch(
    JSON.stringify(second.sent),
    /private@example|Bearer|hooks\/statistics/,
  );
  assert.equal(second.sent[0].source, "utm:mail");
  const noDisk = await browser({ storageFails: true });
  assert.equal(noDisk.sent.length, 1);
});
test("WordPress browser ignores DNT, waits for visible pages and counts one visit session across subdomains", async () => {
  assert.equal((await browser({ dnt: true })).sent.length, 0);
  const page = await browser({ hidden: true });
  assert.equal(page.sent.length, 0);
  page.document.visibilityState = "visible";
  page.events.visibilitychange();
  await new Promise((r) => setImmediate(r));
  assert.equal(page.sent.length, 1);
  const id = "77777777-7777-4777-8777-777777777777";
  const next = await browser({ cookie: "boykov_statistics_session=" + id });
  assert.equal(next.sent[0].sessionId, id);
  runInNewContext(script, next.context);
  await new Promise((r) => setImmediate(r));
  assert.equal(next.sent.length, 1);
});

test(
  "WordPress schedules one network sender, preserves settings and never acknowledges a partial/failed report",
  { skip: !sqlite },
  () => {
    const r = run("statistics-flow");
    assert.equal(r.failed, "STATISTICS_DELIVERY_UNCONFIRMED");
    assert.equal(r.wrong, "STATISTICS_DELIVERY_UNCONFIRMED");
    assert.equal(r.ok.ok, true);
    assert.equal(r.same_packet, true);
    assert.equal(r.start_unchanged, true);
    assert.equal(r.error_state.last_delivery, undefined);
    assert.ok(r.state.last_delivery);
    assert.equal(r.state.error, "");
    assert.equal(r.other, "STATISTICS_COORDINATOR");
    assert.equal(r.missing, "QUEUE_SCHEMA");
    assert.equal(r.restored_blog, 1);
    assert.ok(r.cron[2].boykov_statistics_delivery_tick);
    assert.equal(r.cron[4].boykov_leads_delivery_tick, 123);
    assert.equal(
      r.request[0],
      "https://boykov-services.ru/hooks/statistics/fixture",
    );
    assert.equal(
      r.request[1].headers.Authorization,
      "Bearer " + "a".repeat(64),
    );
    assert.equal(r.config.token, "a".repeat(64));
    assert.doesNotMatch(
      r.request[1].body,
      /private-customer-fields|"payload"|"email"/,
    );
  },
);

test(
  "WordPress intake commits a signed page but ignores staff/DNT and rejects cross-origin or tampered metadata",
  { skip: !sqlite },
  () => {
    const ok = run("statistics-receive");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.events, 1);
    for (const input of [
      { origin: "https://evil.invalid" },
      { tamper: true },
    ]) {
      const r = run("statistics-receive", input);
      assert.equal(r.status, 400);
      assert.equal(r.events, 0);
    }
    for (const input of [{ dnt: true }, { loggedIn: true }]) {
      const r = run("statistics-receive", input);
      assert.equal(r.body.ignored, true);
      assert.equal(r.events, 0);
    }
  },
);
