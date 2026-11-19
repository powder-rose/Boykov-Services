import { randomBytes, createHash } from "node:crypto";
import { validHash, verifyPassword } from "./passwords.js";
import { installAccountsSchema, registerAccountRoutes } from "./accounts.js";
export { validHash, hashPassword, verifyPassword } from "./passwords.js";
const digest = (value) => createHash("sha256").update(value).digest("hex");
export const sharedActor = {
  id: null,
  login: null,
  name: "Общий доступ",
  role: "shared",
};
export function installAuth(
  app,
  { db, passwordHash, secureCookies, allowedOrigins, now = Date.now },
) {
  installAccountsSchema(db, now);
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY,expires INTEGER,fingerprint TEXT);
    CREATE TABLE IF NOT EXISTS account_sessions (token TEXT PRIMARY KEY,expires INTEGER,fingerprint TEXT,account_id TEXT NOT NULL,account_version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts (ip TEXT PRIMARY KEY,count INTEGER,until INTEGER);`);
  const fingerprint = digest(passwordHash || "");
  db.prepare("DELETE FROM sessions WHERE expires<=? OR fingerprint!=?").run(
    now(),
    fingerprint,
  );
  db.prepare("DELETE FROM account_sessions WHERE expires<=?").run(now());
  function revokeToken(token) {
    const hash = digest(token);
    db.prepare("DELETE FROM sessions WHERE token=?").run(hash);
    db.prepare("DELETE FROM account_sessions WHERE token=?").run(hash);
  }
  const lifetime = 12 * 60 * 60 * 1000;
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict",
    secure: secureCookies,
    path: "/",
    maxAge: lifetime,
  };
  const tokenOf = (req) =>
    /(?:^|;\s*)boykov_session=([a-f0-9]{64})(?:;|$)/.exec(
      req.headers.cookie || "",
    )?.[1];
  let checks = 0;
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      (req.headers["x-boykov-request"] !== "1" ||
        (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) ||
        req.headers["sec-fetch-site"] === "cross-site")
    )
      return res.status(403).json({ error: "Запрос с этого сайта запрещён" });
    db.prepare("DELETE FROM sessions WHERE expires<=?").run(now());
    db.prepare("DELETE FROM account_sessions WHERE expires<=?").run(now());
    const token = tokenOf(req),
      hash = token ? digest(token) : null;
    const session = hash
      ? db.prepare("SELECT * FROM account_sessions WHERE token=?").get(hash) ||
        db.prepare("SELECT * FROM sessions WHERE token=?").get(hash)
      : null;
    req.authenticated = false;
    if (session) {
      if (session.account_id) {
        const account = db
          .prepare("SELECT * FROM workspace_accounts WHERE id=?")
          .get(session.account_id);
        if (
          account?.enabled &&
          session.account_version === account.auth_version &&
          session.fingerprint === digest(account.password_hash || "")
        ) {
          req.authenticated = true;
          req.actor = {
            id: account.id,
            login: account.login,
            name: account.name,
            role: account.role,
          };
          req.accountAuthVersion = account.auth_version;
        }
      } else if (
        session.fingerprint === fingerprint &&
        validHash(passwordHash)
      ) {
        req.authenticated = true;
        req.actor = sharedActor;
      }
      if (!req.authenticated) revokeToken(token);
    }
    next();
  });
  app.get("/api/auth/session", (req, res) =>
    res.json({
      authenticated: req.authenticated,
      configured: validHash(passwordHash),
      ...(req.authenticated ? { account: req.actor } : {}),
    }),
  );
  app.post("/api/auth/login", async (req, res) => {
    const personal = req.body?.login !== undefined;
    const login =
      typeof req.body?.login === "string"
        ? req.body.login.trim().toLowerCase()
        : "";
    const candidate =
      personal && /^[a-z0-9][a-z0-9._-]{2,63}$/.test(login)
        ? db
            .prepare("SELECT * FROM workspace_accounts WHERE login=?")
            .get(login)
        : null;
    if (!personal && !validHash(passwordHash))
      return res.status(503).json({
        error:
          "Задайте пароль командой npm run setup и перезапустите приложение.",
      });
    db.prepare("DELETE FROM attempts WHERE until<=?").run(now());
    const ip = req.ip,
      entry = db
        .prepare("SELECT count,until FROM attempts WHERE ip=?")
        .get(ip) || { count: 0, until: now() + 900000 };
    if (entry.count >= 10 || checks >= 2)
      return res.status(429).set("Retry-After", "900").json({
        error: "Слишком много попыток входа. Попробуйте через 15 минут.",
      });
    db.prepare("INSERT OR REPLACE INTO attempts VALUES(?,?,?)").run(
      ip,
      entry.count + 1,
      entry.until,
    );
    checks++;
    let verified;
    try {
      verified = await verifyPassword(
        req.body?.password,
        personal ? candidate?.password_hash || passwordHash : passwordHash,
      );
    } finally {
      checks--;
    }
    let account = null;
    if (personal) {
      account = candidate
        ? db
            .prepare("SELECT * FROM workspace_accounts WHERE id=?")
            .get(candidate.id)
        : null;
      verified =
        verified &&
        account?.enabled &&
        account.password_hash === candidate.password_hash &&
        account.auth_version === candidate.auth_version;
    }
    if (!verified)
      return res.status(401).json({
        error: personal ? "Неверный логин или пароль" : "Неверный пароль",
      });
    db.prepare("DELETE FROM attempts WHERE ip=?").run(ip);
    const oldToken = tokenOf(req);
    if (oldToken) revokeToken(oldToken);
    if (
      db
        .prepare(
          "SELECT (SELECT count(*) FROM sessions)+(SELECT count(*) FROM account_sessions) AS n",
        )
        .get().n >= 1000
    )
      return res
        .status(429)
        .json({ error: "Достигнут лимит активных сессий." });
    const token = randomBytes(32).toString("hex");
    if (personal) {
      db.prepare(
        "INSERT INTO account_sessions(token,expires,fingerprint,account_id,account_version) VALUES(?,?,?,?,?)",
      ).run(
        digest(token),
        now() + lifetime,
        digest(account.password_hash),
        account.id,
        account.auth_version,
      );
    } else {
      db.prepare(
        "INSERT INTO sessions(token,expires,fingerprint) VALUES(?,?,?)",
      ).run(digest(token), now() + lifetime, fingerprint);
    }
    res.cookie("boykov_session", token, cookieOptions).json({ ok: true });
  });
  app.post("/api/auth/logout", (req, res) => {
    const token = tokenOf(req);
    if (token) revokeToken(token);
    const { maxAge, ...clearOptions } = cookieOptions;
    res.clearCookie("boykov_session", clearOptions).json({ ok: true });
  });
  app.use("/api", (req, res, next) =>
    req.authenticated
      ? next()
      : res.status(401).json({ error: "Войдите в рабочее пространство" }),
  );
  registerAccountRoutes(app, { db, now });
}
