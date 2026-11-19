import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/auth.js";
import { createLeadsModule } from "../server/modules/leads/index.js";

const password = "trash-fixture-password",
  passwordHash = await hashPassword(password);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "boykov-trash-"));
  let app, server, base, cookie;
  async function start() {
    app = await createApp({
      dataDir: directory,
      passwordHash,
      secureCookies: false,
      allowedOrigins: [],
      worker: async () => Response.json({ jobs: [] }),
      isConfigured: () => false,
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = "http://127.0.0.1:" + server.address().port;
    const login = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Boykov-Request": "1" },
      body: JSON.stringify({ password }),
    });
    cookie = login.headers.get("set-cookie").split(";")[0];
  }
  async function stop() {
    await new Promise((r) => server.close(r));
    app.locals.db.close();
  }
  await start();
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  const api = (path, method = "GET", body) =>
    fetch(base + "/api" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Boykov-Request": "1",
        Cookie: cookie,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const key = async (site = "security") =>
    (await (await api(`/leads/sites/${site}/token`, "POST", {})).json()).token;
  const receive = (body, token, site = "security") =>
    fetch(
      base + "/hooks/" + (site === "boykovgroup" ? "tilda/" : "leads/") + site,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify(body),
      },
    );
  const ingest = async (token, overrides = {}, site = "security") => {
    const payload = {
      eventId: randomUUID(),
      createdAt: "2026-11-19T10:00:00Z",
      name: "Анна",
      phone: "+79990000000",
      fields: [],
      ...overrides,
    };
    const response = await receive(payload, token, site);
    assert.equal(response.status, 201);
    return { ...(await response.json()), version: 1, payload };
  };
  const change = (leads, action = "delete", requestId = randomUUID()) =>
    api("/leads/trash", "POST", {
      requestId,
      action,
      leads: leads.map(({ id, version }) => ({ id, version })),
    });
  return {
    api,
    key,
    receive,
    ingest,
    change,
    get base() {
      return base;
    },
    get app() {
      return app;
    },
    restart: async () => {
      await stop();
      await start();
    },
  };
}

test("delete hides a sale from inbox, status totals and dashboard; restore retains its sales work and history", async (t) => {
  const s = await fixture(t),
    token = await s.key(),
    first = await s.ingest(token),
    second = await s.ingest(token);
  await s.api("/leads/" + first.id, "PATCH", {
    requestId: randomUUID(),
    version: 1,
    status: "working",
    note: "Клиент ждёт договор",
  });
  assert.equal((await s.change([{ ...first, version: 2 }])).status, 200);
  const inbox = await (await s.api("/leads")).json();
  assert.deepEqual(
    inbox.leads.map((l) => l.id),
    [second.id],
  );
  assert.equal(inbox.trashTotal, 1);
  assert.equal((await (await s.api("/dashboard")).json()).stats.newLeads, 1);
  const site = (await (await s.api("/leads/sites")).json()).sites.find(
    (s) => s.id === "security",
  );
  assert.equal(site.stats.new, 1);
  assert.equal(site.stats.working, 0);
  assert.equal(site.trashed, 1);
  const detail = await (await s.api("/leads/" + first.id)).json();
  assert.ok(detail.lead.deletedAt);
  assert.equal(detail.lead.note, "Клиент ждёт договор");
  assert.equal(detail.history[0].action, "delete");
  assert.equal((await s.change([detail.lead], "restore")).status, 200);
  const restored = await (await s.api("/leads/" + first.id)).json();
  assert.equal(restored.lead.deletedAt, null);
  assert.equal(restored.lead.note, "Клиент ждёт договор");
  assert.equal(restored.lead.status, "working");
  assert.equal(restored.history[0].action, "restore");
  assert.equal(restored.history.length, 4);
  assert.equal((await (await s.api("/leads")).json()).total, 2);
});

test("all three agent sources and Tilda replay a trashed lead without restoring it, including after restart", async (t) => {
  const s = await fixture(t),
    records = [];
  for (const site of ["nwd", "accessibility", "security", "boykovgroup"]) {
    const token = await s.key(site);
    if (site === "boykovgroup") {
      const payload = {
        tranid: "test:123",
        Name: "Tilda",
        Phone: "+79990000000",
      };
      const ack = await (await s.receive(payload, token, site)).json();
      records.push({ ...ack, version: 1, payload, token, site });
    } else records.push({ ...(await s.ingest(token, {}, site)), token, site });
  }
  assert.equal((await s.change(records)).status, 200);
  await s.restart();
  for (const record of records) {
    const response = await s.receive(record.payload, record.token, record.site);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).duplicate, true);
  }
  assert.equal((await (await s.api("/leads")).json()).total, 0);
  assert.equal((await (await s.api("/leads?view=trash")).json()).total, 4);
  assert.equal((await (await s.api("/dashboard")).json()).stats.newLeads, 0);
  assert.equal(
    s.app.locals.db.prepare("SELECT count(*) AS n FROM sales_history").get().n,
    8,
  );
});

