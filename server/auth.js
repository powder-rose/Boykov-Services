import {
  randomBytes,
  createHash,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const validHash = (value) =>
  /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(value || "");
const digest = (value) => createHash("sha256").update(value).digest("hex");
export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64, options);
  return `scrypt$${salt}$${hash.toString("hex")}`;
}
export async function verifyPassword(password, stored) {
  if (
    !validHash(stored) ||
    typeof password !== "string" ||
    password.length > 256
  )
    return false;
  const [, salt, hash] = stored.split("$");
  return timingSafeEqual(
    await scrypt(password, salt, 64, options),
    Buffer.from(hash, "hex"),
  );
}
export function installAuth(
  app,
  { db, passwordHash, secureCookies, allowedOrigins, now = Date.now },
) {
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER, fingerprint TEXT);
    CREATE TABLE IF NOT EXISTS attempts (ip TEXT PRIMARY KEY, count INTEGER, until INTEGER);`);
  const fingerprint = digest(passwordHash || "");
  db.prepare("DELETE FROM sessions WHERE fingerprint != ? OR expires <= ?").run(
    fingerprint,
    now(),
  );
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
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (
        req.headers["x-boykov-request"] !== "1" ||
        (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) ||
        req.headers["sec-fetch-site"] === "cross-site"
      ) {
        return res.status(403).json({ error: "Запрос с этого сайта запрещён" });
      }
    }
    db.prepare("DELETE FROM sessions WHERE expires <= ?").run(now());
    const token = tokenOf(req);
    req.authenticated = Boolean(
      token &&
      db
        .prepare(
          "SELECT token FROM sessions WHERE token = ? AND fingerprint = ?",
        )
        .get(digest(token), fingerprint),
    );
    next();
  });
  app.get("/api/auth/session", (req, res) =>
    res.json({
      authenticated: req.authenticated,
      configured: validHash(passwordHash),
    }),
  );
  app.post("/api/auth/login", async (req, res) => {
    if (!validHash(passwordHash))
      return res.status(503).json({
        error:
          "Задайте пароль командой npm run setup и перезапустите приложение.",
      });
    db.prepare("DELETE FROM attempts WHERE until <= ?").run(now());
    const ip = req.ip;
    const entry = db
      .prepare("SELECT count, until FROM attempts WHERE ip = ?")
      .get(ip) || { count: 0, until: now() + 900000 };
    if (entry.count >= 10 || checks >= 2)
      return res.status(429).set("Retry-After", "900").json({
        error: "Слишком много попыток входа. Попробуйте через 15 минут.",
      });
    db.prepare("INSERT OR REPLACE INTO attempts VALUES (?, ?, ?)").run(
      ip,
      entry.count + 1,
      entry.until,
    );
    checks++;
    let verified;
    try {
      verified = await verifyPassword(req.body?.password, passwordHash);
    } finally {
      checks--;
    }
    if (!verified) return res.status(401).json({ error: "Неверный пароль" });
    db.prepare("DELETE FROM attempts WHERE ip = ?").run(ip);
    const oldToken = tokenOf(req);
    if (oldToken)
      db.prepare("DELETE FROM sessions WHERE token = ?").run(digest(oldToken));
    if (db.prepare("SELECT count(*) AS n FROM sessions").get().n >= 1000)
      return res
        .status(429)
        .json({ error: "Достигнут лимит активных сессий." });
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(
      digest(token),
      now() + lifetime,
      fingerprint,
    );
    res.cookie("boykov_session", token, cookieOptions).json({ ok: true });
  });
  app.post("/api/auth/logout", (req, res) => {
    const token = tokenOf(req);
    if (token)
      db.prepare("DELETE FROM sessions WHERE token = ?").run(digest(token));
    const { maxAge, ...clearOptions } = cookieOptions;
    res.clearCookie("boykov_session", clearOptions).json({ ok: true });
  });
  app.use("/api", (req, res, next) =>
    req.authenticated
      ? next()
      : res.status(401).json({ error: "Войдите в рабочее пространство" }),
  );
}
