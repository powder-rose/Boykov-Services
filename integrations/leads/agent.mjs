// Read-only collectors for existing durable site storage. No public form keys.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream, chmodSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const stringify = (value) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
const labels = {
  utm: "Рекламные метки",
  attribution: "Источник перехода",
  objectType: "Тип объекта",
  objectTypeLabel: "Тип объекта",
  location: "Местоположение",
  objectMetrics: "Параметры объекта",
  notification: "Уведомление",
  documentsStatus: "Документация",
  passportDevelopedAt: "Дата разработки паспорта",
  classification: "Результат проверки",
  attachments: "Прикреплённые файлы",
  referrer: "Источник перехода",
  company: "Организация",
  object: "Объект / задача",
  interest: "Вопрос клиента",
  articleTitle: "Название статьи",
  consent: "Согласие на обработку данных",
  consentDocuments: "Документы согласия",
};
export function mapRecord(record, format, host) {
  if (format === "generic-jsonl") return record;
  const payload =
    format === "accessibility-sqlite"
      ? JSON.parse(record.payload)
      : record.data;
  if (!payload || typeof payload !== "object")
    throw new Error("INVALID_SOURCE_RECORD");
  const contact = payload.answers?.contact ?? payload;
  const fields = [];
  for (const question of payload.questions ?? []) {
    fields.push({
      label: question.question,
      value: (question.answers ?? []).map((a) => a.label).join(", "),
    });
  }
  for (const [key, value] of Object.entries(payload.answers ?? {})) {
    if (key !== "contact" && !payload.questions)
      fields.push({ label: labels[key] ?? key, value: stringify(value) });
  }
  const extras =
    format === "security-jsonl"
      ? { attribution: record.attribution, ...payload, ...contact }
      : payload;
  for (const [key, value] of Object.entries(extras)) {
    if (
      ![
        "name",
        "phone",
        "email",
        "message",
        "comment",
        "service",
        "serviceTitle",
        "source",
        "sourceLabel",
        "pageUrl",
        "sourcePage",
        "createdAt",
        "requestId",
        "website",
        "startedAt",
        "answers",
        "questions",
      ].includes(key) &&
      value !== undefined &&
      value !== null &&
      value !== ""
    )
      fields.push({ label: labels[key] ?? key, value: stringify(value) });
  }
  let pageUrl = format === "security-jsonl" ? record.page : payload.pageUrl;
  if (pageUrl) pageUrl = new URL(pageUrl, "https://" + host).href;
  return {
    eventId: String(record.id),
    createdAt:
      format === "accessibility-sqlite" ? record.created_at : record.receivedAt,
    name: contact.name ?? "",
    phone: contact.phone ?? "",
    email: contact.email ?? "",
    service: payload.serviceTitle ?? payload.service ?? "",
    message: payload.comment ?? payload.message ?? "",
    pageUrl: pageUrl ?? "",
    form:
      payload.sourceLabel ??
      {
        "passport-security-quiz": "Квиз",
        "passport-security-article-callback": "Звонок из статьи",
        "passport-security-final-cta": "Обсудить объект",
      }[record.source] ??
      record.source ??
      payload.source ??
      "",
    fields,
  };
}

