// Independent read-only sales collector. It never loads the BoykovDocs application or writes its data.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync,
  mkdirSync,
  chmodSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeDocsSale } from "../../shared/docs-sales.js";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const text = (s, max) =>
  typeof s === "string"
    ? s
        .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
        .trim()
        .slice(0, max)
    : "";
const date = (s) =>
  typeof s === "string" && Number.isFinite(Date.parse(s))
    ? new Date(s).toISOString()
    : null;
export function validateSalesConnection(config) {
  const url = new URL(config.endpoint);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/hooks/docs-customers/sales" ||
    !/^[a-f0-9]{64}$/.test(config.token || "")
  )
    throw Error("INVALID_DOCS_SALES_CONNECTION");
  return url.href;
}
export class DocsSalesAgent {
  static validateConnection = validateSalesConnection;
  sourceName = "boykovdocs-sales";
  recordId(event) {
    return event.purchase.id;
  }
  captureContent(event) {
    return { user: event.user, purchase: event.purchase };
  }
  acknowledges(ack, payload, eventId) {
    return (
      ack.ok === true &&
      ack.eventId === eventId &&
      ack.externalId === payload.user.id &&
      ack.saleId === payload.purchase.id
    );
  }
  constructor(config, { fetcher = fetch, now = Date.now } = {}) {
    this.config = {
      ...config,
      endpoint: this.constructor.validateConnection(config),
    };
    this.fetcher = fetcher;
    this.now = now;
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    const file = join(config.stateDir, "delivery.sqlite");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1),endpoint TEXT NOT NULL,source TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS outbox(event_id TEXT PRIMARY KEY,purchase_id TEXT NOT NULL,payload TEXT NOT NULL,queued_at INTEGER NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '');
  CREATE INDEX IF NOT EXISTS outbox_due ON outbox(delivered,next_at);
  CREATE TABLE IF NOT EXISTS capture(purchase_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    const identity = this.db.prepare("SELECT * FROM identity WHERE id=1").get();
    if (
      identity &&
      (identity.endpoint !== this.config.endpoint ||
        identity.source !== resolve(config.sourceDir))
    ) {
      this.db.close();
      throw Error("DOCS_SALES_QUEUE_BELONGS_TO_ANOTHER_SOURCE");
    }
    this.db
      .prepare("INSERT OR IGNORE INTO identity VALUES(1,?,?)")
      .run(this.config.endpoint, resolve(config.sourceDir));
    this.scanOk = false;
    this.errorCode = "";
    this.sourceCount = Number(this.get("source_count") || 0);
    this.invalid = 0;
  }
  get(key) {
    return this.db.prepare("SELECT value FROM meta WHERE key=?").get(key)
      ?.value;
  }
  set(key, value) {
    this.db
      .prepare(
        "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, String(value));
  }
  capture(event) {
    const content = this.captureContent(event),
      fingerprint = hash(JSON.stringify(content));
    if (
      this.db
        .prepare("SELECT fingerprint FROM capture WHERE purchase_id=?")
        .get(this.recordId(event))?.fingerprint === fingerprint
    )
      return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const observed = Math.max(this.now(), Number(this.get("clock") || 0) + 1),
        payload = {
          ...event,
          eventId: randomUUID(),
          observedAt: new Date(observed).toISOString(),
        };
      this.db
        .prepare(
          "INSERT INTO outbox(event_id,purchase_id,payload,queued_at) VALUES(?,?,?,?)",
        )
        .run(
          payload.eventId,
          this.recordId(payload),
          JSON.stringify(payload),
          this.now(),
        );
      this.db
        .prepare(
          "INSERT INTO capture VALUES(?,?) ON CONFLICT(purchase_id) DO UPDATE SET fingerprint=excluded.fingerprint",
        )
        .run(this.recordId(payload), fingerprint);
      this.set("clock", observed);
      this.db.exec("COMMIT");
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
  }
  scan() {
    this.scanOk = false;
    this.invalid = 0;
    let users;
    try {
      const rows = JSON.parse(
        readFileSync(join(this.config.sourceDir, "users.json"), "utf8"),
      );
      if (!Array.isArray(rows)) throw Error();
      users = new Map();
      for (const u of rows) {
        if (!u || typeof u.id !== "string" || !u.id || users.has(u.id))
          throw Error();
        const email = text(u.email, 254);
        users.set(u.id, {
          id: u.id,
          name: text(u.name, 200),
          phone: text(u.phone, 80),
          email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "",
          registeredAt: date(u.createdAt),
        });
      }
    } catch {
      this.errorCode = "users_read_failed";
      return;
    }
    let wallet;
    try {
      try {
        wallet = JSON.parse(
          readFileSync(join(this.config.sourceDir, "wallets.json"), "utf8"),
        );
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        try {
          readFileSync(join(this.config.sourceDir, "wallets.json.initialized"));
          throw Error("MISSING_INITIALIZED_WALLET");
        } catch (marker) {
          if (marker.code !== "ENOENT") throw marker;
        }
        wallet = { version: 1, purchases: [] };
      }
      if (wallet.version !== 1 || !Array.isArray(wallet.purchases))
        throw Error();
    } catch {
      this.errorCode = "wallet_read_failed";
      return;
    }
    const events = [],
      ids = new Set(),
      ownership = new Set();
    try {
      for (const row of wallet.purchases) {
        const u = users.get(row?.userId) || {
          id: row?.userId,
          name: "",
          phone: "",
          email: "",
          registeredAt: null,
        };
        const event = normalizeDocsSale(
          {
            protocol: 1,
            eventId: "validation",
            observedAt: new Date(this.now()).toISOString(),
            user: u,
            purchase: {
              id: row.id,
              userId: row.userId,
              instructionId: row.instructionId,
              title: text(row.title, 500),
              format: row.format,
              amountMinor: row.amountMinor,
              currency: "RUB",
              createdAt: row.createdAt,
            },
          },
          this.now(),
        );
        const key = JSON.stringify([
          event.user.id,
          event.purchase.instructionId,
          event.purchase.format,
        ]);
        if (ids.has(event.purchase.id) || ownership.has(key)) throw Error();
        ids.add(event.purchase.id);
        ownership.add(key);
        events.push(event);
      }
    } catch {
      this.errorCode = "invalid_source_data";
      this.invalid = 1;
      return;
    }
    for (const event of events) this.capture(event);
    this.sourceCount = events.length;
    this.set("source_count", events.length);
    this.set("source_generated_at", new Date(this.now()).toISOString());
    const previous = Number(this.get("maximum_source_count") || 0);
    this.errorCode = events.length < previous ? "source_count_decreased" : "";
    this.set("maximum_source_count", Math.max(previous, events.length));
    this.scanOk = true;
  }
  status() {
    const row = this.db
      .prepare(
        "SELECT count(*) pending,MIN(queued_at) oldest,COALESCE(SUM(error IN ('HTTP_400','HTTP_401','HTTP_403','HTTP_409','HTTP_413','HTTP_422','INVALID_ACK')),0) rejected FROM outbox WHERE delivered=0",
      )
      .get();
    const stalled =
      row.oldest &&
      this.now() - row.oldest > 300000 &&
      this.now() - Number(this.get("last_delivery_at") || 0) > 180000;
    return {
      scanOk: this.scanOk,
      sourceCount: this.sourceCount,
      pending: row.pending,
      rejected: row.rejected + this.invalid,
      errorCode: this.errorCode || (stalled ? "delivery_delayed" : ""),
      sourceGeneratedAt:
        this.get("source_generated_at") || new Date(this.now()).toISOString(),
    };
  }
  request(path, payload) {
    return this.fetcher(this.config.endpoint + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + this.config.token,
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(12000),
    });
  }
  async deliver() {
    const fresh = this.db
        .prepare(
          "SELECT rowid,* FROM outbox WHERE delivered=0 AND next_at<=? ORDER BY rowid DESC LIMIT 10",
        )
        .all(this.now()),
      old = this.db
        .prepare(
          "SELECT rowid,* FROM outbox WHERE delivered=0 AND next_at<=? ORDER BY rowid LIMIT 50",
        )
        .all(this.now());
    const rows = [
        ...new Map([...fresh, ...old].map((r) => [r.event_id, r])).values(),
      ].slice(0, 50),
      started = Date.now();
    for (const row of rows) {
      if (Date.now() - started > 90000) break;
      let error = "",
        stop = false;
      try {
        const p = JSON.parse(row.payload),
          r = await this.request("", p);
        if (!r.ok) {
          error = "HTTP_" + r.status;
          stop = r.status === 401 || r.status === 403;
        } else {
          const ack = await r.json();
          if (this.acknowledges(ack, p, row.event_id)) {
            this.db
              .prepare(
                "UPDATE outbox SET delivered=1,error='' WHERE event_id=?",
              )
              .run(row.event_id);
            this.set("last_delivery_at", this.now());
            continue;
          }
          error = "INVALID_ACK";
        }
      } catch {
        error = "NETWORK_ERROR";
        stop = true;
      }
      this.db
        .prepare(
          "UPDATE outbox SET attempts=attempts+1,next_at=?,error=? WHERE event_id=?",
        )
        .run(
          this.now() + Math.min(900000, 5000 * 2 ** Math.min(row.attempts, 8)),
          error,
          row.event_id,
        );
      if (stop) break;
    }
  }
  async cycle() {
    this.scan();
    await this.deliver();
    const s = this.status(),
      response = await this.request("/heartbeat", s);
    if (!response.ok)
      throw Error("DOCS_SALES_HEARTBEAT_HTTP_" + response.status);
    const ack = await response.json();
    if (ack.ok !== true || ack.source !== this.sourceName)
      throw Error("INVALID_DOCS_SALES_HEARTBEAT");
    const file = join(this.config.stateDir, "status.json"),
      temporary = file + "." + randomUUID();
    try {
      writeFileSync(
        temporary,
        JSON.stringify({ ...s, checkedAt: new Date(this.now()).toISOString() }),
        { mode: 0o600, flag: "wx" },
      );
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
    return s;
  }
  close() {
    this.db.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.umask(0o077);
  let config;
  try {
    config = JSON.parse(readFileSync(process.argv[2], "utf8"));
  } catch {
    throw Error("DOCS_SALES_CONFIGURATION_UNREADABLE");
  }
  const agent = new DocsSalesAgent(config),
    stop = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => stop.abort());
  const cycle = async () => {
    try {
      const s = await agent.cycle();
      console.log(
        "DOCS_SALES_SYNC=" +
          (s.scanOk && !s.rejected && !s.errorCode ? "OK" : "CHECK_REQUIRED") +
          " SOURCE_PURCHASES=" +
          s.sourceCount +
          " PENDING=" +
          s.pending +
          " REJECTED=" +
          s.rejected,
      );
      return s.scanOk && !s.rejected && !s.errorCode;
    } catch {
      console.error("DOCS_SALES_SYNC=CONNECTION_CHECK_REQUIRED");
      return false;
    }
  };
  try {
    if (process.argv.includes("--once"))
      process.exitCode = (await cycle()) ? 0 : 1;
    else
      while (!stop.signal.aborted) {
        await cycle();
        if (!stop.signal.aborted)
          await delay(30000, undefined, { signal: stop.signal }).catch((e) => {
            if (e.name !== "AbortError") throw e;
          });
      }
  } finally {
    agent.close();
  }
}
