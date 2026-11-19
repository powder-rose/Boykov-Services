import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  accountFixture,
  personalPassword,
  sharedPassword,
} from "./helpers/accounts-fixture.js";
import { hashPassword, installAuth } from "../server/auth.js";
import {
  createInitialAdmin,
  installAccountsSchema,
  prepareSalesAccounts,
} from "../server/accounts.js";

test("personal identities come from server sessions; sales and shared sessions cannot administer accounts", async (t) => {
  const s = await accountFixture(t),
    user = await s.make("manager.one", "Тестовый менеджер А"),
    cookie = await s.login(user.login),
    shared = await s.login(null);
  const session = await (
    await s.api("/auth/session", "GET", undefined, cookie)
  ).json();
  assert.deepEqual(session.account, {
    id: user.id,
    login: user.login,
    name: user.name,
    role: "sales",
  });
  assert.equal(
    (await s.api("/accounts", "GET", undefined, cookie)).status,
    403,
  );
  assert.equal(
    (
      await s.api(
        "/accounts",
        "POST",
        {
          login: "attacker",
          name: "X",
          role: "admin",
          enabled: true,
          password: personalPassword,
        },
        cookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (await s.api("/accounts", "GET", undefined, shared)).status,
    403,
  );
  assert.equal((await s.request("/accounts")).status, 401);
  const common = await (
    await s.api("/auth/session", "GET", undefined, shared)
  ).json();
  assert.equal(common.account.role, "shared");
  assert.equal(common.account.name, "Общий доступ");
  const list = await (await s.api("/accounts")).json();
  assert.ok(!JSON.stringify(list).includes("scrypt$"));
  assert.ok(!JSON.stringify(list).includes(personalPassword));
  assert.ok(!JSON.stringify(list).includes("auth_version"));
});

test("incorrect, disabled and unknown personal logins do not fall back to the common password; login errors are uniform", async (t) => {
  const s = await accountFixture(t),
    user = await s.make("manager.one");
  const disabled = { ...user, enabled: false };
  await s.api("/accounts/" + user.id, "PATCH", disabled);
  for (const login of ["manager.one", "no.such.user", "../../admin"]) {
    const response = await s.request("/auth/login", "POST", {
      login,
      password: sharedPassword,
      role: "admin",
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "Неверный логин или пароль");
  }
  const shared = await s.login(null);
  assert.equal(
    (await s.api("/dashboard", "GET", undefined, shared)).status,
    200,
  );
});

test("personal sessions persist across restart and common-password rotation while obsolete shared sessions are revoked", async (t) => {
  const s = await accountFixture(t),
    user = await s.make("manager.one"),
    cookie = await s.login(user.login),
    shared = await s.login(null);
  await s.restart();
  assert.equal(
    (await s.api("/dashboard", "GET", undefined, cookie)).status,
    200,
  );
  await s.restart(await hashPassword("changed-shared-password"));
  assert.equal(
    (await s.api("/dashboard", "GET", undefined, cookie)).status,
    200,
  );
  assert.equal(
    (await s.api("/dashboard", "GET", undefined, shared)).status,
    401,
  );
});

test("password, role and enabled changes revoke personal sessions; ordinary renaming keeps account identity and history", async (t) => {
  const s = await accountFixture(t);
  let user = await s.make("manager.one"),
    cookie = await s.login(user.login);
  let response = await s.api("/accounts/" + user.id, "PATCH", {
    ...user,
    name: "Новое имя",
  });
  assert.equal(response.status, 200);
  user = (await response.json()).account;
  assert.equal(
    (await (await s.api("/auth/session", "GET", undefined, cookie)).json())
      .account.name,
    "Новое имя",
  );
  response = await s.api("/accounts/" + user.id, "PATCH", {
    ...user,
    password: "changed-personal-password",
  });
  assert.equal(response.status, 200);
  user = (await response.json()).account;
  assert.equal(
    (await s.api("/dashboard", "GET", undefined, cookie)).status,
    401,
  );
  cookie = await s.login(user.login, "changed-personal-password");
  response = await s.api("/accounts/" + user.id, "PATCH", {
    ...user,
    enabled: false,
  });
  assert.equal(response.status, 200);
  user = (await response.json()).account;
  assert.equal(
    (await s.api("/dashboard", "GET", undefined, cookie)).status,
    401,
  );
  response = await s.api("/accounts/" + user.id, "PATCH", {
    ...user,
    enabled: true,
  });
  user = (await response.json()).account;
  cookie = await s.login(user.login, "changed-personal-password");
  response = await s.api("/accounts/" + user.id, "PATCH", {
    ...user,
    role: "admin",
  });
  assert.equal(response.status, 200);
  assert.equal(
    (await s.api("/accounts", "GET", undefined, cookie)).status,
    401,
  );
});

test("last administrator cannot be disabled or demoted, and duplicate/stale account edits do not overwrite a colleague", async (t) => {
  const s = await accountFixture(t);
  assert.equal(
    (
      await s.api("/accounts/" + s.admin.id, "PATCH", {
        ...s.admin,
        role: "sales",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await s.api("/accounts/" + s.admin.id, "PATCH", {
        ...s.admin,
        enabled: false,
      })
    ).status,
    409,
  );
  const user = await s.make("manager.one");
  assert.equal(
    (
      await s.api("/accounts", "POST", {
        login: "MANAGER.ONE",
        name: "Duplicate",
        role: "admin",
        enabled: true,
        password: personalPassword,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await s.api("/accounts/" + user.id, "PATCH", {
        ...user,
        name: "Первое изменение",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await s.api("/accounts/" + user.id, "PATCH", {
        ...user,
        name: "Старая версия",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await s.api("/accounts", "POST", {
        login: "bad",
        name: "X",
        role: "admin",
        enabled: true,
        password: "short",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await s.api("/accounts", "POST", {
        login: "admin.two",
        name: "Второй администратор",
        role: "admin",
        enabled: true,
        password: personalPassword,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await s.api("/accounts/" + s.admin.id, "PATCH", {
        ...s.admin,
        enabled: false,
      })
    ).status,
    200,
  );
  assert.equal((await s.api("/accounts")).status, 401);
});

test("employee roster preparation is private, repeatable and never resets passwords, roles or existing names", async (t) => {
  const s = await accountFixture(t),
    rows = [
      { login: "manager.one", name: "Сотрудник один" },
      { login: "manager.two", name: "Сотрудник два" },
    ];
  assert.deepEqual(prepareSalesAccounts(s.db, rows), { added: 2, existing: 0 });
  let list = (await (await s.api("/accounts")).json()).accounts,
    user = list.find((a) => a.login === "manager.one");
  assert.equal(user.enabled, false);
  assert.equal(user.hasPassword, false);
  let response = await s.api("/accounts/" + user.id, "PATCH", {
    ...user,
    enabled: true,
    password: personalPassword,
  });
  user = (await response.json()).account;
  const before = s.db
    .prepare("SELECT * FROM workspace_accounts WHERE id=?")
    .get(user.id);
  assert.deepEqual(
    prepareSalesAccounts(
      s.db,
      rows.map((row) => ({ ...row, name: "Не перезаписывать" })),
    ),
    { added: 0, existing: 2 },
  );
  assert.deepEqual(
    s.db.prepare("SELECT * FROM workspace_accounts WHERE id=?").get(user.id),
    before,
  );
  assert.throws(() => prepareSalesAccounts(s.db, [rows[0], rows[0]]));
  assert.equal(
    (
      await s.api(
        "/accounts/" + list.find((a) => a.login === "manager.two").id,
        "PATCH",
        { ...list.find((a) => a.login === "manager.two"), enabled: true },
      )
    ).status,
    400,
  );
  await assert.rejects(() =>
    createInitialAdmin(s.db, {
      login: "new.admin",
      name: "Новый",
      password: personalPassword,
    }),
  );
});

test("claim, process and history attribution cannot be forged, and comments do not silently transfer responsibility", async (t) => {
  const s = await accountFixture(t),
    a = await s.make("manager.one", "Сотрудник А"),
    b = await s.make("manager.two", "Сотрудник Б"),
    ca = await s.login(a.login),
    cb = await s.login(b.login),
    lead = await s.lead();
  let version = 1;
  const edit = async (cookie, status, note = "", extra = {}) =>
    s.api(
      "/leads/" + lead.id,
      "PATCH",
      {
        requestId: randomUUID(),
        version: version++,
        status,
        note,
        actor: { id: s.admin.id, name: "Подмена" },
        assignee: { id: s.admin.id },
        ...extra,
      },
      cookie,
    );
  assert.equal(
    (await edit(ca, "working", "Первый звонок", { claim: true })).status,
    200,
  );
  let detail = await (await s.api("/leads/" + lead.id)).json();
  assert.equal(detail.lead.assignee.id, a.id);
  assert.equal(detail.history[0].actorId, a.id);
  assert.equal((await edit(cb, "working", "Комментарий коллеги")).status, 200);
  detail = await (await s.api("/leads/" + lead.id)).json();
  assert.equal(detail.lead.assignee.id, a.id);
  assert.equal(detail.history[0].actorId, b.id);
  assert.equal((await edit(cb, "processed", "Договор подписан")).status, 200);
  detail = await (await s.api("/leads/" + lead.id)).json();
  assert.equal(detail.lead.assignee.id, a.id);
  assert.equal(detail.lead.processedBy.id, b.id);
  assert.ok(detail.lead.processedAt);
  assert.equal((await edit(ca, "processed", "Уточнение")).status, 200);
  detail = await (await s.api("/leads/" + lead.id)).json();
  assert.equal(detail.lead.processedBy.id, b.id);
  assert.equal((await edit(ca, "working", "Повторное обращение")).status, 200);
  detail = await (await s.api("/leads/" + lead.id)).json();
  assert.equal(detail.lead.assignee.id, a.id);
  assert.equal(detail.lead.processedBy, null);
  assert.equal(
    (await edit(cb, "working", "Принимаю", { claim: true })).status,
    200,
  );
  detail = await (await s.api("/leads/" + lead.id)).json();
  assert.equal(detail.lead.assignee.id, b.id);
  assert.equal((await edit(cb, "new")).status, 200);
  detail = await (await s.api("/leads/" + lead.id)).json();
  assert.equal(detail.lead.assignee, null);
});

test("shared and legacy attribution remain explicit; deletion and replay keep the original employee ownership", async (t) => {
  const s = await accountFixture(t),
    a = await s.make("manager.one", "Сотрудник А"),
    ca = await s.login(a.login),
    shared = await s.login(null),
    lead = await s.lead();
  const requestId = randomUUID(),
    body = {
      requestId,
      version: 1,
      status: "working",
      note: "Звонок",
      claim: true,
    };
  await s.api("/leads/" + lead.id, "PATCH", body, ca);
  const detail = await (await s.api("/leads/" + lead.id)).json();
  await s.api(
    "/leads/trash",
    "POST",
    {
      requestId: randomUUID(),
      action: "delete",
      leads: [{ id: lead.id, version: 2 }],
    },
    shared,
  );
  const deleted = await (await s.api("/leads/" + lead.id)).json();
  assert.equal(deleted.history[0].actorName, "Общий доступ");
  assert.equal(deleted.lead.assignee.id, a.id);
  await s.api(
    "/leads/trash",
    "POST",
    {
      requestId: randomUUID(),
      action: "restore",
      leads: [{ id: lead.id, version: 3 }],
    },
    ca,
  );
  assert.equal(
    (await s.api("/leads/" + lead.id, "PATCH", body, ca)).status,
    200,
  );
  const restored = await (await s.api("/leads/" + lead.id)).json();
  assert.equal(restored.lead.version, 4);
  assert.equal(restored.lead.assignee.id, a.id);
  assert.equal(restored.history.at(-1).actorId, null);
  const legacy = await s.lead();
  s.db
    .prepare("UPDATE sales_leads SET status='processed' WHERE id=?")
    .run(legacy.id);
  const old = (await (await s.api("/leads/" + legacy.id)).json()).lead;
  assert.equal(old.assignee, null);
  assert.equal(old.processedBy, null);
});

test("simultaneous claims resolve by version; personal lists use the session and exclude trash", async (t) => {
  const s = await accountFixture(t),
    a = await s.make("manager.one"),
    b = await s.make("manager.two"),
    ca = await s.login(a.login),
    cb = await s.login(b.login),
    lead = await s.lead();
  const results = await Promise.all(
    [ca, cb].map((cookie) =>
      s.api(
        "/leads/" + lead.id,
        "PATCH",
        {
          requestId: randomUUID(),
          version: 1,
          status: "working",
          note: "",
          claim: true,
        },
        cookie,
      ),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const winner =
      results[0].status === 200
        ? { user: a, cookie: ca }
        : { user: b, cookie: cb },
    other = results[0].status === 200 ? cb : ca;
  assert.equal(
    (
      await (
        await s.api(
          "/me/leads?status=working&accountId=" + winner.user.id,
          "GET",
          undefined,
          other,
        )
      ).json()
    ).total,
    0,
  );
  assert.equal(
    (
      await (
        await s.api("/me/leads?status=working", "GET", undefined, winner.cookie)
      ).json()
    ).total,
    1,
  );
  await s.api(
    "/leads/" + lead.id,
    "PATCH",
    { requestId: randomUUID(), version: 2, status: "processed", note: "" },
    winner.cookie,
  );
  assert.equal(
    (
      await (
        await s.api("/me/leads?status=working", "GET", undefined, winner.cookie)
      ).json()
    ).total,
    0,
  );
  const mine = await (
    await s.api("/me/leads?status=processed", "GET", undefined, winner.cookie)
  ).json();
  assert.equal(mine.total, 1);
  await s.api(
    "/leads/trash",
    "POST",
    {
      requestId: randomUUID(),
      action: "delete",
      leads: [{ id: lead.id, version: 3 }],
    },
    winner.cookie,
  );
  assert.equal(
    (
      await (
        await s.api(
          "/me/leads?status=processed",
          "GET",
          undefined,
          winner.cookie,
        )
      ).json()
    ).total,
    0,
  );
});

test("an existing shared session survives an upgrade from the original three-column session table", async (t) => {
  const { default: express } = await import("express");
  const { createHash, randomBytes } = await import("node:crypto");
  const db = new DatabaseSync(":memory:"),
    app = express(),
    hash = await hashPassword(sharedPassword),
    token = randomBytes(32).toString("hex");
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  db.exec(
    "CREATE TABLE sessions(token TEXT PRIMARY KEY,expires INTEGER,fingerprint TEXT)",
  );
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    digest(token),
    Date.now() + 600000,
    digest(hash),
  );
  app.use(express.json());
  installAuth(app, {
    db,
    passwordHash: hash,
    secureCookies: false,
    allowedOrigins: [],
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    db.close();
  });
  const response = await fetch(
    "http://127.0.0.1:" + server.address().port + "/api/auth/session",
    { headers: { Cookie: "boykov_session=" + token } },
  );
  const session = await response.json();
  assert.equal(session.authenticated, true);
  assert.equal(session.account.role, "shared");
  assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get().n, 1);
  assert.equal(db.prepare("PRAGMA table_info(sessions)").all().length, 3);
});
