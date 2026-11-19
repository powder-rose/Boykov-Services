import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/auth.js";
import { createLeadsModule } from "../server/modules/leads/index.js";

const password = "tilda-fixture-password",
  passwordHash = await hashPassword(password);
const sample = () => ({
  tranid: "467251:8442970",
  formid: "form48844953",
  Name: "Анна Петрова",
  Phone: "+7 999 123-45-67",
  Email: "sale@example.ru",
  Comments: "Нужен расчёт",
  Service: "Охрана труда",
});
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "boykov-tilda-"));
  let clock = Date.parse("2026-11-19T10:00:00Z"),
    app,
    server,
    base,
    cookie;
  async function start() {
    app = await createApp({
      dataDir: directory,
      passwordHash,
      secureCookies: false,
      allowedOrigins: [],
      now: () => clock,
      worker: async () => Response.json({ jobs: [] }),
      isConfigured: () => false,
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = "http://127.0.0.1:" + server.address().port;
    const login = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Boykov-Request": "1" },
      body: JSON.stringify({ password }),
    });
    cookie = login.headers.get("set-cookie").split(";")[0];
  }
  async function stop() {
    await new Promise((resolve) => server.close(resolve));
    app.locals.db.close();
  }
  await start();
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  const api = (path, method = "GET", body) =>
    fetch(base + "/api/leads" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Boykov-Request": "1",
        Cookie: cookie,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const token = async (id = "boykovgroup") =>
    (await (await api(`/sites/${id}/token`, "POST", {})).json()).token;
  const send = (
    body,
    key,
    {
      json = false,
      site = "boykovgroup",
      referer = "https://boykovgroup.ru/ot/",
      contentType,
      route = "tilda",
    } = {},
  ) =>
    fetch(`${base}/hooks/${route}/${site}`, {
      method: "POST",
      headers: {
        "Content-Type":
          contentType ||
          (json ? "application/json" : "application/x-www-form-urlencoded"),
        ...(key ? { Authorization: "Bearer " + key } : {}),
        Referer: referer,
      },
      body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
    });
  return {
    api,
    token,
    send,
    get app() {
      return app;
    },
    directory,
    advance: (ms) => {
      clock += ms;
    },
    restart: async () => {
      await stop();
      await start();
    },
    site: async () =>
      (await (await api("/sites")).json()).sites.find(
        (s) => s.host === "boykovgroup.ru",
      ),
  };
}

test("Tilda probe needs its own key; body keys, other sources and generic intake cannot bypass authentication", async (t) => {
  const s = await fixture(t),
    key = await s.token(),
    other = await s.token("security");
  assert.equal((await s.send({ test: "test" })).status, 401);
  assert.equal((await s.send({ test: "test", token: key })).status, 401);
  assert.equal((await s.send({ test: "test" }, other)).status, 401);
  assert.equal(
    (await s.send(sample(), key, { route: "leads", json: true })).status,
    400,
  );
  assert.equal(
    (await s.send(sample(), other, { site: "security" })).status,
    400,
  );
  assert.equal((await (await s.api("")).json()).total, 0);
});

test("Tilda confirmation never creates a lead or falsely expires during an idle period; rotation requires a fresh probe", async (t) => {
  const s = await fixture(t),
    key = await s.token();
  s.advance(86400000);
  await s.restart();
  assert.equal((await s.site()).connection, "webhook_waiting");
  assert.equal((await s.send({ test: "test" }, key)).status, 200);
  assert.equal((await s.site()).connection, "webhook");
  assert.equal((await s.site()).lastReceivedAt, null);
  s.advance(86400000);
  await s.restart();
  assert.equal((await s.site()).connection, "webhook");
  assert.equal((await (await s.api("")).json()).total, 0);
  const next = await s.token();
  assert.notEqual(next, key);
  assert.equal((await s.site()).connection, "webhook_waiting");
  assert.equal((await s.send({ test: "test" }, key)).status, 401);
  assert.equal((await s.send({ test: "test" }, next)).status, 200);
});