test("lost delete acknowledgement is safely replayed; an old delete retry never deletes a subsequently restored sale", async (t) => {
  const s = await fixture(t),
    token = await s.key(),
    lead = await s.ingest(token),
    requestId = randomUUID();
  assert.equal((await s.change([lead], "delete", requestId)).status, 200);
  await s.restart();
  assert.equal(
    (await (await s.change([lead], "delete", requestId)).json()).duplicate,
    true,
  );
  const deleted = (await (await s.api("/leads/" + lead.id)).json()).lead;
  assert.equal((await s.change([deleted], "restore")).status, 200);
  assert.equal((await s.change([lead], "delete", requestId)).status, 200);
  assert.equal((await (await s.api("/leads")).json()).total, 1);
  assert.equal(
    (
      await s.api("/leads/trash", "POST", {
        requestId,
        action: "restore",
        leads: [{ id: lead.id, version: 3 }],
      })
    ).status,
    409,
  );
  assert.equal(
    (await (await s.api("/leads/" + lead.id)).json()).history.length,
    3,
  );
});

test("one stale or missing row rolls back the entire bulk action; sales edits cannot race deletion", async (t) => {
  const s = await fixture(t),
    token = await s.key(),
    records = [await s.ingest(token), await s.ingest(token)].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  await s.api("/leads/" + records[1].id, "PATCH", {
    requestId: randomUUID(),
    version: 1,
    status: "processed",
    note: "Коллега обработал",
  });
  assert.equal((await s.change(records)).status, 409);
  assert.equal((await (await s.api("/leads")).json()).total, 2);
  assert.equal(
    (await (await s.api("/leads/" + records[0].id)).json()).lead.version,
    1,
  );
  assert.equal(
    (await s.change([records[0], { id: randomUUID(), version: 1 }])).status,
    404,
  );
  assert.equal((await (await s.api("/leads")).json()).total, 2);
  assert.equal((await s.change([records[0]])).status, 200);
  assert.equal(
    (
      await s.api("/leads/" + records[0].id, "PATCH", {
        requestId: randomUUID(),
        version: 1,
        status: "working",
        note: "Старый экран",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await s.api("/leads/" + records[0].id, "PATCH", {
        requestId: randomUUID(),
        version: 2,
        status: "working",
        note: "Редактирование корзины",
      })
    ).status,
    409,
  );
});

test("a database failure cannot acknowledge or partially delete a bulk selection", async (t) => {
  const s = await fixture(t),
    token = await s.key(),
    records = [await s.ingest(token), await s.ingest(token)].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  s.app.locals.db.prepare("CREATE TABLE trash_test_failure(id TEXT)").run();
  s.app.locals.db
    .prepare("INSERT INTO trash_test_failure VALUES(?)")
    .run(records[1].id);
  s.app.locals.db.exec(
    "CREATE TRIGGER fail_delete_history BEFORE INSERT ON sales_history WHEN NEW.action='delete' AND NEW.lead_id=(SELECT id FROM trash_test_failure) BEGIN SELECT RAISE(FAIL,'test disk failure'); END",
  );
  const requestId = randomUUID();
  assert.equal((await s.change(records, "delete", requestId)).status, 500);
  assert.equal((await (await s.api("/leads")).json()).total, 2);
  assert.equal(
    s.app.locals.db.prepare("SELECT count(*) AS n FROM sales_history").get().n,
    2,
  );
  assert.equal(
    s.app.locals.db.prepare("SELECT count(*) AS n FROM sales_actions").get().n,
    0,
  );
  s.app.locals.db.exec("DROP TRIGGER fail_delete_history");
  assert.equal((await s.change(records, "delete", requestId)).status, 200);
  assert.equal((await (await s.api("/leads?view=trash")).json()).total, 2);
});

test("trash actions require employee authentication and CSRF; a source key grants no deletion access", async (t) => {
  const s = await fixture(t),
    token = await s.key(),
    lead = await s.ingest(token);
  const body = JSON.stringify({
    requestId: randomUUID(),
    action: "delete",
    leads: [{ id: lead.id, version: 1 }],
  });
  assert.equal(
    (
      await fetch(s.base + "/api/leads/trash", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Boykov-Request": "1",
          Authorization: "Bearer " + token,
        },
        body,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(s.base + "/api/leads/trash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      })
    ).status,
    403,
  );
  assert.equal((await fetch(s.base + "/api/leads?view=trash")).status, 401);
  assert.equal((await (await s.api("/leads")).json()).total, 1);
});

test("invalid or overly broad selections cannot delete anything; reused request IDs cannot change meaning", async (t) => {
  const s = await fixture(t),
    token = await s.key(),
    lead = await s.ingest(token);
  const entry = { id: lead.id, version: 1 };
  for (const leads of [
    [],
    null,
    [null],
    [entry, entry],
    Array(51).fill(entry),
    [{ ...entry, version: "1" }],
    [{ ...entry, version: 0 }],
    [{ id: "x", version: 1 }],
  ])
    assert.equal(
      (
        await s.api("/leads/trash", "POST", {
          requestId: randomUUID(),
          action: "delete",
          leads,
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await s.api("/leads/trash", "POST", {
        requestId: randomUUID(),
        action: "purge",
        leads: [entry],
      })
    ).status,
    400,
  );
  assert.equal((await s.api("/leads?view=all")).status, 400);
  const requestId = randomUUID();
  await s.api("/leads/" + lead.id, "PATCH", {
    requestId,
    version: 1,
    status: "working",
    note: "Позвонили",
  });
  assert.equal(
    (await s.change([{ ...lead, version: 2 }], "delete", requestId)).status,
    409,
  );
  assert.equal((await (await s.api("/leads")).json()).total, 1);
});

test("trash filtering and pagination count only trashed rows and permit at most the explicit 50-record selection", async (t) => {
  const s = await fixture(t),
    token = await s.key(),
    records = [];
  for (let i = 0; i < 53; i++)
    records.push(
      await s.ingest(token, {
        name: i === 52 ? "Яна_100%" : "Анна",
        createdAt: new Date(Date.UTC(2026, 10, 19, 10, i)).toISOString(),
      }),
    );
  assert.equal((await s.change(records.slice(0, 50))).status, 200);
  assert.equal((await s.change(records.slice(50, 52))).status, 200);
  const first = await (await s.api("/leads?view=trash&order=oldest")).json(),
    second = await (
      await s.api("/leads?view=trash&page=2&order=oldest")
    ).json();
  assert.equal(first.total, 52);
  assert.equal(first.pages, 2);
  assert.equal(first.leads.length, 50);
  assert.equal(second.leads.length, 2);
  assert.equal(
    new Set([...first.leads, ...second.leads].map((lead) => lead.id)).size,
    52,
  );
  assert.equal(
    (await (await s.api("/leads?view=trash&site=accessibility")).json()).total,
    0,
  );
  assert.equal(
    (await (await s.api("/leads?view=trash&status=processed")).json()).total,
    0,
  );
  assert.equal(
    (await (await s.api("/leads?q=" + encodeURIComponent("ЯНА_100%"))).json())
      .total,
    1,
  );
  assert.equal(
    (await s.change(first.leads.slice(0, 2), "restore")).status,
    200,
  );
  assert.equal((await (await s.api("/leads")).json()).total, 3);
});

test("schema upgrade is repeatable and keeps old leads, comments, history, keys and source identifiers", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createLeadsModule(db);
    const id = randomUUID(),
      stamp = "2026-11-18T10:00:00.000Z",
      payload = JSON.stringify({
        eventId: "legacy:1",
        createdAt: stamp,
        name: "Анна",
        fields: [],
      });
    db.prepare(
      "INSERT INTO sales_leads(id,site_id,event_id,payload_hash,payload,search_text,created_at,received_at,status,note,version,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      "nwd",
      "legacy:1",
      "hash",
      payload,
      "анна",
      stamp,
      stamp,
      "processed",
      "Важная заметка",
      3,
      stamp,
    );
    db.prepare(
      "INSERT INTO sales_history(lead_id,created_at,status,note,version) VALUES(?,?,?,?,?)",
    ).run(id, stamp, "processed", "Важная заметка", 3);
    db.prepare(
      "UPDATE sales_sites SET token_hash='private-hash' WHERE id='nwd'",
    ).run();
    db.exec(
      "DROP INDEX sales_leads_deleted; ALTER TABLE sales_leads DROP COLUMN deleted_at; ALTER TABLE sales_history DROP COLUMN action;",
    );
    createLeadsModule(db);
    createLeadsModule(db);
    const lead = db.prepare("SELECT * FROM sales_leads WHERE id=?").get(id);
    assert.equal(lead.note, "Важная заметка");
    assert.equal(lead.version, 3);
    assert.equal(lead.payload, payload);
    assert.equal(lead.deleted_at, null);
    assert.equal(
      db.prepare("SELECT action FROM sales_history WHERE lead_id=?").get(id)
        .action,
      "update",
    );
    assert.equal(
      db.prepare("SELECT token_hash FROM sales_sites WHERE id='nwd'").get()
        .token_hash,
      "private-hash",
    );
  } finally {
    db.close();
  }
});
