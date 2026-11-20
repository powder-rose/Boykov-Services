import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { accountFixture } from "./helpers/accounts-fixture.js";
import {
  DocsCustomerAgent,
  validateDocsConnection,
} from "../integrations/docs-customers/agent.mjs";
import { DOCS_CUSTOMERS_SINCE } from "../shared/docs-customers.js";
const stamp = "2026-11-19T08:00:00.000Z";
const event = (overrides = {}) => ({
  eventId: randomUUID(),
  kind: "registration",
  occurredAt: stamp,
  observedAt: stamp,
  user: {
    id: "docs-user-01",
    name: "Пользователь А",
    email: "a@example.ru",
    phone: "+7 999 111-22-33",
    registeredAt: stamp,
  },
  ...overrides,
});
const profile = (name = "ООО Тест") => ({
  savedAt: "2026-11-19T09:00:00.000Z",
  companyName: name,
  inn: "7701234567",
  headPosition: "Директор",
  headFullName: "Руководитель А",
  occupationalSafetyPosition: "Инженер",
  occupationalSafetyFullName: "Ответственный А",
});
async function fixture(t) {
  const s = await accountFixture(t);
  const key = await (
    await s.api("/docs-customers/connection/key", "POST", {})
  ).json();
  const hook = (body, path = "", token = key.token) =>
    fetch(s.base + "/hooks/docs-customers" + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify(body),
    });
  const ingest = async (e) => {
    const r = await hook(e);
    assert.equal(r.status, 201, await r.clone().text());
    return r.json();
  };
  const detail = async (id, cookie) => {
    const r = await s.api("/docs-customers/" + id, "GET", undefined, cookie);
    assert.equal(r.status, 200);
    return r.json();
  };
  return { ...s, key, hook, ingest, detail };
}
test("BoykovDocs intake and customer details require the correct key and workspace session; only admin issues keys", async (t) => {
  const s = await fixture(t);
  const shared = await s.login(null);
  const user = await s.make("docs.sales");
  const cookie = await s.login(user.login);
  assert.equal((await s.request("/docs-customers")).status, 401);
  assert.equal((await s.request("/docs-customers/connection")).status, 401);
  assert.equal((await s.hook(event(), "", "0".repeat(64))).status, 401);
  for (const c of [shared, cookie])
    assert.equal(
      (await s.api("/docs-customers/connection/key", "POST", {}, c)).status,
      403,
    );
  const ack = await s.ingest(event());
  assert.equal(
    (await s.request("/docs-customers/" + ack.customerId)).status,
    401,
  );
  const r = await s.api("/docs-customers");
  assert.match(r.headers.get("cache-control"), /no-store/);
  const text = JSON.stringify(await r.json());
  assert.ok(!text.includes(s.key.token));
  assert.ok(!text.includes("token_hash"));
  assert.equal((await s.api("/docs-customers/connection")).status, 200);
  assert.equal(
    (await (await s.hook({}, "/handshake")).json()).since,
    DOCS_CUSTOMERS_SINCE,
  );
  const next = await (
    await s.api("/docs-customers/connection/key", "POST", {})
  ).json();
  assert.equal(next.since, DOCS_CUSTOMERS_SINCE);
  assert.equal((await s.hook({}, "/handshake")).status, 401);
});
test("fixed Moscow cutoff excludes old data; a fresh company save by an old account is linked to that account", async (t) => {
  const s = await fixture(t);
  const e = event({
    occurredAt: "2026-11-18T20:59:59.000Z",
    user: { ...event().user, registeredAt: "2026-11-18T20:59:59.000Z" },
  });
  const ignored = await (await s.hook(e)).json();
  assert.equal(ignored.ignored, true);
  assert.equal((await (await s.api("/docs-customers")).json()).total, 0);
  const fresh = event({
    occurredAt: DOCS_CUSTOMERS_SINCE,
    user: { ...event().user, registeredAt: DOCS_CUSTOMERS_SINCE },
  });
  await s.ingest(fresh);
  const oldUser = {
    ...event().user,
    id: "old-account",
    registeredAt: "2026-01-01T09:00:00.000Z",
  };
  const ack = await s.ingest(
    event({
      kind: "company",
      occurredAt: profile().savedAt,
      user: oldUser,
      company: profile(),
    }),
  );
  const d = await s.detail(ack.customerId);
  assert.equal(d.customer.externalId, "old-account");
  assert.equal(d.customer.registeredAt, oldUser.registeredAt);
  assert.equal(d.companyHistory[0].user.id, "old-account");
  await s.restart();
  assert.equal(
    (await (await s.api("/docs-customers/connection")).json()).since,
    DOCS_CUSTOMERS_SINCE,
  );
});
test("companies belong to immutable source user IDs, including identical names, email and INN; replay is idempotent", async (t) => {
  const s = await fixture(t),
    e = event({
      kind: "company",
      occurredAt: profile().savedAt,
      company: profile(),
    }),
    a = await s.ingest(e);
  const b = await s.ingest({
    ...e,
    eventId: randomUUID(),
    user: { ...e.user, id: "docs-user-02" },
    company: profile("Компания второго пользователя"),
  });
  assert.notEqual(a.customerId, b.customerId);
  assert.equal(
    (await s.detail(a.customerId)).customer.company.companyName,
    "ООО Тест",
  );
  assert.equal(
    (await s.detail(b.customerId)).companyHistory[0].user.id,
    "docs-user-02",
  );
  assert.equal((await s.hook(e)).status, 200);
  assert.equal(
    (await s.hook({ ...e, company: profile("Подмена") })).status,
    409,
  );
  assert.equal((await s.detail(a.customerId)).companyHistory.length, 1);
  const newer = {
    ...e,
    eventId: randomUUID(),
    occurredAt: "2026-11-19T11:00:00.000Z",
    observedAt: "2026-11-19T11:01:00.000Z",
    company: {
      ...profile("Новая компания"),
      savedAt: "2026-11-19T11:00:00.000Z",
    },
  };
  await s.ingest(newer);
  await s.ingest({
    ...e,
    eventId: randomUUID(),
    observedAt: "2026-11-19T10:00:00.000Z",
    user: { ...e.user, name: "Старое имя" },
  });
  const d = await s.detail(a.customerId);
  assert.equal(d.customer.company.companyName, "Новая компания");
  assert.equal(d.customer.name, e.user.name);
  assert.equal(d.companyHistory.length, 3);
  assert.ok(d.companyHistory.every((v) => v.user.id === e.user.id));
});
test("call author is server identity; retries do not duplicate calls, stale writes conflict, profile updates preserve calls", async (t) => {
  const s = await fixture(t),
    user = await s.make("docs.manager", "Менеджер А"),
    cookie = await s.login(user.login),
    ack = await s.ingest(event());
  const d = await s.detail(ack.customerId),
    body = {
      requestId: randomUUID(),
      version: d.customer.version,
      outcome: "callback",
      note: "Первая строка\nВторая строка",
      actor: { name: "Поддельный автор" },
    };
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await s.api(
          "/docs-customers/" + ack.customerId + "/calls",
          "POST",
          body,
          cookie,
        )
      ).status,
      200,
    );
  let value = await s.detail(ack.customerId);
  assert.equal(value.customer.callCount, 1);
  assert.equal(value.calls[0].actor.name, "Менеджер А");
  assert.equal(value.calls[0].actor.id, user.id);
  assert.equal(value.calls[0].note, body.note);
  assert.equal(
    (
      await s.api(
        "/docs-customers/" + ack.customerId + "/calls",
        "POST",
        { ...body, requestId: randomUUID() },
        cookie,
      )
    ).status,
    409,
  );
  await s.ingest(
    event({
      kind: "company",
      occurredAt: profile().savedAt,
      observedAt: "2026-11-19T09:00:00.000Z",
      company: profile(),
    }),
  );
  value = await s.detail(ack.customerId);
  assert.equal(value.customer.callCount, 1);
  assert.equal(value.customer.lastCall.actor.name, "Менеджер А");
  const mine = await (
    await s.api("/docs-customers?mine=1", "GET", undefined, cookie)
  ).json();
  assert.equal(mine.total, 1);
});
test("sales can void only their own call; audit retains author, shared access remains identifiable", async (t) => {
  const s = await fixture(t),
    a = await s.make("docs.a", "Менеджер А"),
    b = await s.make("docs.b", "Менеджер Б"),
    ca = await s.login(a.login),
    cb = await s.login(b.login),
    shared = await s.login(null),
    ack = await s.ingest(event());
  const call = await (
    await s.api(
      "/docs-customers/" + ack.customerId + "/calls",
      "POST",
      { requestId: randomUUID(), version: 1, outcome: "no_answer", note: "" },
      ca,
    )
  ).json();
  let d = await s.detail(ack.customerId);
  const path =
    "/docs-customers/" + ack.customerId + "/calls/" + call.callId + "/void";
  assert.equal(
    (
      await s.api(
        path,
        "POST",
        { requestId: randomUUID(), version: d.customer.version },
        cb,
      )
    ).status,
    403,
  );
  const body = { requestId: randomUUID(), version: d.customer.version };
  assert.equal((await s.api(path, "POST", body, ca)).status, 200);
  assert.equal((await s.api(path, "POST", body, ca)).status, 200);
  d = await s.detail(ack.customerId);
  assert.equal(d.customer.callCount, 0);
  assert.equal(d.calls[0].voidedBy.name, a.name);
  assert.equal(d.calls[0].actor.name, a.name);
  assert.equal(
    (
      await s.api(
        "/docs-customers/" + ack.customerId + "/calls",
        "POST",
        {
          requestId: randomUUID(),
          version: d.customer.version,
          outcome: "reached",
        },
        shared,
      )
    ).status,
    200,
  );
  d = await s.detail(ack.customerId);
  assert.equal(d.customer.lastCall.actor.name, "Общий доступ");
  assert.equal(d.customer.lastCall.actor.id, null);
  assert.equal(
    (await s.api("/docs-customers?mine=1", "GET", undefined, shared)).status,
    400,
  );
  assert.equal(
    (await (await s.api("/docs-customers?status=uncalled")).json()).total,
    0,
  );
  assert.equal(
    (await (await s.api("/docs-customers?status=called")).json()).total,
    1,
  );
});
test("search covers Cyrillic, contacts and company INN; invalid incoming data is rejected without partial writes", async (t) => {
  const s = await fixture(t);
  await s.ingest(
    event({
      kind: "company",
      occurredAt: profile().savedAt,
      company: profile(),
    }),
  );
  for (const q of ["ПОЛЬЗОВАТЕЛЬ", "7701234567", "a@example.ru", "79991112233"])
    assert.equal(
      (await (await s.api("/docs-customers?q=" + encodeURIComponent(q))).json())
        .total,
      1,
    );
  assert.equal((await (await s.api("/docs-customers?q=%25")).json()).total, 0);
  for (const e of [
    event({ user: { ...event().user, id: "../bad" } }),
    event({
      kind: "company",
      occurredAt: profile().savedAt,
      company: { ...profile(), inn: "123" },
    }),
    event({ observedAt: "bad" }),
  ])
    assert.equal((await s.hook(e)).status, 400);
  assert.equal((await (await s.api("/docs-customers")).json()).total, 1);
});
async function agentFixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "docs-customer-agent-"));
  await mkdir(join(dir, "source"));
  const sourceDir = join(dir, "source"),
    stateDir = join(dir, "state");
  let clock = Date.parse("2026-11-19T12:00:00.000Z");
  const agents = [];
  t.after(async () => {
    for (const a of agents) {
      try {
        a.close();
      } catch {}
    }
    await rm(dir, { recursive: true, force: true });
  });
  const users = [
    {
      id: "new-user",
      name: "Пользователь А",
      email: "a@example.ru",
      phone: "79991234567",
      createdAt: stamp,
      passwordHash: "NEVER_COPY_PASSWORD",
      verificationTokenHash: "NEVER_COPY_TOKEN",
    },
    {
      id: "old-user",
      name: "Старый пользователь",
      email: "old@example.ru",
      phone: "",
      createdAt: "2026-11-01T10:00:00.000Z",
    },
  ];
  const profiles = {
    version: 1,
    profiles: {
      "new-user": { companyProfile: profile(), updatedAt: profile().savedAt },
      "old-user": {
        companyProfile: profile("Историческая компания"),
        updatedAt: "2026-11-01T10:00:00.000Z",
      },
    },
    outbox: [{ secret: "NEVER_COPY_MAIL" }],
  };
  const save = async () => {
    await writeFile(join(sourceDir, "users.json"), JSON.stringify(users));
    await writeFile(
      join(sourceDir, "company-profiles.json"),
      JSON.stringify(profiles),
    );
  };
  await save();
  const config = {
    endpoint: "https://boykov-services.ru/hooks/docs-customers",
    token: "a".repeat(64),
    since: DOCS_CUSTOMERS_SINCE,
    sourceDir,
    stateDir,
  };
  const fetcher = async (url, options) => {
    const p = JSON.parse(options.body);
    return Response.json(
      url.endsWith("/heartbeat")
        ? { ok: true, source: "boykovdocs.ru" }
        : {
            ok: true,
            eventId: p.eventId,
            externalId: p.user.id,
            customerId: "customer-" + p.user.id,
          },
    );
  };
  const start = (options = {}) => {
    const a = new DocsCustomerAgent(config, {
      now: () => clock,
      fetcher,
      ...overrides,
      ...options,
    });
    agents.push(a);
    return a;
  };
  return {
    dir,
    users,
    profiles,
    save,
    config,
    start,
    tick: () => {
      clock += 1000000;
    },
    payloads: (a) =>
      a.db
        .prepare("SELECT payload FROM outbox")
        .all()
        .map((r) => JSON.parse(r.payload)),
  };
}
test("read-only source collector whitelists fields, excludes old history and links each company by profile map user ID", async (t) => {
  const s = await agentFixture(t),
    a = s.start();
  const before = await readFile(join(s.config.sourceDir, "users.json"), "utf8");
  a.scan();
  const rows = s.payloads(a);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((e) => e.user.id === "new-user"));
  assert.ok(!JSON.stringify(rows).includes("NEVER_COPY"));
  assert.equal(
    await readFile(join(s.config.sourceDir, "users.json"), "utf8"),
    before,
  );
  a.scan();
  assert.equal(s.payloads(a).length, 2);
  s.profiles.profiles["old-user"].updatedAt = "2026-11-19T10:00:00.000Z";
  await s.save();
  a.scan();
  assert.equal(s.payloads(a).at(-1).user.id, "old-user");
  assert.equal(
    s.payloads(a).at(-1).company.companyName,
    "Историческая компания",
  );
  await a.cycle();
  assert.equal(a.status().pending, 0);
  a.close();
  const b = s.start();
  b.scan();
  assert.equal(s.payloads(b).length, 3);
  assert.equal(b.status().pending, 0);
});
test("durable delivery retries after lost ACK with same event ID and survives process restart", async (t) => {
  let mode = "lost",
    first = [];
  const s = await agentFixture(t, {
      fetcher: async (url, options) => {
        const p = JSON.parse(options.body);
        if (url.endsWith("/heartbeat"))
          return Response.json({ ok: true, source: "boykovdocs.ru" });
        first.push(p.eventId);
        if (mode === "lost") throw Error("simulated");
        return Response.json({
          ok: true,
          eventId: p.eventId,
          externalId: p.user.id,
          customerId: "saved",
        });
      },
    }),
    a = s.start();
  a.scan();
  await a.deliver();
  assert.equal(a.status().pending, 2);
  a.close();
  mode = "ok";
  s.tick();
  const b = s.start();
  await b.cycle();
  assert.equal(b.status().pending, 0);
  assert.ok(first.slice(1).includes(first[0]));
});
test("invalid acknowledgement and malformed company snapshot retain events and expose delivery problems", async (t) => {
  const s = await agentFixture(t),
    a = s.start({ fetcher: async () => Response.json({ ok: true }) });
  a.scan();
  await a.deliver();
  assert.equal(a.status().pending, 2);
  assert.equal(a.status().rejected, 2);
  await writeFile(join(s.config.sourceDir, "company-profiles.json"), "{broken");
  a.scan();
  assert.equal(a.status().scanOk, false);
  assert.equal(a.status().errorCode, "companies_read_failed");
  assert.equal(a.status().pending, 2);
});
test("collector validates HTTPS endpoints and pins durable queue to source and cutoff", async (t) => {
  const s = await agentFixture(t);
  for (const endpoint of [
    "http://boykov-services.ru/hooks/docs-customers",
    "https://boykov-services.ru/hooks/docs-customers?token=x",
    "https://other/x",
  ])
    assert.throws(() => validateDocsConnection({ ...s.config, endpoint }));
  const a = s.start();
  a.close();
  assert.throws(
    () =>
      new DocsCustomerAgent({ ...s.config, since: "2026-11-19T00:00:00.000Z" }),
    /ANOTHER_SOURCE/,
  );
});