test("URL-encoded Tilda fields keep Cyrillic, plus signs, custom values and page attribution, with no double decoding", async (t) => {
  const s = await fixture(t),
    key = await s.token();
  const response = await s.send(
    {
      ...sample(),
      Город: "Москва",
      Метка: "%2B remains literal",
      COOKIES: "private-cookie",
      "Опции[]": "Да",
    },
    key,
  );
  assert.equal(response.status, 200);
  const ack = await response.json();
  const { lead } = await (await s.api("/" + ack.id)).json();
  assert.equal(lead.eventId, "tilda:467251:8442970");
  assert.equal(lead.name, "Анна Петрова");
  assert.equal(lead.phone, "+7 999 123-45-67");
  assert.equal(lead.email, "sale@example.ru");
  assert.equal(lead.service, "Охрана труда");
  assert.equal(lead.message, "Нужен расчёт");
  assert.equal(lead.pageUrl, "https://boykovgroup.ru/ot/");
  assert.equal(
    lead.fields.find((f) => f.label === "Метка").value,
    "%2B remains literal",
  );
  assert.equal(lead.fields.find((f) => f.label === "Опции").value, '["Да"]');
  assert.ok(!JSON.stringify(lead).includes("private-cookie"));
  const observer = new DatabaseSync(join(s.directory, "platform.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(
      observer.prepare("SELECT id FROM sales_leads WHERE id=?").get(ack.id).id,
      ack.id,
    );
  } finally {
    observer.close();
  }
});

test("delayed JSON replay after restart keeps one lead, its original time, sales status and notes; conflicts are visible", async (t) => {
  const s = await fixture(t),
    key = await s.token();
  const body = { ...sample(), products: [{ price: 500, name: "Услуга" }] };
  const first = await (await s.send(body, key, { json: true })).json();
  const before = (await (await s.api("/" + first.id)).json()).lead;
  await s.api("/" + first.id, "PATCH", {
    requestId: randomUUID(),
    version: 1,
    status: "processed",
    note: "Договор подписан",
  });
  s.advance(3600000);
  await s.restart();
  const reordered = Object.fromEntries(Object.entries(body).reverse());
  reordered.products = [{ name: "Услуга", price: 500 }];
  const again = await (await s.send(reordered, key, { json: true })).json();
  assert.equal(again.id, first.id);
  assert.equal(again.duplicate, true);
  assert.equal(
    (await s.send({ ...body, Phone: "changed" }, key, { json: true })).status,
    409,
  );
  assert.equal((await s.site()).connection, "attention");
  assert.equal((await s.send({ test: "test" }, key)).status, 200);
  assert.equal((await s.site()).connection, "attention");
  assert.equal((await s.send(body, key, { json: true })).status, 200);
  assert.equal((await s.site()).connection, "webhook");
  const { lead, history } = await (await s.api("/" + first.id)).json();
  assert.equal(lead.createdAt, before.createdAt);
  assert.equal(lead.note, "Договор подписан");
  assert.equal(lead.status, "processed");
  assert.equal(history.length, 2);
  assert.equal((await (await s.api("")).json()).total, 1);
});

test("Tilda capture rolls back on storage failure and acknowledges only a committed retry", async (t) => {
  const s = await fixture(t),
    key = await s.token();
  s.app.locals.db.exec(
    "CREATE TRIGGER fail_tilda_history BEFORE INSERT ON sales_history BEGIN SELECT RAISE(FAIL,'disk failure'); END",
  );
  assert.equal((await s.send(sample(), key)).status, 500);
  assert.equal((await (await s.api("")).json()).total, 0);
  assert.equal((await s.site()).webhookVerifiedAt, null);
  s.app.locals.db.exec("DROP TRIGGER fail_tilda_history");
  assert.equal((await s.send(sample(), key)).status, 200);
});

test("distinct Tilda transaction IDs never merge by phone; malformed requests cannot be acknowledged", async (t) => {
  const s = await fixture(t),
    key = await s.token();
  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      s.send({ ...sample(), tranid: "project:" + i }, key),
    ),
  );
  assert.ok(responses.every((r) => r.status === 200));
  assert.equal((await (await s.api("")).json()).total, 12);
  for (const bad of [
    { ...sample(), tranid: "" },
    { Name: "No ID" },
    { ...sample(), tranid: ["a", "b"] },
    { ...sample(), Note: "x".repeat(16001) },
    {
      ...sample(),
      ...Object.fromEntries(
        Array.from({ length: 101 }, (_, i) => ["field" + i, "x"]),
      ),
    },
  ]) {
    assert.equal((await s.send(bad, key, { json: true })).status, 400);
  }
  assert.equal(
    (await s.send(sample(), key, { contentType: "text/plain" })).status,
    415,
  );
  assert.equal(
    (await s.send({ ...sample(), Comments: "x".repeat(150000) }, key)).status,
    413,
  );
  assert.equal((await (await s.api("")).json()).total, 12);
});

