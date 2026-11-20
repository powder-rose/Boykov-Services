// Sidecar collector: source files are read-only. Passwords, JWTs and consent records are never queued.
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
import {
  DOCS_COMPANY_FIELDS,
  normalizeDocsCustomerEvent,
} from "../../shared/docs-customers.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const timestamp = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
export function validateDocsConnection(config) {
  const url = new URL(config.endpoint);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/hooks/docs-customers" ||
    !/^[a-f0-9]{64}$/.test(config.token || "") ||
    !timestamp(config.since)
  )
    throw Error("INVALID_DOCS_CUSTOMER_CONNECTION");
  return url.href;
}
export class DocsCustomerAgent {
  constructor(config, { fetcher = fetch, now = Date.now } = {}) {
    this.config = { ...config, endpoint: validateDocsConnection(config) };
    this.fetcher = fetcher;
    this.now = now;
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    const file = join(config.stateDir, "delivery.sqlite");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1),endpoint TEXT NOT NULL,source TEXT NOT NULL,since TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS outbox(event_id TEXT PRIMARY KEY,payload TEXT NOT NULL,queued_at INTEGER NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '');
   CREATE INDEX IF NOT EXISTS outbox_due ON outbox(delivered,next_at);
   CREATE TABLE IF NOT EXISTS capture(kind TEXT NOT NULL,user_id TEXT NOT NULL,content_hash TEXT NOT NULL,PRIMARY KEY(kind,user_id));
   CREATE TABLE IF NOT EXISTS quarantine(source_key TEXT PRIMARY KEY,error TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS clock(id INTEGER PRIMARY KEY CHECK(id=1),last_seen INTEGER NOT NULL);
   INSERT OR IGNORE INTO clock VALUES(1,0);`);
    const identity = this.db.prepare("SELECT * FROM identity WHERE id=1").get();
    if (
      identity &&
      (identity.endpoint !== this.config.endpoint ||
        identity.source !== resolve(config.sourceDir) ||
        identity.since !== config.since)
    ) {
      this.db.close();
      throw Error("DOCS_QUEUE_BELONGS_TO_ANOTHER_SOURCE");
    }
    this.db
      .prepare("INSERT OR IGNORE INTO identity VALUES(1,?,?,?)")
      .run(this.config.endpoint, resolve(config.sourceDir), config.since);
    this.scanOk = false;
    this.errorCode = "";
  }
  capture(kind, user, company, occurredAt) {
    const sourceKey = kind + ":" + user.id;
    const content = { kind, user, company, occurredAt },
      digest = hash(JSON.stringify(content));
    if (
      this.db
        .prepare("SELECT content_hash FROM capture WHERE kind=? AND user_id=?")
        .get(kind, user.id)?.content_hash === digest
    ) {
      this.db
        .prepare("DELETE FROM quarantine WHERE source_key=?")
        .run(sourceKey);
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const last = this.db
          .prepare("SELECT last_seen FROM clock WHERE id=1")
          .get().last_seen,
        observed = Math.max(this.now(), last + 1);
      const payload = normalizeDocsCustomerEvent(
        {
          eventId: randomUUID(),
          ...content,
          observedAt: new Date(observed).toISOString(),
        },
        Math.max(this.now(), observed),
      );
      this.db
        .prepare("INSERT INTO outbox(event_id,payload,queued_at) VALUES(?,?,?)")
        .run(payload.eventId, JSON.stringify(payload), this.now());
      this.db
        .prepare(
          "INSERT INTO capture VALUES(?,?,?) ON CONFLICT(kind,user_id) DO UPDATE SET content_hash=excluded.content_hash",
        )
        .run(kind, user.id, digest);
      this.db.prepare("UPDATE clock SET last_seen=? WHERE id=1").run(observed);
      this.db
        .prepare("DELETE FROM quarantine WHERE source_key=?")
        .run(sourceKey);
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      this.db
        .prepare("INSERT OR REPLACE INTO quarantine VALUES(?,?)")
        .run(sourceKey, "INVALID_SOURCE_DATA");
    }
  }
  scan() {
    let users;
    try {
      users = JSON.parse(
        readFileSync(join(this.config.sourceDir, "users.json"), "utf8"),
      );
      if (!Array.isArray(users)) throw Error();
    } catch {
      this.scanOk = false;
      this.errorCode = "users_read_failed";
      return;
    }
    const byId = new Map();
    for (const row of users) {
      if (!row || typeof row.id !== "string") continue;
      const user = {
        id: row.id,
        name: row.name ?? "",
        email: row.email ?? "",
        phone: row.phone ?? "",
        registeredAt: timestamp(row.createdAt),
      };
      byId.set(user.id, user);
      if (user.registeredAt && user.registeredAt >= this.config.since)
        this.capture("registration", user, null, user.registeredAt);
    }
    let profiles;
    try {
      let data;
      try {
        data = readFileSync(
          join(this.config.sourceDir, "company-profiles.json"),
          "utf8",
        );
      } catch (error) {
        if (error.code === "ENOENT") data = '{"version":1,"profiles":{}}';
        else throw error;
      }
      const state = JSON.parse(data);
      if (
        state.version !== 1 ||
        !state.profiles ||
        typeof state.profiles !== "object" ||
        Array.isArray(state.profiles)
      )
        throw Error();
      profiles = state.profiles;
    } catch {
      this.scanOk = false;
      this.errorCode = "companies_read_failed";
      return;
    }
    for (const [id, user] of byId) {
      if (!Object.hasOwn(profiles, id)) continue;
      const row = profiles[id],
        savedAt = timestamp(row?.updatedAt);
      if (!savedAt || savedAt < this.config.since) continue;
      const company = {
        savedAt,
        ...Object.fromEntries(
          DOCS_COMPANY_FIELDS.map((f) => [
            f.name,
            row.companyProfile?.[f.name] ?? "",
          ]),
        ),
      };
      this.capture("company", user, company, savedAt);
    }
    this.scanOk = true;
    this.errorCode = this.db
      .prepare("SELECT count(*) amount FROM quarantine")
      .get().amount
      ? "invalid_source_data"
      : "";
  }
  status() {
    const row = this.db
      .prepare(
        "SELECT count(*) pending,MIN(queued_at) oldest,COALESCE(SUM(error IN ('HTTP_400','HTTP_401','HTTP_403','HTTP_409','HTTP_413','HTTP_422','INVALID_ACK')),0) rejected FROM outbox WHERE delivered=0",
      )
      .get();
    const quarantined = this.db
      .prepare("SELECT count(*) amount FROM quarantine")
      .get().amount;
    return {
      scanOk: this.scanOk,
      pending: row.pending,
      rejected: row.rejected + quarantined,
      errorCode:
        this.errorCode ||
        (row.oldest && this.now() - row.oldest > 300000
          ? "delivery_delayed"
          : ""),
    };
  }
  async request(path, payload) {
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
  async heartbeat() {
    const response = await this.request("/heartbeat", this.status());
    if (!response.ok) throw Error("DOCS_HEARTBEAT_HTTP_" + response.status);
    const ack = await response.json();
    if (ack.ok !== true || ack.source !== "boykovdocs.ru")
      throw Error("INVALID_DOCS_HEARTBEAT_ACK");
  }
  async deliver() {
    // Reserve room for fresh events even when older rejected rows keep retrying.
    const fresh = this.db
      .prepare(
        "SELECT * FROM outbox WHERE delivered=0 AND next_at<=? ORDER BY queued_at DESC,event_id DESC LIMIT 10",
      )
      .all(this.now());
    const older = this.db
      .prepare(
        "SELECT * FROM outbox WHERE delivered=0 AND next_at<=? ORDER BY queued_at,event_id LIMIT 50",
      )
      .all(this.now());
    const rows = [
      ...new Map(
        [...fresh, ...older].map((row) => [row.event_id, row]),
      ).values(),
    ].slice(0, 50);
    for (const row of rows) {
      let error = "",
        networkFailure = false;
      try {
        const response = await this.request("", JSON.parse(row.payload));
        if (!response.ok) error = "HTTP_" + response.status;
        else {
          const ack = await response.json(),
            payload = JSON.parse(row.payload);
          if (
            ack.ok === true &&
            ack.eventId === row.event_id &&
            ack.externalId === payload.user.id &&
            (typeof ack.customerId === "string" || ack.ignored === true)
          ) {
            this.db
              .prepare(
                "UPDATE outbox SET delivered=1,error='' WHERE event_id=?",
              )
              .run(row.event_id);
            continue;
          }
          error = "INVALID_ACK";
        }
      } catch {
        error = "NETWORK_ERROR";
        networkFailure = true;
      }
      const wait = Math.min(900000, 5000 * 2 ** Math.min(row.attempts, 8));
      this.db
        .prepare(
          "UPDATE outbox SET attempts=attempts+1,next_at=?,error=? WHERE event_id=?",
        )
        .run(this.now() + wait, error, row.event_id);
      if (networkFailure) break;
    }
  }
  async cycle() {
    this.scan();
    await this.deliver();
    await this.heartbeat();
    const status = this.status();
    const file = join(this.config.stateDir, "status.json"),
      temporary = file + "." + randomUUID();
    try {
      writeFileSync(
        temporary,
        JSON.stringify({
          ...status,
          checkedAt: new Date(this.now()).toISOString(),
        }),
        { mode: 0o600, flag: "wx" },
      );
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
    return status;
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
    throw Error("DOCS_CUSTOMERS_CONFIGURATION_UNREADABLE");
  }
  const agent = new DocsCustomerAgent(config),
    stop = new AbortController();
  for (const s of ["SIGTERM", "SIGINT"]) process.once(s, () => stop.abort());
  const cycle = async () => {
    try {
      const s = await agent.cycle();
      console.log(
        "DOCS_CUSTOMERS_SYNC=" +
          (s.scanOk && !s.rejected ? "OK" : "CHECK_REQUIRED") +
          " PENDING=" +
          s.pending +
          " REJECTED=" +
          s.rejected,
      );
      return s.scanOk && !s.rejected;
    } catch {
      console.error("DOCS_CUSTOMERS_SYNC=CONNECTION_CHECK_REQUIRED");
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
