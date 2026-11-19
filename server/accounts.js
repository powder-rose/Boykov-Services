import { randomUUID } from "node:crypto";
import { hashPassword } from "./passwords.js";
const bad = (message, status = 400) =>
  Object.assign(new Error(message), { status });
export function installAccountsSchema(db, now = Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_accounts (
    id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','sales')),
    password_hash TEXT, enabled INTEGER NOT NULL DEFAULT 0,
    auth_version INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS account_audit (
    id INTEGER PRIMARY KEY, actor_id TEXT, actor_name TEXT NOT NULL,
    target_id TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL
  );`);
}
export function publicAccount(row) {
  return {
    id: row.id,
    login: row.login,
    name: row.name,
    role: row.role,
    enabled: Boolean(row.enabled),
    hasPassword: Boolean(row.password_hash),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function accountInput(input, { creating = false } = {}) {
  const login =
    typeof input?.login === "string" ? input.login.trim().toLowerCase() : "";
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (
    !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(login) ||
    !name ||
    name.length > 120 ||
    /[\x00-\x1f\x7f]/.test(name)
  )
    throw bad(
      "Укажите имя и логин: 3–64 латинских символа, цифры, точка, дефис или подчёркивание.",
    );
  if (
    !["admin", "sales"].includes(input.role) ||
    typeof input.enabled !== "boolean"
  )
    throw bad("Проверьте роль и состояние аккаунта.");
  const password = input.password;
  if (
    password !== undefined &&
    (typeof password !== "string" ||
      password.length < 12 ||
      password.length > 128 ||
      password.includes("\0"))
  )
    throw bad("Для нового пароля нужно от 12 до 128 символов.");
  if (creating && !password) throw bad("Задайте пароль нового аккаунта.");
  return { login, name, role: input.role, enabled: input.enabled, password };
}
export async function createInitialAdmin(db, input, now = Date.now) {
  const data = accountInput(
    { ...input, role: "admin", enabled: true },
    { creating: true },
  );
  const passwordHash = await hashPassword(data.password),
    id = randomUUID(),
    stamp = new Date(now()).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (
      db
        .prepare(
          "SELECT count(*) AS n FROM workspace_accounts WHERE role='admin' AND enabled=1",
        )
        .get().n
    )
      throw bad(
        "Администратор уже создан. Используйте управление аккаунтами в рабочем пространстве.",
        409,
      );
    if (
      db
        .prepare("SELECT id FROM workspace_accounts WHERE login=?")
        .get(data.login)
    )
      throw bad("Этот логин уже занят.", 409);
    db.prepare(
      "INSERT INTO workspace_accounts(id,login,name,role,password_hash,enabled,created_at,updated_at) VALUES(?,?,?,'admin',?,1,?,?)",
    ).run(id, data.login, data.name, passwordHash, stamp, stamp);
    db.prepare(
      "INSERT INTO account_audit(actor_id,actor_name,target_id,action,created_at) VALUES(NULL,'Консоль VPS',?,'bootstrap',?)",
    ).run(id, stamp);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
  return publicAccount(
    db.prepare("SELECT * FROM workspace_accounts WHERE id=?").get(id),
  );
}
export function prepareSalesAccounts(db, input, now = Date.now) {
  if (!Array.isArray(input) || !input.length || input.length > 100)
    throw bad("Нужен список от 1 до 100 сотрудников.");
  const rows = input.map((item) =>
    accountInput({
      login: item?.login,
      name: item?.name,
      role: "sales",
      enabled: false,
    }),
  );
  if (new Set(rows.map((row) => row.login)).size !== rows.length)
    throw bad("Логины в списке не должны повторяться.");
  const stamp = new Date(now()).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    let added = 0;
    for (const row of rows)
      added += db
        .prepare(
          "INSERT OR IGNORE INTO workspace_accounts(id,login,name,role,created_at,updated_at) VALUES(?,?,?,'sales',?,?)",
        )
        .run(randomUUID(), row.login, row.name, stamp, stamp).changes;
    db.exec("COMMIT");
    return { added, existing: rows.length - added };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
export function registerAccountRoutes(app, { db, now = Date.now }) {
  const admin = (req, res, next) =>
    req.actor?.role === "admin"
      ? next()
      : res
          .status(403)
          .json({ error: "Управление аккаунтами доступно администратору." });
  let hashing = 0;
  app.get("/api/accounts", admin, (req, res) =>
    res.json({
      accounts: db
        .prepare(
          "SELECT * FROM workspace_accounts ORDER BY name COLLATE NOCASE,login",
        )
        .all()
        .map(publicAccount),
    }),
  );
  async function save(req, res) {
    const creating = !req.params.id;
    const data = accountInput(req.body, { creating });
    const before = creating
      ? null
      : db
          .prepare("SELECT * FROM workspace_accounts WHERE id=?")
          .get(req.params.id);
    if (!creating && !before) throw bad("Аккаунт не найден.", 404);
    if (
      !creating &&
      (!Number.isSafeInteger(req.body.version) ||
        req.body.version !== before.version)
    )
      throw bad("Аккаунт уже изменили. Обновите список.", 409);
    if (data.enabled && !data.password && !before?.password_hash)
      throw bad("Для включения аккаунта задайте пароль.");
    let passwordHash = before?.password_hash || null;
    if (data.password) {
      if (hashing >= 2)
        throw bad("Подождите завершения предыдущего изменения пароля.", 429);
      hashing++;
      try {
        passwordHash = await hashPassword(data.password);
      } finally {
        hashing--;
      }
    }
    db.exec("BEGIN IMMEDIATE");
    let id;
    try {
      // Re-check after hashing: another admin can disable this session meanwhile.
      const actor = db
        .prepare(
          "SELECT enabled,role,auth_version FROM workspace_accounts WHERE id=?",
        )
        .get(req.actor.id);
      if (
        !actor?.enabled ||
        actor.role !== "admin" ||
        actor.auth_version !== req.accountAuthVersion
      ) {
        db.exec("ROLLBACK");
        return res
          .status(401)
          .json({ error: "Войдите заново для управления аккаунтами." });
      }
      const current = creating
        ? null
        : db
            .prepare("SELECT * FROM workspace_accounts WHERE id=?")
            .get(req.params.id);
      if (!creating && current?.version !== req.body.version)
        throw bad("Аккаунт уже изменили. Обновите список.", 409);
      const collision = db
        .prepare("SELECT id FROM workspace_accounts WHERE login=?")
        .get(data.login);
      if (collision && collision.id !== current?.id)
        throw bad("Этот логин уже занят.", 409);
      if (
        current?.role === "admin" &&
        current.enabled &&
        (!data.enabled || data.role !== "admin") &&
        db
          .prepare(
            "SELECT count(*) AS n FROM workspace_accounts WHERE enabled=1 AND role='admin'",
          )
          .get().n <= 1
      )
        throw bad(
          "Нельзя отключить или понизить последнего администратора.",
          409,
        );
      id = current?.id || randomUUID();
      const stamp = new Date(now()).toISOString();
      if (creating) {
        if (
          db.prepare("SELECT count(*) AS n FROM workspace_accounts").get().n >=
          200
        )
          throw bad("Достигнут лимит аккаунтов.", 409);
        db.prepare(
          "INSERT INTO workspace_accounts(id,login,name,role,password_hash,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          id,
          data.login,
          data.name,
          data.role,
          passwordHash,
          Number(data.enabled),
          stamp,
          stamp,
        );
      } else {
        const revoke =
          Boolean(data.password) ||
          data.role !== current.role ||
          data.enabled !== Boolean(current.enabled) ||
          data.login !== current.login;
        db.prepare(
          "UPDATE workspace_accounts SET login=?,name=?,role=?,password_hash=?,enabled=?,version=version+1,auth_version=auth_version+?,updated_at=? WHERE id=?",
        ).run(
          data.login,
          data.name,
          data.role,
          passwordHash,
          Number(data.enabled),
          Number(revoke),
          stamp,
          id,
        );
        if (revoke)
          db.prepare("DELETE FROM account_sessions WHERE account_id=?").run(id);
      }
      db.prepare(
        "INSERT INTO account_audit(actor_id,actor_name,target_id,action,created_at) VALUES(?,?,?,?,?)",
      ).run(
        req.actor.id,
        req.actor.name,
        id,
        creating ? "create" : data.password ? "password" : "update",
        stamp,
      );
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
    res.status(creating ? 201 : 200).json({
      account: publicAccount(
        db.prepare("SELECT * FROM workspace_accounts WHERE id=?").get(id),
      ),
    });
  }
  app.post("/api/accounts", admin, save);
  app.patch("/api/accounts/:id", admin, save);
}
