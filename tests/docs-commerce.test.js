import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/auth.js";
import { createInitialAdmin } from "../server/accounts.js";
import {
  DocsCommerceAgent,
  validateCommerceConnection,
} from "../integrations/docs-customers/commerce-agent.mjs";
const NOW = Date.parse("2026-11-20T07:00:00.000Z"),
  password = "docs-sales-fixture-password",
  passwordHash = await hashPassword(password);
const sample = (kind = "generation", changes = {}) => ({
  protocol: 1,
  eventId: randomUUID(),
  observedAt: "2026-11-20T06:00:00.000Z",
  user: {
    id: "buyer-1",
    name: "Анна Тестовая",
    email: "anna@example.invalid",
    phone: "+79991112233",
    registeredAt: "2026-01-01T00:00:00.000Z",
  },
  operation: {
    kind,
    id: randomUUID(),
    title: "Инструкция для электрика",
    amountMinor: 15000,
    currency: "RUB",
    createdAt: "2026-11-19T21:00:00.000Z",
    updatedAt: "2026-11-20T05:00:00.000Z",
    status: "generated",
    generatedAt: "2026-11-20T05:00:00.000Z",
    refundedAt: null,
    referenceId: "wt_1",
    parentId: "bank1",
    ...changes,
  },
});
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "boykov-docs-commerce-"));
  const app = await createApp({
    dataDir: directory,
    passwordHash,
    now: () => NOW,
    secureCookies: false,
    allowedOrigins: [],
    worker: async () => Response.json({ jobs: [], ok: true }),
    isConfigured: () => false,
  });
  await createInitialAdmin(app.locals.db, {
    login: "sales-admin",
    name: "Тестовый администратор",
    password,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    app.locals.db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = (path, method = "GET", body, cookie = "") =>
    fetch(base + "/api" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Boykov-Request": "1",
        Cookie: cookie,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = await request("/auth/login", "POST", {
      login: "sales-admin",
      password,
    }),
    cookie = login.headers.get("set-cookie").split(";")[0];
  const api = (path, method = "GET", body) =>
    request(path, method, body, cookie);
  const token = (
    await (await api("/docs-customers/connection/key", "POST", {})).json()
  ).token;
  const hook = (data, path = "", key = token) =>
    fetch(base + "/hooks/docs-customers/commerce" + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key,
      },
      body: JSON.stringify(data),
    });
  const ingest = async (e) => {
    const r = await hook(e);
    assert.ok([200, 201].includes(r.status), await r.clone().text());
    return r.json();
  };
  const report = async (query) => {
    const r = await api("/docs-commerce/report" + (query ? "?" + query : ""));
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  return { app, base, api, request, token, hook, ingest, report };
}
test("commerce hooks and reports require authentication and never import old CRM profiles", async (t) => {
  const s = await fixture(t);
  for (const path of ["/docs-commerce/report", "/docs-commerce/buyers/buyer-1"])
    assert.equal((await s.request(path)).status, 401);
  assert.equal((await s.hook(sample(), "", "0".repeat(64))).status, 401);
  assert.equal(
    (await (await s.hook({}, "/handshake")).json()).scope,
    "generations-and-topups",
  );
  await s.ingest(sample());
  assert.equal(
    s.app.locals.db.prepare("SELECT count(*) n FROM docs_customers").get().n,
    0,
  );
  assert.equal((await s.report()).summary.count, 1);
  assert.equal((await s.report("kind=topups")).summary.count, 0);
});
test("repeat orders count separately, replays do not; immutable payment changes conflict atomically", async (t) => {
  const s = await fixture(t),
    a = sample(),
    b = sample();
  await s.ingest(a);
  await s.ingest(a);
  await s.ingest(b);
  let r = await s.report();
  assert.equal(r.summary.count, 2);
  assert.equal(r.summary.amountMinor, 30000);
  assert.equal(r.summary.buyers, 1);
  const d = await (await s.api("/docs-commerce/buyers/buyer-1")).json();
  assert.equal(d.documents[0].count, 2);
  assert.equal(d.operations.length, 2);
  for (const edit of [
    { amountMinor: 20000 },
    { createdAt: "2026-11-18T20:00:00.000Z" },
  ])
    assert.equal(
      (
        await s.hook({
          ...a,
          eventId: randomUUID(),
          operation: { ...a.operation, ...edit },
        })
      ).status,
      409,
    );
  assert.equal(
    (await s.hook({ ...a, user: { ...a.user, id: "other-user" } })).status,
    409,
  );
  assert.equal((await s.report()).summary.amountMinor, 30000);
});
test("latest generation state wins even when queue retries deliver older snapshots afterwards", async (t) => {
  const s = await fixture(t),
    a = sample("generation", {
      status: "paid",
      generatedAt: null,
      updatedAt: "2026-11-20T01:00:00.000Z",
    }),
    b = {
      ...a,
      eventId: randomUUID(),
      operation: {
        ...a.operation,
        status: "generated",
        generatedAt: "2026-11-20T02:00:00.000Z",
        updatedAt: "2026-11-20T02:00:00.000Z",
      },
    };
  await s.ingest(b);
  await s.ingest(a);
  const d = await (await s.api("/docs-commerce/buyers/buyer-1")).json();
  assert.equal(d.operations[0].status, "generated");
  assert.equal(d.summary.count, 1);
  assert.equal(
    (
      await s.hook({
        ...b,
        eventId: randomUUID(),
        operation: { ...b.operation, status: "manual_review" },
      })
    ).status,
    409,
  );
});
test("generation refunds belong to refund date rather than historical purchase date", async (t) => {
  const s = await fixture(t),
    a = sample("generation", {
      createdAt: "2026-11-01T10:00:00.000Z",
      status: "refunded",
      refundedAt: "2026-11-20T02:00:00.000Z",
    });
  await s.ingest(a);
  const today = await s.report("period=today");
  assert.equal(today.summary.count, 0);
  assert.equal(today.summary.refundedCount, 1);
  assert.equal(today.summary.refundedAmountMinor, 15000);
  assert.equal(today.buyers.length, 1);
  const all = await s.report();
  assert.equal(all.summary.count, 1);
  assert.equal(all.summary.amountMinor, 15000);
  assert.equal(all.summary.refundedAmountMinor, 15000);
});
test("topups use confirmed payment IDs; partial refunds reconcile even when delivered before payment", async (t) => {
  const s = await fixture(t),
    p = sample("topup", {
      id: "bank1",
      amountMinor: 50000,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    }),
    r = sample("topup-refund", {
      amountMinor: 10000,
      createdAt: "2026-11-20T01:00:00.000Z",
      updatedAt: "2026-11-20T01:00:00.000Z",
    });
  await s.ingest(r);
  await s.ingest(p);
  await s.ingest(p);
  let all = await s.report("kind=topups");
  assert.equal(all.summary.count, 1);
  assert.equal(all.summary.amountMinor, 50000);
  assert.equal(all.summary.refundedAmountMinor, 10000);
  const today = await s.report("kind=topups&period=today");
  assert.equal(today.summary.count, 0);
  assert.equal(today.summary.refundedAmountMinor, 10000);
  assert.equal(today.buyers.length, 1);
  assert.equal(
    (
      await s.hook(
        sample("topup-refund", {
          amountMinor: 45000,
          createdAt: "2026-11-20T02:00:00.000Z",
          updatedAt: "2026-11-20T02:00:00.000Z",
        }),
      )
    ).status,
    409,
  );
  assert.equal(
    (await s.report("kind=topups")).summary.refundedAmountMinor,
    10000,
  );
});
test("guest orders remain separate from registered buyer counts and cannot steal a registered order", async (t) => {
  const s = await fixture(t),
    a = sample();
  a.user = null;
  a.operation.contactEmail = "guest@example.invalid";
  await s.ingest(a);
  const r = await s.report();
  assert.equal(r.summary.count, 1);
  assert.equal(r.summary.buyers, 0);
  assert.equal(r.summary.guestOrders, 1);
  assert.equal(r.buyers[0].externalId, null);
  assert.equal(r.buyers[0].customerId, null);
  const b = sample();
  await s.ingest(b);
  assert.equal(
    (
      await s.hook({
        ...b,
        user: null,
        eventId: randomUUID(),
        operation: { ...b.operation, updatedAt: "2026-11-20T06:00:00.000Z" },
      })
    ).status,
    409,
  );
});
test("periods, literal search and pagination apply to people and grouped documents without truncation", async (t) => {
  const s = await fixture(t);
  for (let i = 0; i < 27; i++) {
    const a = sample("generation", { title: "Документ " + i });
    a.user = {
      ...a.user,
      id: "buyer_" + i,
      name: i === 0 ? "Тест %_" : "Человек " + i,
    };
    await s.ingest(a);
  }
  const r = await s.report();
  assert.equal(r.total, 27);
  assert.equal(r.buyers.length, 25);
  assert.equal((await s.report("page=2")).buyers.length, 2);
  assert.equal((await s.report("q=" + encodeURIComponent("%_"))).total, 1);
  for (const q of ["period=broken", "kind=wrong", "page=-1", "sort=sql"])
    assert.equal((await s.api("/docs-commerce/report?" + q)).status, 400);
  for (let i = 0; i < 27; i++)
    await s.ingest(sample("generation", { title: "Инструкция " + i }));
  const d = await (
    await s.api("/docs-commerce/buyers/buyer-1?groupsPage=2&page=2")
  ).json();
  assert.equal(d.groupCount, 27);
  assert.equal(d.documents.length, 2);
  assert.equal(d.operations.length, 2);
});
async function source(t, { removeTree = rm } = {}) {
  const root = await mkdtemp(join(tmpdir(), "docs-commerce-source-")),
    data = join(root, "source"),
    orders = join(root, "orders"),
    stateDir = join(root, "state");
  await mkdir(data);
  await mkdir(orders);
  const agents = new Set();
  const closeAgent = (agent) => {
    if (!agents.has(agent)) return;
    agent.close();
    agents.delete(agent);
  };
  t.after(async () => {
    // Windows cannot unlink SQLite/WAL files while a collector holds the database open.
    for (const agent of agents) closeAgent(agent);
    await removeTree(root, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 100,
    });
  });
  const users = [
    {
      id: "buyer-1",
      name: "Анна",
      email: "anna@example.invalid",
      createdAt: "2026-01-01T00:00:00.000Z",
      passwordHash: "PRIVATE_HASH",
    },
  ];
  const wallet = {
    version: 1,
    topups: [
      {
        id: "wt_1",
        userId: "buyer-1",
        amountMinor: 50000,
        currency: "RUB",
        consent: { secret: "PRIVATE_CONSENT" },
      },
    ],
    payments: [
      {
        id: "bank1",
        orderId: "wt_1",
        userId: "buyer-1",
        amountMinor: 50000,
        createdAt: "2026-11-19T22:00:00.000Z",
        fiscalEvent: { secret: "PRIVATE_FISCAL" },
      },
    ],
    refunds: [
      {
        id: "refund1",
        orderId: "wt_1",
        paymentId: "bank1",
        userId: "buyer-1",
        amountMinor: 10000,
        createdAt: "2026-11-20T01:00:00.000Z",
      },
    ],
    purchases: [],
  };
  const order = {
    id: "pg_abcdefghijk1",
    ownerUserId: "buyer-1",
    profession: "Инструкция для электрика",
    amount: 150,
    currency: "RUB",
    status: "generated",
    paidAt: "2026-11-19T21:00:00.000Z",
    updatedAt: "2026-11-20T01:00:00.000Z",
    generatedAt: "2026-11-20T01:00:00.000Z",
    transactionId: "gen1",
    fiscalPaymentLive: true,
    accessToken: "PRIVATE_TOKEN",
    generatedInstruction: { id: "doc1", content: "PRIVATE_DOCUMENT" },
  };
  const write = async () => {
    await writeFile(join(data, "users.json"), JSON.stringify(users));
    await writeFile(join(data, "wallets.json"), JSON.stringify(wallet));
    await writeFile(join(orders, order.id + ".json"), JSON.stringify(order));
  };
  await write();
  const config = {
    endpoint: "https://hub.example.invalid/hooks/docs-customers/commerce",
    token: "a".repeat(64),
    sourceDir: data,
    ordersDir: orders,
    stateDir,
  };
  const openAgent = (options) => {
    const agent = new DocsCommerceAgent(config, options);
    agents.add(agent);
    return agent;
  };
  return {
    root,
    data,
    orders,
    stateDir,
    config,
    users,
    wallet,
    order,
    write,
    openAgent,
    closeAgent,
  };
}
test("read-only collector matches actual generation and wallet source shapes and transmits only required data", async (t) => {
  const src = await source(t),
    before = await readFile(join(src.data, "wallets.json"), "utf8");
  const agent = src.openAgent({ now: () => NOW });
  agent.scan();
  assert.equal(agent.status().scanOk, true);
  assert.equal(agent.status().sourceCount, 3);
  const payloads = agent.db
    .prepare("SELECT payload FROM outbox")
    .all()
    .map((r) => JSON.parse(r.payload));
  assert.deepEqual(
    payloads.map((p) => p.operation.kind),
    ["generation", "topup", "topup-refund"],
  );
  assert.equal(payloads[0].operation.amountMinor, 15000);
  assert.equal(payloads[0].user.id, "buyer-1");
  assert.equal(JSON.stringify(payloads).includes("PRIVATE_"), false);
  assert.equal(await readFile(join(src.data, "wallets.json"), "utf8"), before);
  agent.scan();
  assert.equal(agent.db.prepare("SELECT count(*) n FROM outbox").get().n, 3);
});
test("collector excludes test, pending and mismatched orders; repeated real orders remain separate", async (t) => {
  const src = await source(t);
  for (const [n, edit] of [
    [2, { fiscalPaymentLive: false }],
    [3, { status: "pending_payment", paidAt: null }],
    [4, { failureCode: "PAYMENT_MISMATCH" }],
    [5, { transactionId: "second-real" }],
  ]) {
    const o = { ...src.order, id: "pg_abcdefghijk" + n, ...edit };
    await writeFile(join(src.orders, o.id + ".json"), JSON.stringify(o));
  }
  const agent = src.openAgent({ now: () => NOW });
  agent.scan();
  assert.equal(agent.status().sourceCount, 4);
  assert.equal(agent.status().scanOk, true);
});
test("corrupt or missing order sources do not capture partial financial reports or erase delivery history", async (t) => {
  const src = await source(t),
    agent = src.openAgent({ now: () => NOW });
  agent.scan();
  await writeFile(join(src.orders, "pg_abcdefghijk2.json"), "{broken");
  agent.scan();
  assert.equal(agent.status().scanOk, false);
  assert.equal(agent.status().errorCode, "orders_read_failed");
  assert.equal(agent.db.prepare("SELECT count(*) n FROM outbox").get().n, 3);
  await rm(join(src.orders, "pg_abcdefghijk2.json"));
  src.wallet.refunds[0].amountMinor = 90000;
  await src.write();
  agent.scan();
  assert.equal(agent.status().errorCode, "invalid_source_data");
  assert.equal(agent.status().sourceCount, 3);
});
test("durable queue retries safely after an ambiguous successful write and survives restart", async (t) => {
  const s = await fixture(t),
    src = await source(t);
  let ambiguous = true;
  const fetcher = async (url, options) => {
    const suffix = new URL(url).pathname.replace(
      "/hooks/docs-customers/commerce",
      "",
    );
    const result = await s.hook(JSON.parse(options.body), suffix);
    if (!suffix && ambiguous) {
      ambiguous = false;
      throw Error("TIMEOUT_AFTER_COMMIT");
    }
    return result;
  };
  let clock = NOW;
  let agent = src.openAgent({ now: () => clock, fetcher });
  await agent.cycle();
  assert.ok(agent.status().pending > 0);
  src.closeAgent(agent);
  clock += 60000;
  agent = src.openAgent({ now: () => clock, fetcher });
  await agent.cycle();
  assert.equal(agent.status().pending, 0);
  assert.equal((await s.report()).summary.count, 1);
  assert.equal((await s.report("kind=topups")).summary.amountMinor, 50000);
  assert.equal(
    (await s.report("kind=topups")).summary.refundedAmountMinor,
    10000,
  );
  assert.equal(s.app.locals.docsCommerce.connection().status, "online");
});
test("invalid acknowledgements remain queued and source count decreases raise an explicit warning", async (t) => {
  const src = await source(t),
    agent = src.openAgent({
      now: () => NOW,
      fetcher: async () => Response.json({ ok: true }),
    });
  agent.scan();
  await agent.deliver();
  assert.equal(agent.status().rejected, 3);
  src.wallet.payments = [];
  src.wallet.refunds = [];
  await src.write();
  agent.scan();
  assert.equal(agent.status().errorCode, "source_count_decreased");
  assert.throws(() =>
    validateCommerceConnection({
      ...src.config,
      endpoint: "http://hub.example.invalid/hooks/docs-customers/commerce",
    }),
  );
  assert.throws(() =>
    validateCommerceConnection({
      ...src.config,
      endpoint: src.config.endpoint + "?token=oops",
    }),
  );
});
test("a signed Refund recorded before a delayed Pay is preserved rather than rejected by event timestamps", async (t) => {
  const s = await fixture(t),
    src = await source(t);
  src.wallet.refunds[0].createdAt = "2026-11-19T21:30:00.000Z";
  await src.write();
  const agent = src.openAgent({
    now: () => NOW,
    fetcher: async (url, options) =>
      s.hook(
        JSON.parse(options.body),
        new URL(url).pathname.replace("/hooks/docs-customers/commerce", ""),
      ),
  });
  await agent.cycle();
  assert.equal(agent.status().scanOk, true);
  assert.equal(agent.status().pending, 0);
  const r = await s.report("kind=topups");
  assert.equal(r.summary.amountMinor, 50000);
  assert.equal(r.summary.refundedAmountMinor, 10000);
  assert.equal(r.summary.count, 1);
});
test("commerce history links to the exact CRM account and preserves records when that CRM card is trashed", async (t) => {
  const s = await fixture(t),
    e = sample();
  const intake = await fetch(s.base + "/hooks/docs-customers", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + s.token,
    },
    body: JSON.stringify({
      kind: "registration",
      eventId: randomUUID(),
      occurredAt: "2026-11-19T08:00:00.000Z",
      observedAt: "2026-11-19T08:00:00.000Z",
      user: { ...e.user, registeredAt: "2026-11-19T08:00:00.000Z" },
    }),
  });
  assert.equal(intake.status, 201);
  const ack = await intake.json();
  await s.ingest(e);
  const response = await s.api("/docs-commerce/report");
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal((await response.json()).buyers[0].customerId, ack.customerId);
  await s.api("/docs-customers/" + ack.customerId + "/trash", "POST", {
    requestId: randomUUID(),
    action: "delete",
    version: 1,
  });
  const r = await s.report();
  assert.equal(r.summary.count, 1);
  assert.equal(r.buyers[0].customerId, null);
  assert.equal(r.buyers[0].customerInTrash, true);
  assert.equal((await (await s.api("/docs-customers")).json()).total, 0);
});

test("source cleanup closes current and restarted SQLite connections before removing Windows-locked files", async (t) => {
  const opened = [];
  const src = await source(t, {
    removeTree: async (directory, options) => {
      for (const agent of opened)
        assert.throws(() => agent.db.prepare("SELECT 1"), {
          code: "ERR_INVALID_STATE",
        });
      await rm(directory, options);
    },
  });
  const first = src.openAgent({ now: () => NOW });
  opened.push(first);
  first.scan();
  src.closeAgent(first);
  const restarted = src.openAgent({ now: () => NOW });
  opened.push(restarted);
  restarted.scan();
  assert.equal(restarted.status().sourceCount, 3);
  assert.equal(opened.length, 2);
});