export class LeadAgent {
  constructor({
    stateDir,
    sourceFile,
    format,
    endpoint,
    token,
    host,
    fetcher = fetch,
    now = Date.now,
    allowLoopback = false,
  }) {
    const url = new URL(endpoint);
    if (
      (url.protocol !== "https:" &&
        !(
          allowLoopback &&
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/hooks\/leads\/[a-zA-Z0-9_-]+$/.test(url.pathname) ||
      !/^[a-f0-9]{64}$/.test(token || "")
    )
      throw new Error("INVALID_AGENT_CONNECTION");
    if (
      !["accessibility-sqlite", "security-jsonl", "generic-jsonl"].includes(
        format,
      )
    )
      throw new Error("INVALID_AGENT_FORMAT");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const database = join(stateDir, "delivery.sqlite");
    if (resolve(database) === resolve(sourceFile))
      throw new Error("SOURCE_IS_QUEUE_DATABASE");
    this.db = new DatabaseSync(database);
    chmodSync(database, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS outbox (
        event_id TEXT PRIMARY KEY,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,queued_at INTEGER NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT,receipt TEXT
      );
      CREATE INDEX IF NOT EXISTS outbox_due ON outbox(delivered,next_at);
      CREATE TABLE IF NOT EXISTS rejected (id TEXT PRIMARY KEY,raw TEXT NOT NULL,error TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_identity (id INTEGER PRIMARY KEY CHECK(id=1),endpoint TEXT NOT NULL,source TEXT NOT NULL,format TEXT NOT NULL,host TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_state (id INTEGER PRIMARY KEY CHECK(id=1),updated_at INTEGER NOT NULL,scan_ok INTEGER NOT NULL,rejected INTEGER NOT NULL,heartbeat_at INTEGER);
      INSERT OR IGNORE INTO agent_state VALUES(1,0,0,0,NULL);`);
    const identity = this.db
      .prepare("SELECT * FROM agent_identity WHERE id=1")
      .get();
    if (
      identity &&
      (identity.endpoint !== url.href ||
        identity.source !== resolve(sourceFile) ||
        identity.format !== format ||
        identity.host !== host)
    ) {
      this.db.close();
      throw new Error("AGENT_STATE_BELONGS_TO_ANOTHER_SOURCE");
    }
    this.db
      .prepare("INSERT OR IGNORE INTO agent_identity VALUES(1,?,?,?,?)")
      .run(url.href, resolve(sourceFile), format, host);
    Object.assign(this, {
      sourceFile,
      format,
      endpoint: url.href,
      siteId: url.pathname.split("/").at(-1),
      token,
      host,
      fetcher,
      now,
    });
  }
  enqueue(payload) {
    const encoded = JSON.stringify(payload);
    if (
      !payload ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(payload.eventId || "") ||
      !payload.createdAt ||
      Buffer.byteLength(encoded) > 126000
    )
      throw new Error("INVALID_OR_OVERSIZED_LEAD");
    const previous = this.db
      .prepare("SELECT payload_hash FROM outbox WHERE event_id=?")
      .get(payload.eventId);
    if (previous && previous.payload_hash !== hash(encoded))
      throw new Error("SOURCE_ID_CONTENT_CHANGED");
    this.db
      .prepare(
        "INSERT OR IGNORE INTO outbox(event_id,payload,payload_hash,created_at,queued_at) VALUES(?,?,?,?,?)",
      )
      .run(
        payload.eventId,
        encoded,
        hash(encoded),
        payload.createdAt,
        this.now(),
      );
  }
  reject(raw, error) {
    // The durable rejection record remains available for recovery; logs have no contacts.
    this.db
      .prepare("INSERT OR IGNORE INTO rejected VALUES(?,?,?)")
      .run(
        hash(raw),
        raw,
        error.message === "SOURCE_ID_CONTENT_CHANGED"
          ? error.message
          : "INVALID_SOURCE_RECORD",
      );
  }
  async scan() {
    let rejected = 0,
      source;
    const consume = (record, raw) => {
      try {
        this.enqueue(mapRecord(record, this.format, this.host));
      } catch (error) {
        rejected++;
        this.reject(raw, error);
      }
    };
    try {
      if (this.format === "accessibility-sqlite") {
        source = new DatabaseSync(this.sourceFile, { readOnly: true });
        source.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
        if (
          !source
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='trigger' AND name='boykov_lead_capture'",
            )
            .get()
        )
          throw new Error("SOURCE_CAPTURE_TRIGGER_MISSING");
        for (const row of source
          .prepare(
            "SELECT id,payload,created_at FROM boykov_lead_outbox ORDER BY rowid",
          )
          .iterate())
          consume(row, JSON.stringify(row));
      } else {
        const lines = createInterface({
          input: createReadStream(this.sourceFile, { encoding: "utf8" }),
          crlfDelay: Infinity,
        });
        for await (const raw of lines) {
          if (!raw.trim()) continue;
          try {
            consume(JSON.parse(raw), raw);
          } catch (error) {
            rejected++;
            this.reject(raw, error);
          }
        }
      }
      this.db
        .prepare(
          "UPDATE agent_state SET updated_at=?,scan_ok=?,rejected=? WHERE id=1",
        )
        .run(this.now(), Number(!rejected), rejected);
    } catch {
      this.db
        .prepare("UPDATE agent_state SET updated_at=?,scan_ok=0 WHERE id=1")
        .run(this.now());
    } finally {
      source?.close();
    }
  }
  async request(endpoint, body) {
    return this.fetcher(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + this.token,
      },
      body: JSON.stringify(body),
    });
  }
  summary() {
    const pending = this.db
      .prepare(
        "SELECT count(*) AS count,min(queued_at) AS oldest FROM outbox WHERE delivered=0",
      )
      .get();
    const state = this.db.prepare("SELECT * FROM agent_state WHERE id=1").get();
    return {
      pending: pending.count,
      rejected:
        state.rejected +
        this.db
          .prepare(
            "SELECT count(*) AS n FROM outbox WHERE delivered=0 AND error IN ('HTTP_400','HTTP_401','HTTP_403','HTTP_409','HTTP_413','HTTP_415','HTTP_422','INVALID_ACKNOWLEDGEMENT')",
          )
          .get().n,
      scanOk: Boolean(state.scan_ok),
      oldestPendingAt:
        pending.oldest === null ? null : new Date(pending.oldest).toISOString(),
    };
  }
  async heartbeat() {
    try {
      const response = await this.request(
        this.endpoint + "/heartbeat",
        this.summary(),
      );
      if (response.status === 200) {
        const ack = await response.json();
        if (ack.ok === true && ack.siteId === this.siteId)
          this.db
            .prepare("UPDATE agent_state SET heartbeat_at=? WHERE id=1")
            .run(this.now());
      }
    } catch {
      /* Retained queue and stale central heartbeat make the outage visible. */
    }
  }
  async deliver(limit = 20) {
    const fresh = this.db
      .prepare(
        "SELECT * FROM outbox WHERE delivered=0 AND next_at<=? ORDER BY created_at DESC,event_id DESC LIMIT ?",
      )
      .all(this.now(), Math.ceil(limit / 2));
    const oldest = this.db
      .prepare(
        "SELECT * FROM outbox WHERE delivered=0 AND next_at<=? ORDER BY queued_at,event_id LIMIT ?",
      )
      .all(this.now(), limit);
    const rows = [
      ...new Map(
        [...fresh, ...oldest].map((row) => [row.event_id, row]),
      ).values(),
    ].slice(0, limit);
    for (const row of rows) {
      let error = "DELIVERY_UNCONFIRMED";
      try {
        const response = await this.request(
          this.endpoint,
          JSON.parse(row.payload),
        );
        error = "HTTP_" + response.status;
        if ([200, 201].includes(response.status)) {
          const ack = await response.json();
          if (
            ack.ok === true &&
            ack.siteId === this.siteId &&
            ack.eventId === row.event_id &&
            typeof ack.id === "string" &&
            ack.id.length > 0
          ) {
            this.db
              .prepare(
                "UPDATE outbox SET delivered=1,error=NULL,receipt=? WHERE event_id=?",
              )
              .run(ack.id, row.event_id);
            continue;
          }
          error = "INVALID_ACKNOWLEDGEMENT";
        }
      } catch {
        error = "DELIVERY_UNCONFIRMED";
      }
      const delay = Math.min(900000, 5000 * 2 ** Math.min(row.attempts, 8));
      this.db
        .prepare(
          "UPDATE outbox SET attempts=attempts+1,next_at=?,error=? WHERE event_id=?",
        )
        .run(this.now() + delay, error, row.event_id);
    }
  }
  async tick() {
    await this.scan();
    await this.heartbeat();
    await this.deliver();
    await this.heartbeat();
  }
  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.umask(0o077);
  const agent = new LeadAgent({
    stateDir: process.env.LEADS_AGENT_STATE || "/state",
    sourceFile: process.env.LEADS_SOURCE_FILE,
    format: process.env.LEADS_SOURCE_FORMAT,
    endpoint: process.env.LEADS_ENDPOINT,
    token: process.env.LEADS_TOKEN,
    host: process.env.LEADS_SITE_HOST,
  });
  let stopping = false;
  process.once("SIGTERM", () => {
    stopping = true;
  });
  process.once("SIGINT", () => {
    stopping = true;
  });
  while (!stopping) {
    try {
      await agent.tick();
      console.log(
        JSON.stringify({ type: "lead_delivery", ...agent.summary() }),
      );
    } catch {
      console.error("LEADS_AGENT_CYCLE_FAILED");
    }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, 15000));
  }
  agent.close();
}
