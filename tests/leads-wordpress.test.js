import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { createLeadsModule } from "../server/modules/leads/index.js";

const php = process.env.PHP_BIN || "php";
const probe = spawnSync(php, ["-r", "echo PHP_VERSION_ID;"], {
  encoding: "utf8",
});
const available =
  !probe.error && probe.status === 0 && Number(probe.stdout) >= 70300;
const mysql =
  available &&
  !!(process.env.WP_TEST_MYSQL_SOCKET || process.env.WP_TEST_MYSQL_PORT);
const fixture = fileURLToPath(
  new URL("./helpers/wordpress-fixture.php", import.meta.url),
);
function run(mode, input = {}, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(php, [fixture, mode], {
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      error = "";
    child.stdout.on("data", (s) => (output += s));
    child.stderr.on("data", (s) => (error += s));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(error + output));
      try {
        resolve(mode === "page" ? output : JSON.parse(output));
      } catch (e) {
        reject(new Error(error + output, { cause: e }));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
const ack = (event, code = 201, more = {}) => ({
  response: { code },
  body: JSON.stringify({
    ok: true,
    siteId: "fixture",
    eventId: event,
    id: randomUUID(),
    ...more,
  }),
});
const epoch = Math.floor(Date.now() / 1000);

async function resetNetwork() {
  await run("raw-sql", {
    sql: [1, 2, 3, 4, 5, 6, 9].map(
      (id) =>
        `DROP TABLE IF EXISTS wp_${id === 1 ? "" : id + "_"}boykov_lead_outbox`,
    ),
  });
}

test(
  "Energo preserves every valid subdomain and rejects suffix lookalikes; network settings need network rights",
  { skip: !available },
  async () => {
    for (const host of [
      "energo-365.ru",
      "lp.energo-365.ru",
      "office.msk.energo-365.ru",
    ]) {
      const payload = await run(
        "map",
        {},
        { WP_FIXTURE_SOURCE_URL: `https://${host}/service/?token=private` },
      );
      assert.equal(payload.pageUrl, `https://${host}/service/`);
      assert.equal(payload.fields.find((f) => f.label === "Сайт").value, host);
    }
    for (const host of ["energo-365.ru.attacker.invalid", "badenergo-365.ru"]) {
      const payload = await run(
        "map",
        {},
        { WP_FIXTURE_SOURCE_URL: `https://${host}/wrong/` },
      );
      assert.equal(payload.pageUrl, "https://energo-365.ru/");
    }
    const denied = await run("access", {
      admin: true,
      nonce: true,
      network: true,
      networkAdmin: false,
    });
    assert.match(denied.blocked, /Недостаточно прав/);
  },
);

test(
  "Multisite aggregates all Energo queues and cannot hide a failed subdomain behind an empty root",
  { skip: !mysql },
  async () => {
    await resetNetwork();
    const flow = await run("network-flow");
    assert.equal(flow.activation.coordinator, 2);
    assert.equal(flow.activation.restored_blog, 1);
    assert.ok(flow.activation.cron[2].boykov_leads_delivery_tick);
    assert.equal(flow.activation.cron[4].boykov_leads_delivery_tick, 123);
    assert.equal(flow.first.sites, 3);
    assert.equal(flow.first.stats.total, 3);
    assert.equal(flow.first.stats.delivered, 2);
    assert.equal(flow.first.stats.pending, 1);
    assert.equal(
      flow.first_heartbeat_count,
      1,
      "only aggregate heartbeat is sent",
    );
    assert.equal(flow.heartbeats[0].pending, 1);
    assert.ok(flow.heartbeats[0].oldestPendingAt);
    assert.equal(flow.heartbeats[0].scanOk, true);
    assert.equal(flow.broken.scan_failed, true);
    assert.equal(flow.heartbeats[1].scanOk, false);
    assert.equal(
      flow.missing_stayed_missing,
      true,
      "missing initialized queue must not be silently recreated empty",
    );
    assert.equal(flow.after_new.sites, 4);
    assert.ok(flow.payloads.some((p) => p.host === "new.energo-365.ru"));
    assert.deepEqual(flow.tokens, ["Bearer " + "a".repeat(64)]);
    assert.equal(flow.other_aborted, false);
    assert.equal(flow.unrelated_tables, 0);
    assert.equal(flow.local_config, null);
    assert.equal(flow.restored_blog, 1);
  },
);

test(
  "Multisite also permits activation for one subsite without changing unrelated schedules",
  { skip: !mysql },
  async () => {
    await resetNetwork();
    const result = await run("network-per-site");
    assert.equal(Number(result.table), 1);
    assert.equal(result.blog, 1);
    assert.ok(result.scheduled[3].boykov_leads_delivery_tick);
    assert.equal(result.scheduled[4].boykov_leads_delivery_tick, 123);
  },
);

test(
  "WordPress maps the live CF7 field names, arrays and page path without credentials",
  { skip: !available },
  async () => {
    const p = await run("map");
    assert.equal(p.name, "Тестовый клиент");
    assert.equal(p.phone, "+7 900 000-00-00");
    assert.equal(p.email, "fixture@example.invalid");
    assert.equal(p.message, "Нужен расчёт");
    assert.equal(p.eventId, "cf7:fixture");
    assert.equal(
      p.createdAt,
      new Date(1795082400 * 1000).toISOString().replace(".000Z", "Z"),
    );
    assert.equal(p.pageUrl, "https://energo-365.ru/service/");
    assert.deepEqual(
      JSON.parse(p.fields.find((f) => f.label === "Объект").value),
      ["Офис", "Склад"],
    );
    assert.equal(
      p.fields.find((f) => f.label === "Номер формы Contact Form 7").value,
      "51",
    );
    assert.doesNotMatch(
      JSON.stringify(p),
      /captcha-private|credential-private|not-for-hub|_wpcf7/,
    );
  },
);

test(
  "WordPress accepts only exact committed acknowledgements and the fixed HTTPS intake",
  { skip: !available },
  async () => {
    const event = "cf7:fixture";
    assert.equal(await run("ack", { event, response: ack(event) }), true);
    assert.equal(await run("ack", { event, response: ack(event, 200) }), true);
    for (const response of [
      ack(event, 202),
      ack(event, 302),
      ack("other"),
      ack(event, 200, { siteId: "other" }),
      ack(event, 200, { ok: "true" }),
      ack(event, 200, { id: "" }),
      { response: { code: 200 }, body: "<html>OK</html>" },
    ]) {
      assert.equal(await run("ack", { event, response }), false);
    }
    assert.equal(
      (
        await run("endpoint", {
          url: "https://boykov-services.ru/hooks/leads/fixture",
        })
      ).site_id,
      "fixture",
    );
    for (const url of [
      "http://boykov-services.ru/hooks/leads/fixture",
      "https://evil.invalid/hooks/leads/fixture",
      "https://boykov-services.ru/hooks/tilda/fixture",
      "https://boykov-services.ru/hooks/leads/fixture?key=x",
      "https://user:pass@boykov-services.ru/hooks/leads/fixture",
    ]) {
      assert.equal(await run("endpoint", { url }), false);
    }
    const [, args] = await run("transport");
    assert.equal(args.sslverify, true);
    assert.equal(args.redirection, 0);
    assert.equal(args.headers.Authorization, "Bearer test-key");
    assert.equal(args.timeout, 6);
  },
);

test(
  "WordPress administrative writes require both capability and nonce; queue failure aborts the form",
  { skip: !available },
  async () => {
    const denied = await run("access", { admin: false, nonce: true });
    assert.match(denied.blocked, /Недостаточно прав/);
    assert.deepEqual(denied.options, []);
    const forged = await run("access", { admin: true, nonce: false });
    assert.equal(forged.blocked, "NONCE_REQUIRED");
    assert.deepEqual(forged.options, []);
    const failure = await run(
      "capture-failure",
      {},
      { WP_TEST_MYSQL_SOCKET: "", WP_TEST_MYSQL_PORT: "" },
    );
    assert.equal(failure.abort, true);
    assert.match(failure.response, /Не удалось сохранить заявку/);
    const first = await run("configure-failure");
    assert.equal(first.code, "HUB_CONNECTION_UNCONFIRMED");
    assert.equal(first.config, null);
    const existing = await run("configure-failure", { existing: true });
    assert.equal(
      existing.config.token,
      "b".repeat(64),
      "failed rotation must preserve the working key",
    );
  },
);

test(
  "WordPress durable MySQL queue survives restart, rejects false ACKs and retains a stable payload",
  { skip: !mysql },
  async () => {
    await run("raw-sql", {
      sql: ["DROP TABLE IF EXISTS wp_boykov_lead_outbox"],
    });
    const installed = await run("install");
    assert.equal(installed.stats.total, 0);
    assert.equal(installed.schedule[1], "boykov_leads_minute");
    const captured = await run("capture");
    assert.equal(captured.abort, false);
    assert.equal(
      captured.stats.total,
      1,
      "same in-process hook must not duplicate capture",
    );
    const row = captured.row,
      event = row.event_id;
    const bad = await run("run", {
      now: epoch + 10,
      response: ack(event, 202),
    });
    assert.equal(bad.rows[0].status, "pending");
    assert.equal(bad.rows[0].payload, row.payload);
    assert.equal(Number(bad.rows[0].attempts), 1);
    const early = await run("run", { now: epoch + 11, response: ack(event) });
    assert.equal(
      early.rows[0].status,
      "pending",
      "retry backoff must survive process restart",
    );
    const rejected = await run("run", {
      now: epoch + 100,
      response: ack(event, 409),
    });
    assert.equal(rejected.rows[0].status, "rejected");
    assert.equal(rejected.result.stats.rejected, 1);
    await run("retry");
    const delivered = await run("run", {
      now: epoch + 200,
      response: ack(event, 200),
    });
    assert.equal(delivered.rows[0].status, "delivered");
    assert.equal(delivered.rows[0].payload, row.payload);
    assert.equal(delivered.rows[0].event_id, event);
    await run("retry");
    assert.equal(
      (await run("run", { now: epoch + 1000 })).rows[0].status,
      "delivered",
    );
    const html = await run("page", { token: "c".repeat(64) });
    assert.doesNotMatch(html, new RegExp("c".repeat(64)));
    assert.doesNotMatch(html, /Тестовый клиент|fixture@example/);
    assert.match(html, /каждую минуту/);
  },
);

test(
  "WordPress sender uses an actual MySQL connection lock and does not acknowledge a concurrent run",
  { skip: !mysql },
  async () => {
    await run("raw-sql", {
      sql: ["DROP TABLE IF EXISTS wp_boykov_lead_outbox"],
    });
    const capture = await run("capture");
    const first = run("run", {
      now: epoch + 2000,
      sleep: 900,
      response: ack(capture.row.event_id),
    });
    // Poll without acquiring the lock ourselves or depending on startup timing.
    let held = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      held = await run("lock-held");
      if (held) break;
    }
    assert.equal(held, true);
    const busy = await run("run", { now: epoch - 1000 });
    assert.equal(busy.result.busy, true);
    assert.equal((await first).rows[0].status, "delivered");
  },
);

test(
  "WordPress replays a lost acknowledgement into the real hub without creating a second lead",
  { skip: !mysql },
  async (t) => {
    await run("raw-sql", {
      sql: ["DROP TABLE IF EXISTS wp_boykov_lead_outbox"],
    });
    const captured = await run("capture");
    const db = new DatabaseSync(":memory:");
    const leads = createLeadsModule(db);
    const app = express();
    app.use(express.json({ limit: "128kb" }));
    app.post("/hooks/leads/:siteId", leads.receive);
    leads.register(app);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    t.after(async () => {
      await new Promise((r) => server.close(r));
      db.close();
    });
    const base = "http://127.0.0.1:" + server.address().port;
    const keyResult = await fetch(base + "/api/leads/sites/nwd/token", {
      method: "POST",
    });
    const { token } = await keyResult.json();
    const p = JSON.parse(captured.row.payload);
    const first = await fetch(base + "/hooks/leads/nwd", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: captured.row.payload,
    });
    assert.equal(first.status, 201);
    const original = await first.json(); // Simulate loss before WordPress writes its local receipt.
    const retry = await run(
      "run",
      { now: epoch + 3000, site: "nwd", token, real: true },
      { WP_FIXTURE_HUB: base },
    );
    assert.equal(retry.rows[0].status, "delivered");
    assert.equal(retry.rows[0].hub_id, original.id);
    assert.equal(
      db.prepare("SELECT COUNT(*) amount FROM sales_leads").get().amount,
      1,
    );
    assert.equal(
      JSON.parse(db.prepare("SELECT payload FROM sales_leads").get().payload)
        .eventId,
      p.eventId,
    );
  },
);
