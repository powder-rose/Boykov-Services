import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/auth.js";
import {
  collectBoykovDocs,
  runBoykovDocsCycle,
} from "../integrations/statistics/boykovdocs-agent.mjs";
import { docsStatisticsSite, reportPeriod } from "../shared/statistics.js";

const NOW = Date.parse("2026-11-23T07:34:45Z");
const END = reportPeriod("24h", NOW).end;
const MIN = 60000;
const token = "a".repeat(64);
const visitorA = "b".repeat(64),
  visitorB = "c".repeat(64);
const event = (at, visitor = visitorA) =>
  JSON.stringify({
    ts: new Date(at).toISOString(),
    day: new Date(at + 3 * 3600000).toISOString().slice(0, 10),
    visitor,
  }) + "\n";
const getReport = (packet, key) => packet.reports.find((r) => r.key === key);

async function journal(t, text, cleanup = true) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "boykovdocs-statistics-"),
  );
  if (cleanup) t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "visitor-events.jsonl");
  await writeFile(file, text);
  return {
    directory,
    file,
    config: {
      sourceDir: directory,
      stateDir: path.join(directory, "state"),
      endpoint: "https://boykov-services.ru/hooks/docs-customers/statistics",
      token,
    },
  };
}
test("BoykovDocs reconstructs inactivity sessions from the real native journal and sends only aggregates", async (t) => {
  const start = END - 86400000;
  const original =
    event(END - 3 * MIN, visitorB) +
    event(start - 10 * MIN) +
    event(start + 5 * MIN) +
    event(start + 34 * MIN) +
    event(start + 64 * MIN) +
    event(END - 2 * MIN, visitorB) +
    event(END + 1000) +
    '{"ts":';
  const { file } = await journal(t, original);
  const { count, packet } = await collectBoykovDocs(file, NOW);
  const report = getReport(packet, "24h");
  assert.equal(count, 7);
  assert.equal(packet.coverageFrom, new Date(start - 10 * MIN).toISOString());
  assert.equal(report.totals.views, 5);
  assert.equal(report.totals.visits, 2);
  assert.equal(getReport(packet, "7").totals.visits, 3);
  for (const r of packet.reports) {
    assert.equal(r.totals.leads, null);
    assert.equal(r.totals.articles, null);
    assert.deepEqual(r.sources, []);
    assert.deepEqual(r.pages, []);
    assert.deepEqual(r.articles, []);
  }
  assert.ok(!JSON.stringify(packet).includes(visitorA));
  assert.ok(!JSON.stringify(packet).includes(visitorB));
  assert.equal(await readFile(file, "utf8"), original);
});
test("collector refuses corrupt completed rows or missing history", async (t) => {
  const { file } = await journal(t, event(END - MIN) + '{"broken":true}\n');
  await assert.rejects(collectBoykovDocs(file, NOW), /SOURCE_INVALID_RECORD/);
  await writeFile(file, event(END + 1000));
  await assert.rejects(
    collectBoykovDocs(file, NOW),
    /SOURCE_WAITING_FOR_COMPLETED_MINUTE/,
  );
});
test("collector retains exact minute packets on ambiguous deliveries and refuses truncated history", async (t) => {
  const { file, config } = await journal(
    t,
    event(END - 5 * MIN) + event(END - MIN),
  );
  const received = [];
  let fail = true;
  const fetcher = async (_url, options) => {
    received.push(options.body);
    const packet = JSON.parse(options.body);
    if (fail)
      return Response.json({
        ok: true,
        siteId: "wrong",
        generatedAt: packet.generatedAt,
      });
    return Response.json({
      ok: true,
      siteId: docsStatisticsSite.id,
      generatedAt: packet.generatedAt,
    });
  };
  await assert.rejects(
    runBoykovDocsCycle(config, { now: NOW, fetcher }),
    /HUB_INVALID_ACK/,
  );
  await appendFile(file, event(END - 2 * MIN, visitorB));
  fail = false;
  await runBoykovDocsCycle(config, { now: NOW, fetcher });
  assert.equal(received[0], received[1]);
  await runBoykovDocsCycle(config, { now: NOW + MIN, fetcher });
  assert.equal(getReport(JSON.parse(received[2]), "24h").totals.views, 3);
  await writeFile(file, event(END - MIN));
  await assert.rejects(
    runBoykovDocsCycle(config, { now: NOW + 2 * MIN, fetcher }),
    /SOURCE_HISTORY_DECREASED/,
  );
  assert.equal(received.length, 3);
  const saved = JSON.parse(
    await readFile(path.join(config.stateDir, "last-packet.json"), "utf8"),
  );
  assert.equal(saved.count, 3);
  assert.equal(
    JSON.parse(
      await readFile(path.join(config.stateDir, "status.json"), "utf8"),
    ).ok,
    false,
  );
});
test("BoykovDocs statistics are private, cover four periods and never create a sales source", async (t) => {
  const { directory, file } = await journal(
    t,
    event(END - 3 * MIN) + event(END - MIN),
    false,
  );
  const password = "boykovdocs-statistics-fixture-password";
  let clock = NOW;
  const app = await createApp({
    dataDir: path.join(directory, "hub"),
    passwordHash: await hashPassword(password),
    secureCookies: false,
    allowedOrigins: [],
    now: () => clock,
    worker: async () => Response.json({ ok: true, jobs: [] }),
    isConfigured: () => false,
  });
  const db = app.locals.db;
  db.prepare("UPDATE docs_customer_connection SET token_hash=? WHERE id=1").run(
    createHash("sha256").update(token).digest("hex"),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const hook = (route, body, key = token) =>
    fetch(base + "/hooks/docs-customers/statistics" + route, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key,
      },
      body: JSON.stringify(body),
    });
  const { packet } = await collectBoykovDocs(file, NOW);
  assert.equal((await hook("/handshake", {}, "bad")).status, 401);
  assert.equal((await hook("", packet, "bad")).status, 401);
  assert.deepEqual(await (await hook("/handshake", {})).json(), {
    ok: true,
    source: docsStatisticsSite.id,
    protocol: 1,
    scope: "traffic",
  });
  for (const modify of [
    (p) => (p.host = "nwdelectricity.ru"),
    (p) => delete p.coverageFrom,
    (p) => (p.reports[0].totals.leads = 0),
    (p) => (p.reports[0].sources = [{ name: "direct", visits: 1 }]),
  ]) {
    const bad = structuredClone(packet);
    modify(bad);
    assert.equal((await hook("", bad)).status, 400);
  }
  assert.equal((await hook("", packet)).status, 201);
  assert.equal((await (await hook("", packet)).json()).duplicate, true);
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM sales_sites WHERE host=?")
      .get(docsStatisticsSite.host).n,
    0,
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM statistics_native_reports WHERE site_id=?",
      )
      .get(docsStatisticsSite.id).n,
    4,
  );
  assert.equal(
    (await fetch(base + "/api/statistics/overview?period=7")).status,
    401,
  );
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Boykov-Request": "1" },
    body: JSON.stringify({ password }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const overview = async () =>
    (
      await fetch(base + "/api/statistics/overview?period=7", {
        headers: { Cookie: cookie },
      })
    ).json();
  const total = await overview();
  const docs = total.sites.find((s) => s.id === docsStatisticsSite.id);
  assert.equal(docs.status, "ready");
  assert.equal(docs.totals.views, 2);
  assert.equal(docs.totals.leads, null);
  assert.equal(docs.points[0].views, null);
  assert.equal(docs.points.at(-1).views, 2);
  assert.ok(!JSON.stringify(total).includes(token));
  clock += 4 * MIN;
  assert.equal(
    (await overview()).sites.find((s) => s.id === docsStatisticsSite.id).status,
    "stale",
  );
});