test("custom Tilda fields survive JSON intake even without contacts or a trustworthy Referer", async (t) => {
  const s = await fixture(t),
    key = await s.token();
  const body = {
    tranid: "custom:1",
    formname: "Консультация",
    "Ваше имя": "Ольга",
    "Ваш телефон": "+79990000000",
    custom: { b: 2, a: 1 },
  };
  const ack = await (
    await s.send(body, key, {
      json: true,
      referer: "https://attacker.example/",
    })
  ).json();
  const { lead } = await (await s.api("/" + ack.id)).json();
  assert.equal(lead.name, "Ольга");
  assert.equal(lead.phone, "+79990000000");
  assert.equal(lead.form, "Консультация");
  assert.equal(lead.pageUrl, "https://boykovgroup.ru/");
  assert.equal(
    lead.fields.find((f) => f.label === "custom").value,
    '{"a":1,"b":2}',
  );
  assert.equal(
    (
      await s.send({ tranid: "custom:2", arbitrary: "Manual review" }, key, {
        json: true,
      })
    ).status,
    200,
  );
});

test("new Tilda sites get the proper endpoint and do not alter existing agent integrations", async (t) => {
  const s = await fixture(t);
  const response = await s.api("/sites", "POST", {
    name: "Ещё Tilda",
    host: "another-site.ru",
    deliveryMode: "tilda",
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.endpoint, "/hooks/tilda/" + created.siteId);
  assert.equal(
    (await s.send(sample(), created.token, { site: created.siteId })).status,
    200,
  );
  const key = await s.token("nwd");
  assert.equal(
    (
      await s.send(
        { eventId: "nwd:1", createdAt: "2026-11-19T10:00:00Z" },
        key,
        { route: "leads", site: "nwd", json: true },
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await s.api("/sites", "POST", {
        name: "Bad",
        host: "bad.ru",
        deliveryMode: "unknown",
      })
    ).status,
    400,
  );
});

test("schema upgrade preserves a pre-existing Boykov Group ID, token and all agent connection data", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE sales_sites(id TEXT PRIMARY KEY,name TEXT NOT NULL,host TEXT NOT NULL UNIQUE,token_hash TEXT,created_at TEXT NOT NULL,last_received_at TEXT,last_heartbeat_at TEXT,pending_count INTEGER NOT NULL DEFAULT 0,rejected_count INTEGER NOT NULL DEFAULT 0,oldest_pending_at TEXT,scan_ok INTEGER NOT NULL DEFAULT 1)",
    );
    db.prepare(
      "INSERT INTO sales_sites(id,name,host,token_hash,created_at,last_heartbeat_at,pending_count) VALUES(?,?,?,?,?,?,?)",
    ).run(
      "custom-id",
      "Бойков",
      "boykovgroup.ru",
      "hash",
      "2026-11-18T00:00:00Z",
      null,
      0,
    );
    db.prepare(
      "INSERT INTO sales_sites(id,name,host,token_hash,created_at,last_heartbeat_at,pending_count) VALUES(?,?,?,?,?,?,?)",
    ).run(
      "nwd",
      "NWD",
      "nwdelectricity.ru",
      "nwd-hash",
      "2026-11-18T00:00:00Z",
      "2026-11-19T10:00:00Z",
      12,
    );
    createLeadsModule(db);
    createLeadsModule(db);
    const group = db
      .prepare("SELECT * FROM sales_sites WHERE host='boykovgroup.ru'")
      .get();
    assert.equal(group.id, "custom-id");
    assert.equal(group.token_hash, "hash");
    assert.equal(group.delivery_mode, "tilda");
    const nwd = db.prepare("SELECT * FROM sales_sites WHERE id='nwd'").get();
    assert.equal(nwd.token_hash, "nwd-hash");
    assert.equal(nwd.pending_count, 12);
    assert.equal(nwd.last_heartbeat_at, "2026-11-19T10:00:00Z");
    assert.equal(nwd.delivery_mode, "agent");
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM sales_sites").get().n,
      4,
    );
  } finally {
    db.close();
  }
});
