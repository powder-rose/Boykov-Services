import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/auth.js";
import { LeadAgent, mapRecord } from "../integrations/leads/agent.mjs";
import { installAccessibilityOutbox } from "../integrations/leads/accessibility-outbox.mjs";

const password = "test-sales-inbox-password",
  passwordHash = await hashPassword(password);
const directoryClosers = new Map();
const sample = (overrides = {}) => ({
  eventId: randomUUID(),
  createdAt: "2026-11-18T09:20:00.000Z",
  name: "Анна",
  phone: "+7 999 123-45-67",
  email: "test@example.ru",
  service: "Паспорт безопасности",
  message: "Перезвонить после 14:00",
  pageUrl: "https://pasport-bezopasnosty.ru/",
  form: "Обратный звонок",
  fields: [{ label: "Город", value: "Москва" }],
  ...overrides,
});
async function fixture(t, existing, clock = Date.now) {
  const agents = [];
  const track = (agent) => {
    agents.push(agent);
    return agent;
  };
  const directory =
    existing || (await mkdtemp(join(tmpdir(), "boykov-leads-")));
  const app = await createApp({
    dataDir: directory,
    passwordHash,
    secureCookies: false,
    allowedOrigins: [],
    now: clock,
    worker: async () => Response.json({ jobs: [], aiConfigured: false }),
    isConfigured: () => false,
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise((r) => listener.once("listening", r));
  const base = "http://127.0.0.1:" + listener.address().port;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await new Promise((r) => listener.close(r));
    for (const agent of agents) agent.close();
    app.locals.db.close();
  }
  const closers = directoryClosers.get(directory) || [];
  closers.push(close);
  directoryClosers.set(directory, closers);
  t.after(close);
  if (!existing)
    t.after(async () => {
      for (const stop of closers) await stop();
      await rm(directory, { recursive: true, force: true });
      directoryClosers.delete(directory);
    });
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Boykov-Request": "1" },
    body: JSON.stringify({ password }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const api = (path, method = "GET", body) =>
    fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Boykov-Request": "1",
        Cookie: cookie,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const key = async (site = "security") =>
    (await (await api(`/api/leads/sites/${site}/token`, "POST", {})).json())
      .token;
  const ingest = (payload, token, site = "security") =>
    fetch(base + "/hooks/leads/" + site, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify(payload),
    });
  return { directory, app, base, api, key, ingest, close, track };
}
async function agentFixture(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix)),
    agents = [];
  t.after(async () => {
    for (const agent of agents) agent.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    track: (agent) => {
      agents.push(agent);
      return agent;
    },
  };
}
test("lead intake requires a site-specific key; private lists and key issuance require a session", async (t) => {
  const s = await fixture(t),
    token = await s.key();
  assert.equal((await fetch(s.base + "/api/leads")).status, 401);
  assert.equal((await fetch(s.base + "/api/leads/sites")).status, 401);
  assert.equal((await s.ingest(sample(), "a".repeat(64))).status, 401);
  assert.equal((await s.ingest(sample(), token, "accessibility")).status, 401);
  const response = await s.ingest(sample({ siteId: "accessibility" }), token);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).siteId, "security");
  const sites = await (await s.api("/api/leads/sites")).json();
  assert.ok(
    sites.sites.every(
      (site) => !Object.keys(site).some((k) => k.includes("token")),
    ),
  );
  assert.equal(
    sites.sites.find((site) => site.id === "nwd").connection,
    "unconfigured",
  );
});
test("replayed deliveries preserve status, note and history; changed payloads cannot overwrite a saved sale", async (t) => {
  const s = await fixture(t),
    token = await s.key(),
    payload = sample();
  const ack = await (await s.ingest(payload, token)).json();
  const change = {
    requestId: randomUUID(),
    version: 1,
    status: "working",
    note: "Позвонили клиенту",
  };
  assert.equal(
    (await s.api("/api/leads/" + ack.id, "PATCH", change)).status,
    200,
  );
  assert.equal((await s.ingest(payload, token)).status, 200);
  assert.equal(
    (await s.ingest({ ...payload, phone: "+7 999 111-22-33" }, token)).status,
    409,
  );
  const detail = await (await s.api("/api/leads/" + ack.id)).json();
  assert.equal(detail.lead.status, "working");
  assert.equal(detail.lead.note, change.note);
  assert.equal(detail.history.length, 2);
  assert.equal((await (await s.api("/api/leads")).json()).total, 1);
});
test("a failed commit never acknowledges a lead or leaves a partial record", async (t) => {
  const s = await fixture(t),
    token = await s.key(),
    payload = sample();
  s.app.locals.db.exec(
    "CREATE TRIGGER fail_history BEFORE INSERT ON sales_history BEGIN SELECT RAISE(FAIL,'test disk error'); END;",
  );
  assert.equal((await s.ingest(payload, token)).status, 500);
  assert.equal(
    s.app.locals.db.prepare("SELECT count(*) AS n FROM sales_leads").get().n,
    0,
  );
  s.app.locals.db.exec("DROP TRIGGER fail_history");
  assert.equal((await s.ingest(payload, token)).status, 201);
});
test("a lost edit response can be retried once; concurrent managers cannot overwrite each other", async (t) => {
  const s = await fixture(t),
    token = await s.key(),
    ack = await (await s.ingest(sample(), token)).json();
  const body = {
    requestId: randomUUID(),
    version: 1,
    status: "processed",
    note: "Договор отправлен",
  };
  assert.equal(
    (await s.api("/api/leads/" + ack.id, "PATCH", body)).status,
    200,
  );
  assert.equal(
    (await s.api("/api/leads/" + ack.id, "PATCH", body)).status,
    200,
  );
  assert.equal(
    (
      await s.api("/api/leads/" + ack.id, "PATCH", {
        ...body,
        requestId: randomUUID(),
        note: "Чужая версия",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await s.api("/api/leads/" + ack.id, "PATCH", {
        ...body,
        note: "Подмена операции",
      })
    ).status,
    409,
  );
  const detail = await (await s.api("/api/leads/" + ack.id)).json();
  assert.equal(detail.history.length, 2);
  assert.equal(detail.lead.version, 2);
  assert.equal(detail.lead.note, body.note);
});
test("received sales and key hashes survive restart; token rotation revokes only one source", async (t) => {
  const s = await fixture(t),
    first = await s.key(),
    other = await s.key("accessibility"),
    payload = sample();
  await s.ingest(payload, first);
  await s.close();
  const resumed = await fixture(t, s.directory);
  assert.equal((await resumed.ingest(payload, first)).status, 200);
  await resumed.key();
  assert.equal((await resumed.ingest(sample(), first)).status, 401);
  assert.equal(
    (await resumed.ingest(sample(), other, "accessibility")).status,
    201,
  );
  assert.equal((await (await resumed.api("/api/leads")).json()).total, 2);
});
test("site, Cyrillic search, literal wildcards, status sorting and pagination retain every record", async (t) => {
  const s = await fixture(t),
    token = await s.key();
  for (let i = 0; i < 53; i++)
    await s.ingest(
      sample({
        eventId: "test-" + i,
        name: i === 52 ? "Яна_100%" : "Анна",
        createdAt: new Date(Date.UTC(2026, 10, 18, 9, i)).toISOString(),
      }),
      token,
    );
  const found = await (
    await s.api("/api/leads?q=" + encodeURIComponent("ЯНА_100%"))
  ).json();
  assert.equal(found.total, 1);
  const first = await (await s.api("/api/leads?site=security")).json(),
    second = await (await s.api("/api/leads?site=security&page=2")).json();
  assert.equal(first.leads.length, 50);
  assert.equal(second.leads.length, 3);
  assert.equal(
    new Set([...first.leads, ...second.leads].map((l) => l.id)).size,
    53,
  );
  assert.equal(
    (await (await s.api("/api/leads?site=accessibility")).json()).total,
    0,
  );
  const id = first.leads[0].id;
  await s.api("/api/leads/" + id, "PATCH", {
    requestId: randomUUID(),
    version: 1,
    status: "processed",
    note: "Готово",
  });
  const sorted = await (await s.api("/api/leads?order=status&page=2")).json();
  assert.equal(sorted.leads.at(-1).id, id);
  assert.equal(
    (await (await s.api("/api/leads?status=processed")).json()).total,
    1,
  );
});
test("malformed leads and oversized bodies are rejected and no source is silently marked connected", async (t) => {
  let clock = Date.now();
  const s = await fixture(t, undefined, () => clock),
    token = await s.key();
  for (const override of [
    { eventId: "bad/id" },
    { createdAt: "yesterday" },
    { pageUrl: "javascript:alert(1)" },
    { pageUrl: "not a url" },
    { fields: Array(101).fill({ label: "x", value: "y" }) },
  ])
    assert.equal((await s.ingest(sample(override), token)).status, 400);
  assert.equal(
    (await s.ingest(sample({ message: "x".repeat(150000) }), token)).status,
    413,
  );
  const heartbeat = (body) =>
    fetch(s.base + "/hooks/leads/security/heartbeat", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  await heartbeat({
    pending: 1,
    rejected: 0,
    scanOk: true,
    oldestPendingAt: new Date(clock).toISOString(),
  });
  const state = async () =>
    (await (await s.api("/api/leads/sites")).json()).sites.find(
      (x) => x.id === "security",
    ).connection;
  assert.equal(await state(), "online");
  clock += 121000;
  assert.equal(await state(), "offline");
  await heartbeat({ pending: 1, rejected: 1, scanOk: false });
  assert.equal(await state(), "attention");
});
test("new sites can be added without changing code and their keys are never stored in plaintext", async (t) => {
  const s = await fixture(t);
  const response = await s.api("/api/leads/sites", "POST", {
    name: "Новый проект",
    host: "new-project.ru",
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(
    (await s.ingest(sample(), created.token, created.siteId)).status,
    201,
  );
  const saved = s.app.locals.db
    .prepare("SELECT * FROM sales_sites WHERE id=?")
    .get(created.siteId);
  assert.notEqual(saved.token_hash, created.token);
  assert.equal(
    (
      await s.api("/api/leads/sites", "POST", {
        name: "Другой",
        host: "new-project.ru",
      })
    ).status,
    409,
  );
});

test("agent retains a timed-out accepted sale and restart replays it without resetting sales work", async (t) => {
  const s = await fixture(t),
    token = await s.key(),
    sourceFile = join(s.directory, "source.jsonl"),
    payload = sample();
  await writeFile(sourceFile, JSON.stringify(payload) + "\n");
  let time = Date.now(),
    loseResponse = true;
  const args = {
    stateDir: join(s.directory, "agent"),
    sourceFile,
    format: "generic-jsonl",
    endpoint: s.base + "/hooks/leads/security",
    token,
    host: "pasport-bezopasnosty.ru",
    allowLoopback: true,
    now: () => time,
    fetcher: async (url, options) => {
      const response = await fetch(url, options);
      if (loseResponse && !url.endsWith("/heartbeat")) {
        loseResponse = false;
        throw new Error("lost acknowledgement");
      }
      return response;
    },
  };
  const agent = s.track(new LeadAgent(args));
  await agent.tick();
  assert.equal(agent.summary().pending, 1);
  const lead = (await (await s.api("/api/leads")).json()).leads[0];
  await s.api("/api/leads/" + lead.id, "PATCH", {
    requestId: randomUUID(),
    version: 1,
    status: "working",
    note: "Уже звоним",
  });
  agent.close();
  time += 10000;
  const resumed = s.track(new LeadAgent(args));
  await resumed.tick();
  assert.equal(resumed.summary().pending, 0);
  const result = await (await s.api("/api/leads")).json();
  assert.equal(result.total, 1);
  assert.equal(result.leads[0].note, "Уже звоним");
});
test("offline hub and invalid acknowledgements retain queue; malformed source records are visible", async (t) => {
  const { directory, track } = await agentFixture(t, "lead-agent-");
  const sourceFile = join(directory, "leads.jsonl");
  await writeFile(sourceFile, JSON.stringify(sample()) + "\n{broken\n");
  const agent = new LeadAgent({
    stateDir: join(directory, "state"),
    sourceFile,
    format: "generic-jsonl",
    endpoint: "https://hub.example/hooks/leads/security",
    token: "a".repeat(64),
    host: "site.example",
    fetcher: async () =>
      Response.json({
        ok: true,
        id: "wrong",
        eventId: "wrong",
        siteId: "security",
      }),
  });
  track(agent);
  await agent.tick();
  assert.equal(agent.summary().pending, 1);
  assert.equal(agent.summary().rejected, 2);
  assert.equal(agent.summary().scanOk, false);
  assert.equal(
    agent.db.prepare("SELECT delivered FROM outbox").get().delivered,
    0,
  );
});
test("read-only SQLite scanning and quiz mapping preserve contact and extra form data", async (t) => {
  const { directory, track } = await agentFixture(t, "lead-source-");
  const sourceFile = join(directory, "source.sqlite"),
    db = new DatabaseSync(sourceFile);
  db.exec("CREATE TABLE leads(id TEXT,payload TEXT,created_at TEXT)");
  db.prepare("INSERT INTO leads VALUES(?,?,?)").run(
    "source-1",
    JSON.stringify({
      name: "Анна",
      phone: "89991234567",
      serviceTitle: "Паспорт доступности",
      questions: [{ question: "Тип объекта", answers: [{ label: "Школа" }] }],
      attachments: [{ name: "План.pdf" }],
    }),
    "2026-11-18T10:00:00.000Z",
  );
  installAccessibilityOutbox(db);
  installAccessibilityOutbox(db);
  db.exec("BEGIN");
  db.prepare("INSERT INTO leads VALUES(?,?,?)").run(
    "rollback-lead",
    "{}",
    "2026-11-18T10:00:00Z",
  );
  db.exec("ROLLBACK");
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM boykov_lead_outbox").get().n,
    1,
  );
  db.prepare("INSERT INTO leads VALUES(?,?,?)").run(
    "trigger-lead",
    JSON.stringify({ name: "Пётр", phone: "89991112233" }),
    "2026-11-18T11:00:00Z",
  );
  db.exec("DELETE FROM leads");
  db.close();
  const before = await readFile(sourceFile);
  const agent = new LeadAgent({
    stateDir: join(directory, "state"),
    sourceFile,
    format: "accessibility-sqlite",
    endpoint: "https://hub.example/hooks/leads/accessibility",
    token: "a".repeat(64),
    host: "pasport-dostupnosty.ru",
  });
  track(agent);
  await agent.scan();
  const data = JSON.parse(
    agent.db
      .prepare("SELECT payload FROM outbox WHERE event_id='source-1'")
      .get().payload,
  );
  assert.equal(data.phone, "89991234567");
  assert.ok(data.fields.some((f) => f.value === "Школа"));
  assert.ok(data.fields.some((f) => f.value.includes("План.pdf")));
  assert.deepEqual(await readFile(sourceFile), before);
  const quiz = mapRecord(
    {
      id: "quiz-1",
      receivedAt: "2026-11-18T10:00:00.000Z",
      source: "quiz",
      data: {
        answers: {
          contact: {
            name: "Иван",
            phone: "89991234567",
            email: "test@example.ru",
          },
          objectType: { selected: "Школа" },
        },
      },
    },
    "security-jsonl",
    "pasport-bezopasnosty.ru",
  );
  assert.equal(quiz.name, "Иван");
  assert.equal(quiz.fields[0].label, "Тип объекта");
});

test("legacy submissions without contact fields are retained for manual review", async (t) => {
  const s = await fixture(t),
    token = await s.key();
  const response = await s.ingest(
    sample({
      phone: "",
      email: "",
      message: "Номер указан в дополнительных полях",
      fields: [{ label: "Контактный номер", value: "89990000000" }],
    }),
    token,
  );
  assert.equal(response.status, 201);
  const ack = await response.json();
  const detail = await (await s.api("/api/leads/" + ack.id)).json();
  assert.equal(detail.lead.fields[0].value, "89990000000");
});

test("a saved agent queue cannot be rebound to a different website", async (t) => {
  const { directory, track } = await agentFixture(t, "agent-binding-");
  const settings = {
    stateDir: join(directory, "state"),
    sourceFile: join(directory, "source.jsonl"),
    format: "generic-jsonl",
    endpoint: "https://hub.example/hooks/leads/security",
    token: "a".repeat(64),
    host: "site.example",
  };
  const agent = track(new LeadAgent(settings));
  agent.enqueue(sample());
  agent.close();
  assert.throws(
    () =>
      new LeadAgent({
        ...settings,
        endpoint: "https://hub.example/hooks/leads/accessibility",
      }),
    /AGENT_STATE_BELONGS_TO_ANOTHER_SOURCE/,
  );
  const resumed = track(new LeadAgent({ ...settings, token: "b".repeat(64) }));
  assert.equal(resumed.summary().pending, 1);
});
