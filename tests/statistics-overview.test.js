import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/auth.js";
import { createStatisticsModule } from "../server/modules/statistics/index.js";
import { NativeReportBuilder, reportPeriod } from "../shared/statistics.js";
import {
  lineSegments,
  seriesPoints,
  totalMetric,
} from "../src/features/statistics-overview/model.ts";
const password = "overview-test-password",
  passwordHash = await hashPassword(password),
  token = "a".repeat(64),
  NOW = Date.parse("2026-11-20T11:01:30Z");
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "statistics-overview-"));
  let clock = NOW;
  const app = await createApp({
    dataDir: dir,
    passwordHash,
    now: () => clock,
    secureCookies: false,
    allowedOrigins: [],
    isConfigured: () => false,
    statisticsFetch: () => {
      throw Error("NO_EXTERNAL_COUNTER");
    },
    worker: async () => Response.json({ jobs: [], ok: true }),
  });
  const db = app.locals.db;
  db.prepare("UPDATE sales_sites SET token_hash=?").run(
    createHash("sha256").update(token).digest("hex"),
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
  const api = (query = "", auth = true) =>
    fetch(base + "/api/statistics/overview" + (query ? "?" + query : ""), {
      headers: { Cookie: auth ? cookie : "" },
    });
  const overview = async (query = "") => {
    const r = await api(query);
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  const post = async (id, builder) => {
    const r = await fetch(base + "/hooks/statistics/" + id, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify(builder.packet()),
    });
    assert.equal(r.status, 201, await r.text());
  };
  const lead = async (id, eventId) => {
    const r = await fetch(base + "/hooks/leads/" + id, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({
        eventId,
        createdAt: new Date(clock - 60000).toISOString(),
        name: "Тест",
        phone: "+79990000000",
      }),
    });
    assert.equal(r.status, 201, await r.text());
  };
  return {
    db,
    app,
    api,
    overview,
    post,
    lead,
    now: () => clock,
    setNow: (value) => {
      clock = value;
    },
  };
}
const builder = (
  host = "nwdelectricity.ru",
  kind = "nwd",
  now = NOW,
  options = {},
) => new NativeReportBuilder({ host, kind, now, ...options });
test("overview is workspace-private, validates periods and never exposes source keys", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api("", false)).status, 401);
  assert.equal((await f.api("period=bad")).status, 400);
  const r = await f.api("period=7");
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  const data = await r.json();
  assert.equal(
    data.sites.length,
    f.db.prepare("SELECT count(*) n FROM sales_sites").get().n,
  );
  assert.equal(data.period.key, "7");
  assert.ok(!JSON.stringify(data).includes(token));
  assert.equal(totalMetric(data.sites, "visits").value, null);
  assert.equal(totalMetric(data.sites, "leads").value, 0);
});
test("overview totals use native counts once, retaining hub-only leads for unconnected sites", async (t) => {
  const f = await fixture(t),
    nwd = builder();
  nwd.record("visits", NOW - 3600000);
  nwd.record("views", NOW - 3600000, { path: "/" });
  nwd.record("leads", NOW - 60000);
  nwd.record("leads", NOW - 120000);
  await f.post("nwd", nwd);
  await f.lead("nwd", "native-mirror");
  await f.lead("accessibility", "hub-only");
  const data = await f.overview(),
    n = data.sites.find((s) => s.id === "nwd"),
    a = data.sites.find((s) => s.id === "accessibility");
  assert.equal(n.leadsOrigin, "native");
  assert.equal(n.totals.leads, 2);
  assert.equal(a.leadsOrigin, "hub");
  assert.equal(a.totals.leads, 1);
  assert.equal(totalMetric(data.sites, "leads").value, 3);
  assert.equal(totalMetric(data.sites, "visits").value, 1);
  assert.equal(
    n.points.reduce((sum, p) => sum + p.visits, 0),
    n.totals.visits,
  );
  assert.equal(
    n.points.reduce((sum, p) => sum + p.leads, 0),
    n.totals.leads,
  );
});
test("different source minutes align by Moscow hour rather than array position, with real gaps and exact counts", async (t) => {
  const f = await fixture(t),
    a = builder(),
    b = builder("pasport-dostupnosty.ru", "accessibility", NOW - 120000);
  for (const source of [a, b]) {
    const r = source.frames[0].range;
    source.record("visits", r.start + 1000);
    source.record("visits", r.end - 1000);
  }
  await f.post("nwd", a);
  await f.post("accessibility", b);
  const data = await f.overview("period=24h"),
    n = data.sites.find((s) => s.id === "nwd"),
    other = data.sites.find((s) => s.id === "accessibility");
  assert.equal(data.intervalsDiffer, true);
  assert.equal(data.timeline.length, 26);
  const first = seriesPoints(n, data.timeline, "visits", false),
    second = seriesPoints(other, data.timeline, "visits", false);
  assert.equal(first[0].value, null);
  assert.equal(second[0].value, 1);
  assert.equal(second.at(-1).value, null);
  assert.equal(
    first.filter((p) => p.value !== null).reduce((sum, p) => sum + p.value, 0),
    2,
  );
  const cumulative = seriesPoints(other, data.timeline, "visits", true);
  assert.equal(cumulative.filter((p) => p.value !== null).at(-1).value, 2);
  assert.equal(cumulative.at(-1).value, null);
  assert.ok(n.points[0].partial);
  assert.equal(n.sourcePeriod.from, a.packet().reports[0].period.from);
});
test("stale sources are explicitly excluded from the common totals while the separate report remains available", async (t) => {
  const f = await fixture(t),
    a = builder();
  a.record("visits", NOW - 3600000);
  await f.post("nwd", a);
  f.setNow(NOW + 181000);
  const fresh = builder("pasport-bezopasnosty.ru", "security", f.now(), {
    views: false,
    articles: false,
  });
  fresh.record("visits", f.now() - 3600000);
  fresh.record("visits", f.now() - 3600000);
  await f.post("security", fresh);
  const data = await f.overview(),
    stale = data.sites.find((s) => s.id === "nwd");
  assert.equal(stale.status, "stale");
  assert.equal(stale.totals.visits, null);
  assert.deepEqual(stale.points, []);
  assert.equal(totalMetric(data.sites, "visits").value, 2);
  assert.equal(f.app.locals.statistics.report("nwd", "24h").totals.visits, 1);
});
test("site colors persist after rename, additions and reopening the statistics module", async (t) => {
  const f = await fixture(t),
    before = await f.overview();
  const colors = new Map(before.sites.map((s) => [s.id, s.color]));
  f.db.prepare("UPDATE sales_sites SET name=? WHERE id=?").run("ААА", "nwd");
  f.db
    .prepare("INSERT INTO sales_sites(id,name,host,created_at) VALUES(?,?,?,?)")
    .run("new-site", "АА", "another.example", new Date(NOW).toISOString());
  const again = await createStatisticsModule(f.db, { now: f.now });
  const after = again.overview("7");
  for (const s of after.sites)
    if (colors.has(s.id)) assert.equal(s.color, colors.get(s.id));
  assert.equal(
    new Set(after.sites.map((s) => s.color)).size,
    before.sites.length + 1,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM statistics_site_colors").get().n,
    before.sites.length + 1,
  );
});
test("Moscow date rollover does not mix yesterday calendar reports into a new seven-day overview", async (t) => {
  const f = await fixture(t);
  f.setNow(Date.parse("2026-11-20T20:59:30Z"));
  const b = builder("nwdelectricity.ru", "nwd", f.now());
  b.record("visits", f.now() - 10000);
  await f.post("nwd", b);
  f.setNow(f.now() + 120000);
  const data = await f.overview("period=7");
  const n = data.sites.find((s) => s.id === "nwd");
  assert.equal(n.status, "stale");
  assert.equal(n.totals.visits, null);
  assert.equal(data.period.from, reportPeriod("7", f.now()).from);
});
test("unsupported metrics remain unavailable while an observed zero remains a genuine zero", async (t) => {
  const f = await fixture(t),
    b = builder("pasport-bezopasnosty.ru", "security", NOW, {
      views: false,
      articles: false,
    });
  await f.post("security", b);
  const data = await f.overview(),
    s = data.sites.find((s) => s.id === "security");
  assert.equal(s.totals.visits, 0);
  assert.equal(s.totals.views, null);
  assert.deepEqual(totalMetric([s], "visits"), {
    value: 0,
    available: 1,
    total: 1,
  });
  assert.deepEqual(totalMetric([s], "views"), {
    value: null,
    available: 0,
    total: 1,
  });
  assert.equal(
    seriesPoints(s, data.timeline, "views", false).every(
      (p) => p.value === null,
    ),
    true,
  );
  assert.equal(totalMetric([], "visits").value, null);
});
test("a corrupted saved source report is isolated and cannot remove other sites from the overview", async (t) => {
  const f = await fixture(t),
    a = builder(),
    b = builder("pasport-dostupnosty.ru", "accessibility");
  a.record("visits", NOW - 60000);
  b.record("visits", NOW - 60000);
  await f.post("nwd", a);
  await f.post("accessibility", b);
  f.db
    .prepare(
      "UPDATE statistics_native_reports SET report='{' WHERE site_id='nwd'",
    )
    .run();
  const data = await f.overview();
  assert.equal(data.sites.find((s) => s.id === "nwd").status, "error");
  assert.equal(totalMetric(data.sites, "visits").value, 1);
  assert.ok(!JSON.stringify(data).includes("SyntaxError"));
});
test("chart gaps split lines and selection totals do not silently include hidden sites", () => {
  const segments = lineSegments([
    { value: 2 },
    { value: null },
    { value: 0 },
    { value: 3 },
    { value: null },
  ]);
  assert.deepEqual(segments, [[{ value: 2 }], [{ value: 0 }, { value: 3 }]]);
  const a = { totals: { visits: 3, views: 5, articles: null, leads: 1 } },
    b = { totals: { visits: 100, views: 200, articles: 0, leads: 0 } };
  assert.equal(totalMetric([a], "visits").value, 3);
  assert.equal(totalMetric([a, b], "visits").value, 103);
});
