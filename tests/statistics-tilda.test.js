import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { webcrypto, randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/auth.js";
import { createStatisticsModule } from "../server/modules/statistics/index.js";

const password = "tilda-counter-fixture-password",
  group = "https://boykovgroup.ru",
  lab = "https://elektrolaboratoriya-techotchet.ru";
const start = Date.parse("2026-11-23T07:12:50Z");
const event = (overrides = {}) => ({
  eventId: randomUUID(),
  sessionId: randomUUID(),
  path: "/",
  source: "direct",
  ...overrides,
});
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "boykov-tilda-statistics-"));
  let clock = start;
  const app = await createApp({
    dataDir: dir,
    passwordHash: await hashPassword(password),
    secureCookies: false,
    allowedOrigins: [],
    now: () => clock,
    worker: async () => Response.json({ ok: true, jobs: [] }),
    isConfigured: () => false,
  });
  const db = app.locals.db;
  db.prepare(
    "INSERT INTO sales_sites(id,host,name,created_at,delivery_mode) VALUES(?,?,?,?,?)",
  ).run(
    "lab",
    "elektrolaboratoriya-techotchet.ru",
    "Лаборатория",
    new Date(clock).toISOString(),
    "tilda",
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
    await rm(dir, { recursive: true, force: true });
  });
  const post = (value, origin = group, headers = {}) =>
    fetch(base + "/hooks/tilda-statistics/view", {
      method: "POST",
      headers: {
        Origin: origin,
        "User-Agent": "Mozilla/5.0 fixture",
        "Content-Type": "text/plain",
        ...headers,
      },
      body: JSON.stringify(value),
    });
  return {
    app,
    db,
    base,
    dir,
    post,
    now: () => clock,
    advance: (ms) => (clock += ms),
    api: (route, auth = true) =>
      fetch(base + "/api/statistics" + route, {
        headers: { Cookie: auth ? cookie : "" },
      }),
  };
}

test("Tilda counter is served without a staff session and accepts only the configured website origins and event format", async (t) => {
  const f = await fixture(t);
  const js = await fetch(f.base + "/hooks/tilda-statistics/counter.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);
  assert.match(await js.text(), /boykov_tilda_statistics_session_v1/);
  const e = event();
  const res = await f.post(e);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("access-control-allow-origin"), group);
  assert.equal(res.headers.get("access-control-allow-credentials"), null);
  assert.equal((await res.json()).eventId, e.eventId);
  assert.equal((await f.post(e, "https://www.boykovgroup.ru")).status, 200);
  assert.equal((await f.post(event(), lab)).status, 201);
  assert.equal((await f.api("/overview?period=7", false)).status, 401);
  assert.equal((await f.post(event(), "https://example.invalid")).status, 403);
  assert.equal(
    (await f.post(event({ path: "/contact?private=1" }))).status,
    400,
  );
  assert.equal(
    (await f.post(event({ email: "private@example.invalid" }))).status,
    400,
  );
  assert.equal(
    (await f.post(event(), group, { "Content-Type": "application/json" }))
      .status,
    415,
  );
  const ignored = await f.post(event(), group, { DNT: "1" });
  assert.equal((await ignored.json()).ignored, true);
  assert.equal(
    (
      await (
        await f.post(event(), group, { "User-Agent": "Example crawler" })
      ).json()
    ).ignored,
    true,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM statistics_tilda_views").get().n,
    2,
  );
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sales_leads").get().n, 0);
});

test("Tilda live reports preserve historical leads, separate sites, deduplicate pageviews and start a new visit after inactivity", async (t) => {
  const f = await fixture(t),
    e = event({ source: "utm:search" });
  // Existing lead records remain authoritative, including ones before analytics installation.
  f.db
    .prepare(
      "INSERT INTO sales_leads(id,site_id,event_id,payload_hash,payload,search_text,created_at,received_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "lead",
      "boykovgroup",
      "lead-event",
      "hash",
      "{}",
      "",
      new Date(start - 86400000).toISOString(),
      new Date(start).toISOString(),
      new Date(start).toISOString(),
    );
  assert.equal(
    (await (await f.api("/report?site=boykovgroup&period=7")).json()).totals
      .views,
    null,
  );
  assert.equal((await f.post(e)).status, 201);
  assert.equal((await f.post(e)).status, 200);
  f.advance(120000);
  assert.equal(
    (
      await f.post(
        event({
          sessionId: e.sessionId,
          path: "/services/",
          source: "internal",
        }),
      )
    ).status,
    201,
  );
  assert.equal((await f.post(event(), lab)).status, 201);
  f.advance(1800000);
  assert.equal(
    (await f.post(event({ sessionId: e.sessionId, source: "ref:example.org" })))
      .status,
    201,
  );
  f.advance(60000);
  for (const key of ["24h", "7", "30", "90"]) {
    const r = await (
      await f.api(`/report?site=boykovgroup&period=${key}`)
    ).json();
    assert.equal(r.status, "ready");
    assert.equal(r.totals.views, 3);
    assert.equal(r.totals.visits, 2);
    assert.equal(r.totals.articles, null);
    assert.equal(r.coverageFrom, new Date(start).toISOString());
    assert.equal(r.daily[0].views, null);
    assert.deepEqual(
      r.sources.map((x) => x.visits),
      [1, 1],
    );
    assert.equal(
      r.pages.reduce((n, p) => n + p.views, 0),
      3,
    );
    if (key !== "24h") assert.equal(r.totals.leads, 1);
  }
  const o = await (await f.api("/overview?period=7")).json();
  assert.equal(o.sites.find((s) => s.id === "lab").totals.views, 1);
  assert.equal(o.sites.find((s) => s.id === "boykovgroup").totals.views, 3);
  assert.equal(o.sites.find((s) => s.id === "nwd").totals.views, null);
  const check = await createStatisticsModule(f.db, { now: f.now });
  assert.equal(check.report("boykovgroup", "7").totals.views, 3);
  // The connection survives a process restart because it has no in-memory analytics state.
  const copy = new DatabaseSync(join(f.dir, "platform.sqlite"));
  try {
    const module = await createStatisticsModule(copy, { now: f.now });
    assert.equal(module.report("boykovgroup", "7").totals.visits, 2);
  } finally {
    copy.close();
  }
});

