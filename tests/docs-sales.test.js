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
  DocsSalesAgent,
  validateSalesConnection,
} from "../integrations/docs-customers/sales-agent.mjs";
const NOW = Date.parse("2026-11-20T07:00:00.000Z"),
  password = "docs-sales-fixture-password",
  passwordHash = await hashPassword(password);
const sample = (overrides = {}) => ({
  protocol: 1,
  eventId: randomUUID(),
  observedAt: "2026-11-20T06:00:00.000Z",
  user: {
    id: "docs-buyer-1",
    name: "Покупатель А",
    email: "buyer@example.ru",
    phone: "+7 999 111-22-33",
    registeredAt: "2026-01-01T00:00:00.000Z",
  },
  purchase: {
    id: "wp_" + randomUUID(),
    userId: "docs-buyer-1",
    instructionId: "instruction-1",
    title: "Инструкция по охране труда",
    amountMinor: 5000,
    currency: "RUB",
    format: "pdf",
    createdAt: "2026-11-19T21:00:00.000Z",
  },
  ...overrides,
});
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "boykov-docs-sales-"));
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
    fetch(base + "/hooks/docs-customers/sales" + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key,
      },
      body: JSON.stringify(data),
    });
  const ingest = async (e) => {
    const r = await hook(e);
    assert.equal(r.status, 201, await r.clone().text());
    return r.json();
  };
  const report = async (query) => {
    const r = await api("/docs-sales/report" + (query ? "?" + query : ""));
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  return { app, base, api, request, token, hook, ingest, report };
}
test("sales uses the existing private site key and workspace authentication; history does not import old CRM profiles", async (t) => {
  const s = await fixture(t);
  assert.equal((await s.request("/docs-sales/report")).status, 401);
  assert.equal(
    (await s.request("/docs-sales/buyers/docs-buyer-1")).status,
    401,
  );
  assert.equal((await s.hook(sample(), "", "0".repeat(64))).status, 401);
  assert.equal(
    (await (await s.hook({}, "/handshake")).json()).scope,
    "all-purchases",
  );
  const e = sample();
  e.purchase.createdAt = "2026-01-02T10:00:00.000Z";
  await s.ingest(e);
  const r = await s.api("/docs-sales/report");
  assert.match(r.headers.get("cache-control"), /no-store/);
  const data = await r.json();
  assert.equal(data.summary.count, 1);
  assert.equal(data.summary.amountMinor, 5000);
  assert.equal(data.buyers[0].id, e.user.id);
  assert.equal(data.buyers[0].customerId, null);
  assert.equal(
    s.app.locals.db.prepare("SELECT count(*) n FROM docs_customers").get().n,
    0,
  );
  assert.ok(!JSON.stringify(data).includes(s.token));
});
test("purchase delivery is idempotent and immutable; changed contacts cannot reassign an existing purchase", async (t) => {
  const s = await fixture(t),
    e = sample();
  await s.ingest(e);
  assert.equal((await s.hook(e)).status, 200);
  const next = {
    ...e,
    eventId: randomUUID(),
    observedAt: "2026-11-20T06:01:00.000Z",
    user: { ...e.user, name: "Новое имя" },
  };
  assert.equal((await s.hook(next)).status, 200);
  let r = await s.report();
  assert.equal(r.summary.count, 1);
  assert.equal(r.buyers[0].name, "Новое имя");
  assert.equal(
    (
      await s.hook({
        ...next,
        eventId: randomUUID(),
        purchase: { ...e.purchase, amountMinor: 10000 },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await s.hook({
        ...e,
        eventId: randomUUID(),
        user: { ...e.user, id: "someone-else" },
        purchase: { ...e.purchase, userId: "someone-else" },
      })
    ).status,
    409,
  );
  assert.equal(
    (await s.hook({ ...e, user: { ...e.user, id: "wrong" } })).status,
    400,
  );
  assert.equal(
    (await s.hook({ ...e, purchase: { ...e.purchase, title: "Иной договор" } }))
      .status,
    409,
  );
  assert.equal(
    (
      await s.hook({
        ...e,
        eventId: randomUUID(),
        purchase: { ...e.purchase, id: "wp_" + randomUUID() },
      })
    ).status,
    409,
  );
  r = await s.report();
  assert.equal(r.summary.amountMinor, 5000);
  assert.equal(r.buyers[0].id, e.user.id);
});
test("Moscow calendar periods, PDF/Word formats, unique instructions and totals match the purchase ledger", async (t) => {
  const s = await fixture(t),
    first = sample();
  await s.ingest(first);
  await s.ingest(
    sample({
      purchase: {
        ...sample().purchase,
        instructionId: "instruction-2",
        createdAt: "2026-11-19T20:59:59.999Z",
      },
    }),
  );
  await s.ingest(
    sample({ purchase: { ...sample().purchase, format: "docx" } }),
  );
  let r = await s.report("period=today");
  assert.equal(r.range.start, "2026-11-19T21:00:00.000Z");
  assert.equal(r.summary.count, 2);
  assert.equal(r.summary.amountMinor, 10000);
  assert.equal(r.summary.instructions, 1);
  assert.equal(r.summary.pdf, 1);
  assert.equal(r.summary.docx, 1);
  assert.equal(r.chart.items.length, 1);
  assert.equal(r.chart.items[0].count, 2);
  r = await s.report("period=7d");
  assert.equal(r.summary.count, 3);
  assert.equal(r.chart.items.length, 7);
  assert.equal(r.buyers[0].purchaseCount, 3);
  assert.equal(r.buyers[0].uniqueInstructions, 2);
  r = await s.report("format=docx");
  assert.equal(r.summary.count, 1);
  assert.equal(r.summary.amountMinor, 5000);
  assert.equal(r.topInstructions[0].count, 1);
  for (const q of ["period=bad", "format=exe", "sort=bad", "page=-1"])
    assert.equal((await s.api("/docs-sales/report?" + q)).status, 400);
});
test("buyer identity is source ID even with identical email; user history and search remain correctly associated", async (t) => {
  const s = await fixture(t),
    e = sample();
  await s.ingest(e);
  await s.ingest(
    sample({
      user: { ...e.user, id: "docs-buyer-2" },
      purchase: { ...sample().purchase, userId: "docs-buyer-2" },
    }),
  );
  const r = await s.report("q=buyer%40example.ru");
  assert.equal(r.total, 2);
  assert.equal(r.summary.buyers, 2);
  const d = await (await s.api("/docs-sales/buyers/" + e.user.id)).json();
  assert.equal(d.buyer.id, e.user.id);
  assert.equal(d.purchases.length, 1);
  assert.equal(d.purchases[0].id, e.purchase.id);
  assert.equal(d.lifetime.count, 1);
  assert.equal(
    (await s.report("q=" + encodeURIComponent("ПОКУПАТЕЛЬ"))).total,
    2,
  );
  assert.equal((await s.report("q=79991112233")).total, 2);
  assert.equal((await s.api("/docs-sales/buyers/missing")).status, 404);
});
test("connection counts detect missing ledger events and do not report an unconnected source as a confirmed zero", async (t) => {
  const s = await fixture(t);
  assert.equal((await s.report()).connection.status, "waiting");
  const heartbeat = {
    scanOk: true,
    sourceCount: 1,
    pending: 1,
    rejected: 0,
    errorCode: "",
    sourceGeneratedAt: "2026-11-20T06:00:00.000Z",
  };
  assert.equal((await s.hook(heartbeat, "/heartbeat")).status, 200);
  assert.equal((await s.report()).connection.status, "syncing");
  await s.hook({ ...heartbeat, pending: 0 }, "/heartbeat");
  assert.equal((await s.report()).connection.status, "attention");
  await s.ingest(sample());
  assert.equal((await s.report()).connection.status, "online");
  await s.hook(
    {
      ...heartbeat,
      pending: 0,
      scanOk: false,
      errorCode: "wallet_read_failed",
    },
    "/heartbeat",
  );
  const r = await s.report();
  assert.equal(r.connection.status, "attention");
  assert.equal(r.summary.count, 1);
});
test("sales reporting remains intact when a related CRM card is in trash; a purchase never resurrects it", async (t) => {
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
  const ack = await intake.json();
  assert.equal(intake.status, 201);
  await s.ingest(e);
  assert.equal((await s.report()).buyers[0].customerId, ack.customerId);
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
async function agentFixture(t, fetcher) {
  const directory = await mkdtemp(join(tmpdir(), "docs-sales-agent-")),
    sourceDir = join(directory, "source"),
    stateDir = join(directory, "state");
  await mkdir(sourceDir);
  let clock = NOW;
  const agents = [];
  const users = [
      {
        ...sample().user,
        createdAt: "2026-01-01T00:00:00.000Z",
        passwordHash: "NEVER_COPY_PASSWORD",
        verificationTokenHash: "NEVER_COPY_TOKEN",
      },
    ],
    wallet = {
      version: 1,
      purchases: [
        {
          ...sample().purchase,
          createdAt: "2026-01-02T00:00:00.000Z",
          instruction: { body: "NEVER_COPY_DOCUMENT" },
          fiscalEvent: { secret: "NEVER_COPY_FISCAL" },
        },
      ],
      topups: [{ secret: "NEVER_COPY_TOPUP" }],
      payments: [],
      refunds: [],
    };
  const save = async () => {
    await writeFile(join(sourceDir, "users.json"), JSON.stringify(users));
    await writeFile(join(sourceDir, "wallets.json"), JSON.stringify(wallet));
  };
  await save();
  const ok = async (url, opts) => {
    const p = JSON.parse(opts.body);
    return Response.json(
      url.endsWith("/heartbeat")
        ? { ok: true, source: "boykovdocs-sales" }
        : {
            ok: true,
            eventId: p.eventId,
            externalId: p.user.id,
            saleId: p.purchase.id,
          },
    );
  };
  const config = {
    endpoint: "https://boykov-services.ru/hooks/docs-customers/sales",
    token: "b".repeat(64),
    sourceDir,
    stateDir,
  };
  const start = () => {
    const a = new DocsSalesAgent(config, {
      now: () => clock,
      fetcher: fetcher || ok,
    });
    agents.push(a);
    return a;
  };
  t.after(async () => {
    for (const a of agents)
      try {
        a.close();
      } catch {}
    await rm(directory, { recursive: true, force: true });
  });
  return {
    sourceDir,
    config,
    users,
    wallet,
    save,
    start,
    tick: () => {
      clock += 1000000;
    },
  };
}
test("sales collector reads all purchase history only, whitelists fields and never writes source files", async (t) => {
  const s = await agentFixture(t),
    a = s.start(),
    before = await readFile(join(s.sourceDir, "wallets.json"), "utf8");
  a.scan();
  assert.equal(a.status().pending, 1);
  const rows = a.db.prepare("SELECT payload FROM outbox").all();
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].payload.includes("NEVER_COPY"));
  assert.equal(JSON.parse(rows[0].payload).user.id, s.users[0].id);
  assert.equal(
    await readFile(join(s.sourceDir, "wallets.json"), "utf8"),
    before,
  );
  await a.cycle();
  assert.equal(a.status().pending, 0);
  a.close();
  const b = s.start();
  b.scan();
  assert.equal(b.status().pending, 0);
  assert.equal(b.db.prepare("SELECT count(*) n FROM outbox").get().n, 1);
});
test("sales queue survives a lost acknowledgement, retries the same event and does not mistake HTTP 200 for a valid ACK", async (t) => {
  let mode = "lost",
    ids = [];
  const s = await agentFixture(t, async (url, opts) => {
      const p = JSON.parse(opts.body);
      if (url.endsWith("/heartbeat"))
        return Response.json({ ok: true, source: "boykovdocs-sales" });
      ids.push(p.eventId);
      if (mode === "lost") throw Error();
      if (mode === "invalid") return Response.json({ ok: true });
      return Response.json({
        ok: true,
        eventId: p.eventId,
        externalId: p.user.id,
        saleId: p.purchase.id,
      });
    }),
    a = s.start();
  a.scan();
  await a.deliver();
  assert.equal(a.status().pending, 1);
  a.close();
  s.tick();
  mode = "invalid";
  const b = s.start();
  await b.deliver();
  assert.equal(b.status().rejected, 1);
  s.tick();
  mode = "ok";
  await b.cycle();
  assert.equal(b.status().pending, 0);
  assert.ok(ids.every((id) => id === ids[0]));
});
test("source corruption or removed purchase records expose a warning and retain previously queued sales", async (t) => {
  const s = await agentFixture(t),
    a = s.start();
  await a.cycle();
  assert.equal(a.status().sourceCount, 1);
  s.wallet.purchases = [];
  await s.save();
  a.scan();
  assert.equal(a.status().errorCode, "source_count_decreased");
  assert.equal(a.db.prepare("SELECT count(*) n FROM outbox").get().n, 1);
  await writeFile(join(s.sourceDir, "wallets.json"), "{broken");
  a.scan();
  assert.equal(a.status().scanOk, false);
  assert.equal(a.status().errorCode, "wallet_read_failed");
});
test("collector keeps orphan purchases tied to their original user ID and rejects duplicate access records", async (t) => {
  const s = await agentFixture(t),
    a = s.start();
  s.wallet.purchases[0].userId = "deleted-source-account";
  await s.save();
  a.scan();
  const p = JSON.parse(
    a.db.prepare("SELECT payload FROM outbox").get().payload,
  );
  assert.equal(p.user.id, "deleted-source-account");
  assert.equal(p.user.email, "");
  assert.equal(p.purchase.userId, p.user.id);
  s.wallet.purchases.push({
    ...s.wallet.purchases[0],
    id: "wp_" + randomUUID(),
  });
  await s.save();
  a.scan();
  assert.equal(a.status().scanOk, false);
  assert.equal(a.status().errorCode, "invalid_source_data");
});
test("sales delivery accepts only HTTPS, the dedicated endpoint and a private key", () => {
  const config = {
    endpoint: "https://boykov-services.ru/hooks/docs-customers/sales",
    token: "a".repeat(64),
  };
  assert.equal(validateSalesConnection(config), config.endpoint);
  for (const endpoint of [
    "http://boykov-services.ru/hooks/docs-customers/sales",
    "https://boykov-services.ru/hooks/docs-customers",
    "https://boykov-services.ru/hooks/docs-customers/sales?key=x",
  ])
    assert.throws(() => validateSalesConnection({ ...config, endpoint }));
});

test("buyer and purchase pagination preserve totals, ordering and exact amounts across pages", async (t) => {
  const s = await fixture(t);
  for (let i = 0; i < 28; i++) {
    const e = sample();
    e.eventId = randomUUID();
    e.user.id = "buyer-" + String(i).padStart(2, "0");
    e.purchase.id = "sale-page-" + i;
    e.purchase.userId = e.user.id;
    e.purchase.amountMinor = 5025;
    await s.ingest(e);
  }
  for (let i = 1; i <= 26; i++) {
    const e = sample();
    e.eventId = randomUUID();
    e.user.id = "buyer-00";
    e.purchase.userId = e.user.id;
    e.purchase.id = "extra-page-" + i;
    e.purchase.instructionId = "instruction-extra-" + i;
    e.purchase.amountMinor = 100;
    await s.ingest(e);
  }
  const first = await s.report("page=1"),
    second = await s.report("page=2");
  assert.equal(first.total, 28);
  assert.equal(first.pages, 2);
  assert.equal(first.buyers.length, 25);
  assert.equal(second.buyers.length, 3);
  assert.equal(
    new Set([...first.buyers, ...second.buyers].map((b) => b.id)).size,
    28,
  );
  assert.equal(first.summary.count, 54);
  assert.equal(first.summary.amountMinor, 28 * 5025 + 26 * 100);
  assert.equal(first.buyers[0].id, "buyer-00");
  const detail = await (
    await s.api("/docs-sales/buyers/buyer-00?page=2")
  ).json();
  assert.equal(detail.total, 27);
  assert.equal(detail.pages, 2);
  assert.equal(detail.purchases.length, 2);
  assert.equal(detail.summary.count, 27);
  assert.equal(detail.summary.amountMinor, 5025 + 26 * 100);
  const search = await s.report("q=buyer-00");
  assert.equal(search.total, 1);
  assert.equal(search.summary.count, 54);
  assert.equal((await s.api("/docs-sales/report?page=-1")).status, 400);
});