test("v2 page receipts deduplicate replays, preserve legacy history and advertise the filtering boundary", async (t) => {
  const makeV2 = (at, id) =>
    JSON.stringify({
      ...JSON.parse(event(at)),
      schema: 2,
      eventId: id.repeat(64),
    }) + "\n";
  const original =
    event(END - 10 * MIN) +
    makeV2(END - 3 * MIN, "d") +
    makeV2(END - 3 * MIN, "d") +
    makeV2(END - 2 * MIN, "e");
  const { file } = await journal(t, original);
  const { packet, count } = await collectBoykovDocs(file, NOW);
  assert.equal(
    count,
    4,
    "history guard counts original source lines, including repeats",
  );
  assert.equal(getReport(packet, "24h").totals.views, 3);
  assert.equal(getReport(packet, "24h").totals.visits, 1);
  assert.equal(packet.filteredSince, new Date(END - 3 * MIN).toISOString());
  const { validateNativePacket } =
    await import("../server/modules/statistics/validation.js");
  const normalized = validateNativePacket(packet, docsStatisticsSite, NOW);
  assert.equal(normalized.reports[0].filteredSince, packet.filteredSince);
  assert.equal(await readFile(file, "utf8"), original);
  assert.ok(!JSON.stringify(normalized).includes("d".repeat(64)));
  const bad = structuredClone(packet);
  bad.filteredSince = packet.generatedAt;
  assert.throws(() => validateNativePacket(bad, docsStatisticsSite, NOW));
  await writeFile(file, makeV2(END - MIN, "z"));
  await assert.rejects(collectBoykovDocs(file, NOW), /SOURCE_INVALID_RECORD/);
});