test("Tilda accepts repeated acknowledgements at the rate ceiling without creating new visits", async (t) => {
  const f = await fixture(t);
  const e = event();
  assert.equal((await f.post(e)).status, 201);
  f.db
    .prepare(
      "UPDATE statistics_tilda_budget SET minute_count=300 WHERE site_id='boykovgroup'",
    )
    .run();
  assert.equal((await f.post(e)).status, 200);
  assert.equal((await f.post(event())).status, 429);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM statistics_tilda_views").get().n,
    1,
  );
  f.advance(60000);
  assert.equal((await f.post(event())).status, 201);
});

const source = await readFile(
  new URL("../server/modules/statistics/tilda-counter.js", import.meta.url),
  "utf8",
);
async function browser({
  data = new Map(),
  ack = true,
  dnt = false,
  hidden = false,
  hostname = "boykovgroup.ru",
} = {}) {
  const sent = [],
    events = {};
  const document = {
    visibilityState: hidden ? "hidden" : "visible",
    referrer: "https://example.org/secret?contact=private",
    addEventListener: (n, f) => (events[n] = f),
    removeEventListener: (n) => delete events[n],
  };
  const window = {
    crypto: webcrypto,
    addEventListener: (n, f) => (events[n] = f),
  };
  const context = {
    window,
    crypto: webcrypto,
    document,
    navigator: { doNotTrack: dnt ? "1" : "0" },
    location: new URL(
      `https://${hostname}/services/?utm_source=mail&email=private@example.invalid`,
    ),
    localStorage: {
      getItem: (k) => data.get(k),
      setItem: (k, v) => data.set(k, v),
    },
    URL,
    Map,
    Date,
    Number,
    AbortSignal,
    setTimeout: () => 1,
    clearTimeout: () => {},
    fetch: async (url, options) => {
      const e = JSON.parse(options.body);
      sent.push({ e, credentials: options.credentials });
      assert.equal(
        url,
        "https://boykov-services.ru/hooks/tilda-statistics/view",
      );
      return {
        ok: ack,
        json: async () =>
          ack ? { ok: true, eventId: e.eventId } : { ok: false },
      };
    },
  };
  runInNewContext(source, context);
  await new Promise((r) => setImmediate(r));
  return { sent, data, events, document, context };
}
test("Tilda browser counter excludes DNT and other hosts; visible pageviews retry with unchanged IDs and omit query data and credentials", async () => {
  assert.equal((await browser({ dnt: true })).sent.length, 0);
  assert.equal((await browser({ hostname: "example.invalid" })).sent.length, 0);
  const hidden = await browser({ hidden: true });
  assert.equal(hidden.sent.length, 0);
  hidden.document.visibilityState = "visible";
  hidden.events.visibilitychange();
  await new Promise((r) => setImmediate(r));
  assert.equal(hidden.sent.length, 1);
  const first = await browser({ ack: false });
  assert.equal(first.sent.length, 1);
  assert.equal(first.sent[0].credentials, "omit");
  assert.doesNotMatch(JSON.stringify(first.sent), /private|email=/);
  const second = await browser({ data: first.data });
  assert.equal(second.sent.length, 2);
  assert.equal(second.sent[0].e.eventId, first.sent[0].e.eventId);
  assert.equal(second.sent[1].e.sessionId, first.sent[0].e.sessionId);
  assert.equal(second.data.get("boykov_tilda_statistics_pending_v1"), "[]");
  runInNewContext(source, second.context);
  await new Promise((r) => setImmediate(r));
  assert.equal(second.sent.length, 2);
});