test("customer trash preserves the exact user's company and calls; intake and restart cannot resurrect it", async (t) => {
  const s = await fixture(t),
    manager = await s.make("docs.trash", "Менеджер удаления"),
    cookie = await s.login(manager.login);
  const first = event({
      kind: "company",
      occurredAt: profile().savedAt,
      company: profile(),
    }),
    ack = await s.ingest(first);
  const other = await s.ingest({
    ...first,
    eventId: randomUUID(),
    user: { ...first.user, id: "another-user" },
  });
  let d = await s.detail(ack.customerId);
  await s.api(
    "/docs-customers/" + ack.customerId + "/calls",
    "POST",
    {
      requestId: randomUUID(),
      version: d.customer.version,
      outcome: "reached",
      note: "Сохранить историю",
    },
    cookie,
  );
  d = await s.detail(ack.customerId);
  assert.equal(
    (
      await s.api(
        "/docs-customers/" + ack.customerId + "/trash",
        "POST",
        {
          requestId: randomUUID(),
          version: d.customer.version,
          action: "delete",
          actor: { name: "Подмена" },
        },
        cookie,
      )
    ).status,
    200,
  );
  let active = await (await s.api("/docs-customers")).json();
  assert.equal(active.total, 1);
  assert.equal(active.customers[0].id, other.customerId);
  assert.equal(active.trashCount, 1);
  assert.deepEqual(active.stats, {
    total: 1,
    companies: 1,
    uncalled: 1,
    called: 0,
  });
  let trash = await (await s.api("/docs-customers?view=trash")).json();
  assert.equal(trash.total, 1);
  assert.equal(trash.customers[0].deletedBy.name, manager.name);
  assert.equal((await s.hook(first)).status, 200);
  await s.restart();
  const update = {
    ...first,
    eventId: randomUUID(),
    observedAt: "2026-11-19T11:01:00.000Z",
    occurredAt: "2026-11-19T11:00:00.000Z",
    company: {
      ...profile("Обновлённая компания"),
      savedAt: "2026-11-19T11:00:00.000Z",
    },
  };
  await s.ingest(update);
  active = await (await s.api("/docs-customers?company=1")).json();
  assert.equal(active.total, 1);
  assert.equal(active.trashCount, 1);
  d = await s.detail(ack.customerId);
  assert.ok(d.customer.deletedAt);
  assert.equal(d.customer.company.companyName, "Обновлённая компания");
  assert.equal(d.customer.externalId, first.user.id);
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].actor.name, manager.name);
  assert.equal(d.calls[0].canVoid, false);
  assert.equal(
    (
      await s.api("/docs-customers/" + ack.customerId + "/calls", "POST", {
        requestId: randomUUID(),
        version: d.customer.version,
        outcome: "reached",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await s.api(
        "/docs-customers/" +
          ack.customerId +
          "/calls/" +
          d.calls[0].id +
          "/void",
        "POST",
        { requestId: randomUUID(), version: d.customer.version },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await s.api(
        "/docs-customers/" + ack.customerId + "/trash",
        "POST",
        {
          requestId: randomUUID(),
          version: d.customer.version,
          action: "restore",
        },
        cookie,
      )
    ).status,
    200,
  );
  d = await s.detail(ack.customerId);
  assert.equal(d.customer.deletedAt, null);
  assert.equal(d.customer.deletedBy, null);
  assert.equal(d.calls.length, 1);
  assert.deepEqual(
    d.lifecycle.map((v) => v.action),
    ["restore", "delete"],
  );
  assert.ok(d.lifecycle.every((v) => v.actor.id === manager.id));
  active = await (await s.api("/docs-customers")).json();
  assert.equal(active.total, 2);
  assert.equal(active.stats.called, 1);
  assert.equal(active.trashCount, 0);
});
test("trash mutations require a session, validate action and version and remain idempotent after an uncertain response", async (t) => {
  const s = await fixture(t),
    a = await s.make("docs.delete.a"),
    b = await s.make("docs.delete.b"),
    ca = await s.login(a.login),
    cb = await s.login(b.login),
    ack = await s.ingest(event());
  const path = "/docs-customers/" + ack.customerId + "/trash",
    body = { requestId: randomUUID(), version: 1, action: "delete" };
  assert.equal((await s.request(path, "POST", body)).status, 401);
  for (const bad of [
    { ...body, version: 0 },
    { ...body, action: "purge" },
    { ...body, requestId: "bad" },
  ])
    assert.equal((await s.api(path, "POST", bad, ca)).status, 400);
  assert.equal((await s.api(path, "POST", body, ca)).status, 200);
  assert.equal((await s.api(path, "POST", body, ca)).status, 200);
  assert.equal((await s.api(path, "POST", body, cb)).status, 409);
  assert.equal(
    (await s.api(path, "POST", { ...body, action: "restore" }, ca)).status,
    409,
  );
  assert.equal(
    (await s.api(path, "POST", { ...body, requestId: randomUUID() }, ca))
      .status,
    409,
  );
  let d = await s.detail(ack.customerId);
  assert.equal(d.lifecycle.length, 1);
  const restore = {
    requestId: randomUUID(),
    version: d.customer.version,
    action: "restore",
  };
  assert.equal((await s.api(path, "POST", restore, cb)).status, 200);
  assert.equal((await s.api(path, "POST", restore, cb)).status, 200);
  // Replaying an old delete after a later restore acknowledges the old operation without deleting again.
  assert.equal((await s.api(path, "POST", body, ca)).status, 200);
  d = await s.detail(ack.customerId);
  assert.equal(d.customer.deletedAt, null);
  assert.equal(d.lifecycle.length, 2);
  assert.equal(d.lifecycle[0].actor.id, b.id);
});
test("stale removal conflicts with a newer company save and shared access has an honest removal author", async (t) => {
  const s = await fixture(t),
    ack = await s.ingest(event()),
    shared = await s.login(null);
  await s.ingest(
    event({
      kind: "company",
      occurredAt: profile().savedAt,
      company: profile(),
      observedAt: profile().savedAt,
    }),
  );
  const path = "/docs-customers/" + ack.customerId + "/trash";
  assert.equal(
    (
      await s.api(
        path,
        "POST",
        { requestId: randomUUID(), version: 1, action: "delete" },
        shared,
      )
    ).status,
    409,
  );
  let d = await s.detail(ack.customerId);
  assert.equal(d.customer.deletedAt, null);
  assert.equal(
    (
      await s.api(
        path,
        "POST",
        {
          requestId: randomUUID(),
          version: d.customer.version,
          action: "delete",
        },
        shared,
      )
    ).status,
    200,
  );
  d = await s.detail(ack.customerId);
  assert.equal(d.customer.deletedBy.name, "Общий доступ");
  assert.equal(d.customer.deletedBy.id, null);
  assert.equal(d.lifecycle[0].actor.kind, "shared");
  assert.equal(
    (await (await s.api("/docs-customers?q=7701234567")).json()).total,
    0,
  );
  assert.equal(
    (await (await s.api("/docs-customers?view=trash&q=7701234567")).json())
      .total,
    1,
  );
  assert.equal((await s.api("/docs-customers?view=unknown")).status, 400);
});
test("upgrading the pre-trash database keeps customer cards and adds nullable deletion fields exactly once", async (t) => {
  const s = await fixture(t),
    ack = await s.ingest(event());
  s.db.exec("DROP INDEX docs_customers_deleted");
  for (const name of [
    "deleted_at",
    "deleted_by_id",
    "deleted_by_name",
    "deleted_by_kind",
  ])
    s.db.exec("ALTER TABLE docs_customers DROP COLUMN " + name);
  await s.restart();
  let d = await s.detail(ack.customerId);
  assert.equal(d.customer.deletedAt, null);
  assert.equal(d.customer.name, event().user.name);
  await s.restart();
  d = await s.detail(ack.customerId);
  assert.equal(d.customer.deletedAt, null);
  assert.equal((await (await s.api("/docs-customers")).json()).total, 1);
});
