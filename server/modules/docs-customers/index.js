import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  DOCS_CUSTOMERS_SINCE,
  DOCS_COMPANY_FIELDS,
  DOCS_CALL_OUTCOMES,
  normalizeDocsCustomerEvent,
  customerText,
  customerCallNote,
} from "../../../shared/docs-customers.js";
const bad = (message, status = 400) =>
  Object.assign(new Error(message), { status });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const wrap = (fn) => (req, res, next) =>
  Promise.resolve()
    .then(() => fn(req, res))
    .catch(next);
function transaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = work();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}
const actor = (req) => ({
  id: req.actor?.id || null,
  name: req.actor?.name || "Общий доступ",
  kind: req.actor?.id ? "account" : "shared",
});
const searchText = (row) =>
  [
    row.external_id,
    row.name,
    row.email,
    row.phone,
    row.phone.replace(/\D/g, ""),
    ...Object.values(JSON.parse(row.company || "{}")),
  ]
    .join(" ")
    .toLowerCase();
const companyChanges = (before, after) =>
  DOCS_COMPANY_FIELDS.filter(
    (f) => (before[f.name] || "") !== (after[f.name] || ""),
  ).map((f) => f.name);
export function createDocsCustomersModule(db, { now = Date.now } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS docs_customer_connection(id INTEGER PRIMARY KEY CHECK(id=1),import_since TEXT NOT NULL,token_hash TEXT,token_issued_at TEXT,last_received_at TEXT,last_heartbeat_at TEXT,pending INTEGER NOT NULL DEFAULT 0,rejected INTEGER NOT NULL DEFAULT 0,scan_ok INTEGER NOT NULL DEFAULT 0,error_code TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS docs_customers(id TEXT PRIMARY KEY,external_id TEXT NOT NULL UNIQUE,name TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',registered_at TEXT,contact_observed_at TEXT NOT NULL,company TEXT,company_saved_at TEXT,company_observed_at TEXT,created_at TEXT NOT NULL,received_at TEXT NOT NULL,source_updated_at TEXT NOT NULL,search_text TEXT NOT NULL DEFAULT '',call_count INTEGER NOT NULL DEFAULT 0,last_call_id TEXT,version INTEGER NOT NULL DEFAULT 1);
 CREATE INDEX IF NOT EXISTS docs_customers_order ON docs_customers(source_updated_at DESC,id);
 CREATE TABLE IF NOT EXISTS docs_customer_receipts(event_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,customer_id TEXT NOT NULL,received_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS docs_customer_calls(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,created_at TEXT NOT NULL,outcome TEXT NOT NULL,note TEXT NOT NULL,phone TEXT NOT NULL,actor_id TEXT,actor_name TEXT NOT NULL,actor_kind TEXT NOT NULL,voided_at TEXT,voided_by_id TEXT,voided_by_name TEXT,voided_by_kind TEXT);
 CREATE INDEX IF NOT EXISTS docs_customer_calls_customer ON docs_customer_calls(customer_id,created_at DESC);
 CREATE INDEX IF NOT EXISTS docs_customer_calls_actor ON docs_customer_calls(actor_id,customer_id);
 CREATE TABLE IF NOT EXISTS docs_customer_company_versions(event_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,saved_at TEXT NOT NULL,company TEXT NOT NULL,user_snapshot TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS docs_customer_company_versions_customer ON docs_customer_company_versions(customer_id,saved_at DESC);
 CREATE TABLE IF NOT EXISTS docs_customer_actions(request_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,actor_key TEXT NOT NULL,payload_hash TEXT NOT NULL,result TEXT NOT NULL);`);
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(docs_customers)")
      .all()
      .map((c) => c.name),
  );
  for (const name of [
    "deleted_at",
    "deleted_by_id",
    "deleted_by_name",
    "deleted_by_kind",
  ]) {
    if (!columns.has(name))
      db.exec(`ALTER TABLE docs_customers ADD COLUMN ${name} TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS docs_customers_deleted ON docs_customers(deleted_at,source_updated_at DESC);
    CREATE TABLE IF NOT EXISTS docs_customer_lifecycle(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL,actor_id TEXT,actor_name TEXT NOT NULL,actor_kind TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS docs_customer_lifecycle_customer ON docs_customer_lifecycle(customer_id,created_at DESC);`);
  db.exec(`CREATE TABLE IF NOT EXISTS docs_customer_company_updates(customer_id TEXT PRIMARY KEY,event_id TEXT NOT NULL,changed_at TEXT NOT NULL,fields TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS docs_customer_company_reviews(customer_id TEXT NOT NULL,actor_key TEXT NOT NULL,event_id TEXT NOT NULL,reviewed_at TEXT NOT NULL,PRIMARY KEY(customer_id,actor_key));
    CREATE TABLE IF NOT EXISTS docs_customer_module_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  const saveCompanyUpdate = (id, eventId, changedAt, fields) =>
    db
      .prepare(
        "INSERT INTO docs_customer_company_updates VALUES(?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET event_id=excluded.event_id,changed_at=excluded.changed_at,fields=excluded.fields",
      )
      .run(id, eventId, changedAt, JSON.stringify(fields));
  // Existing captured versions can prove a real change. Initialize this once, never on each restart.
  if (
    !db
      .prepare(
        "SELECT value FROM docs_customer_module_meta WHERE key='company_updates_v1'",
      )
      .get()
  )
    transaction(db, () => {
      for (const row of db
        .prepare(
          "SELECT id,company,company_saved_at FROM docs_customers WHERE company IS NOT NULL",
        )
        .all()) {
        let before = null,
          latest = null;
        for (const version of db
          .prepare(
            "SELECT event_id,saved_at,company FROM docs_customer_company_versions WHERE customer_id=? AND saved_at<=? ORDER BY saved_at,rowid",
          )
          .all(row.id, row.company_saved_at)) {
          const next = JSON.parse(version.company),
            fields = before ? companyChanges(before, next) : [];
          if (fields.length)
            latest = {
              eventId: version.event_id,
              changedAt: version.saved_at,
              fields,
            };
          before = next;
        }
        if (latest && !companyChanges(before, JSON.parse(row.company)).length)
          saveCompanyUpdate(
            row.id,
            latest.eventId,
            latest.changedAt,
            latest.fields,
          );
        else {
          const head = db
            .prepare(
              "SELECT event_id FROM docs_customer_company_versions WHERE customer_id=? AND saved_at=? ORDER BY rowid DESC LIMIT 1",
            )
            .get(row.id, row.company_saved_at);
          saveCompanyUpdate(
            row.id,
            head?.event_id || "legacy:" + row.id,
            row.company_saved_at,
            [],
          );
        }
      }
      db.prepare(
        "INSERT INTO docs_customer_module_meta VALUES('company_updates_v1','1')",
      ).run();
    });
  db.prepare(
    "INSERT OR IGNORE INTO docs_customer_connection(id,import_since) VALUES(1,?)",
  ).run(DOCS_CUSTOMERS_SINCE);
  const connectionRow = () =>
    db.prepare("SELECT * FROM docs_customer_connection WHERE id=1").get();
  function connection() {
    const r = connectionRow(),
      age = r.last_heartbeat_at
        ? now() - Date.parse(r.last_heartbeat_at)
        : Infinity;
    return {
      configured: !!r.token_hash,
      since: r.import_since,
      lastReceivedAt: r.last_received_at,
      lastHeartbeatAt: r.last_heartbeat_at,
      pending: r.pending,
      rejected: r.rejected,
      scanOk: !!r.scan_ok,
      errorCode: r.error_code,
      status: !r.token_hash
        ? "unconfigured"
        : !r.last_heartbeat_at
          ? "waiting"
          : age > 180000
            ? "offline"
            : !r.scan_ok || r.rejected || r.error_code
              ? "attention"
              : r.pending
                ? "syncing"
                : "online",
    };
  }
  function authorize(req) {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(
        req.get("authorization") || "",
      )?.[1],
      expected = connectionRow().token_hash;
    if (
      !token ||
      !expected ||
      !timingSafeEqual(
        Buffer.from(hash(token), "hex"),
        Buffer.from(expected, "hex"),
      )
    )
      throw bad("Нет доступа к синхронизации BoykovDocs.", 401);
  }
  function get(id) {
    const r = db.prepare("SELECT * FROM docs_customers WHERE id=?").get(id);
    if (!r) throw bad("Клиент не найден.", 404);
    return r;
  }
  function callView(r, req, deleted = false) {
    return {
      id: r.id,
      createdAt: r.created_at,
      outcome: r.outcome,
      note: r.note,
      phone: r.phone,
      actor: { id: r.actor_id, name: r.actor_name, kind: r.actor_kind },
      voidedAt: r.voided_at,
      voidedBy: r.voided_at
        ? { id: r.voided_by_id, name: r.voided_by_name, kind: r.voided_by_kind }
        : null,
      canVoid:
        !deleted &&
        !r.voided_at &&
        (req.actor?.role === "admin" ||
          (r.actor_kind === "account"
            ? r.actor_id === req.actor?.id
            : !req.actor?.id)),
    };
  }
  const reviewActor = (req) => actor(req).id || "shared";
  function companyUpdate(id, req) {
    const r = db
      .prepare(
        "SELECT u.*,v.event_id reviewed_event,v.reviewed_at FROM docs_customer_company_updates u LEFT JOIN docs_customer_company_reviews v ON v.customer_id=u.customer_id AND v.actor_key=? WHERE u.customer_id=?",
      )
      .get(reviewActor(req), id);
    if (!r) return null;
    const unread = r.event_id !== r.reviewed_event;
    const names = JSON.parse(r.fields);
    if (!names.length) return null;
    return {
      eventId: r.event_id,
      changedAt: r.changed_at,
      fields: DOCS_COMPANY_FIELDS.filter((f) => names.includes(f.name)).map(
        (f) => ({ name: f.name, label: f.label }),
      ),
      unread,
      reviewedAt: unread ? null : r.reviewed_at,
    };
  }
  function present(r, req) {
    const last = r.last_call_id
      ? db
          .prepare("SELECT * FROM docs_customer_calls WHERE id=?")
          .get(r.last_call_id)
      : null;
    return {
      id: r.id,
      externalId: r.external_id,
      name: r.name,
      phone: r.phone,
      email: r.email,
      registeredAt: r.registered_at,
      createdAt: r.created_at,
      sourceUpdatedAt: r.source_updated_at,
      company: r.company
        ? { ...JSON.parse(r.company), savedAt: r.company_saved_at }
        : null,
      companyUpdate: companyUpdate(r.id, req),
      callCount: r.call_count,
      lastCall: last ? callView(last, req, !!r.deleted_at) : null,
      deletedAt: r.deleted_at,
      deletedBy: r.deleted_at
        ? {
            id: r.deleted_by_id,
            name: r.deleted_by_name,
            kind: r.deleted_by_kind,
          }
        : null,
      version: r.version,
    };
  }
  function detail(id, req) {
    const r = get(id);
    return {
      customer: present(r, req),
      lifecycle: db
        .prepare(
          "SELECT * FROM docs_customer_lifecycle WHERE customer_id=? ORDER BY rowid DESC",
        )
        .all(id)
        .map((v) => ({
          id: v.id,
          action: v.action,
          createdAt: v.created_at,
          actor: { id: v.actor_id, name: v.actor_name, kind: v.actor_kind },
        })),
      companyHistory: db
        .prepare(
          "SELECT * FROM docs_customer_company_versions WHERE customer_id=? ORDER BY saved_at DESC,rowid DESC LIMIT 50",
        )
        .all(id)
        .map((v) => ({
          eventId: v.event_id,
          savedAt: v.saved_at,
          company: JSON.parse(v.company),
          user: JSON.parse(v.user_snapshot),
        })),
      calls: db
        .prepare(
          "SELECT * FROM docs_customer_calls WHERE customer_id=? ORDER BY rowid DESC",
        )
        .all(id)
        .map((c) => callView(c, req, !!r.deleted_at)),
    };
  }
  function receive(req, res) {
    authorize(req);
    const input = normalizeDocsCustomerEvent(req.body, now()),
      digest = hash(JSON.stringify(input));
    if (input.occurredAt < connectionRow().import_since)
      return res.json({
        ok: true,
        eventId: input.eventId,
        externalId: input.user.id,
        customerId: null,
        ignored: true,
      });
    const result = transaction(db, () => {
      const oldReceipt = db
        .prepare("SELECT * FROM docs_customer_receipts WHERE event_id=?")
        .get(input.eventId);
      if (oldReceipt) {
        if (oldReceipt.payload_hash !== digest)
          throw bad("Идентификатор события уже использован.", 409);
        return { customerId: oldReceipt.customer_id, duplicate: true };
      }
      const stamp = new Date(now()).toISOString();
      let r = db
        .prepare("SELECT * FROM docs_customers WHERE external_id=?")
        .get(input.user.id);
      if (!r) {
        const id = randomUUID();
        db.prepare(
          "INSERT INTO docs_customers(id,external_id,name,phone,email,registered_at,contact_observed_at,created_at,received_at,source_updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ).run(
          id,
          input.user.id,
          input.user.name,
          input.user.phone,
          input.user.email,
          input.user.registeredAt,
          input.observedAt,
          stamp,
          stamp,
          input.occurredAt,
        );
        r = get(id);
      } else if (input.observedAt > r.contact_observed_at) {
        db.prepare(
          "UPDATE docs_customers SET name=?,phone=?,email=?,registered_at=COALESCE(registered_at,?),contact_observed_at=?,version=version+1 WHERE id=?",
        ).run(
          input.user.name,
          input.user.phone,
          input.user.email,
          input.user.registeredAt,
          input.observedAt,
          r.id,
        );
      }
      r = get(r.id);
      if (input.company)
        db.prepare(
          "INSERT INTO docs_customer_company_versions VALUES(?,?,?,?,?)",
        ).run(
          input.eventId,
          r.id,
          input.company.savedAt,
          JSON.stringify(
            Object.fromEntries(
              DOCS_COMPANY_FIELDS.map((f) => [f.name, input.company[f.name]]),
            ),
          ),
          JSON.stringify(input.user),
        );
      if (
        input.company &&
        (!r.company_saved_at ||
          input.company.savedAt > r.company_saved_at ||
          (input.company.savedAt === r.company_saved_at &&
            input.observedAt > (r.company_observed_at || "")))
      ) {
        const company = Object.fromEntries(
          DOCS_COMPANY_FIELDS.map((f) => [f.name, input.company[f.name]]),
        );
        const changed = r.company
          ? companyChanges(JSON.parse(r.company), company)
          : [];
        if (changed.length || !r.company)
          saveCompanyUpdate(
            r.id,
            input.eventId,
            input.company.savedAt,
            changed,
          );
        db.prepare(
          "UPDATE docs_customers SET company=?,company_saved_at=?,company_observed_at=?,version=version+1 WHERE id=?",
        ).run(
          JSON.stringify(company),
          input.company.savedAt,
          input.observedAt,
          r.id,
        );
      }
      r = get(r.id);
      if (input.company) {
        const head = db
          .prepare(
            "SELECT * FROM docs_customer_company_updates WHERE customer_id=? AND fields='[]'",
          )
          .get(r.id);
        if (head && input.company.savedAt < head.changed_at) {
          const previous = db
            .prepare(
              "SELECT company FROM docs_customer_company_versions WHERE customer_id=? AND saved_at<? ORDER BY saved_at DESC,rowid DESC LIMIT 1",
            )
            .get(r.id, head.changed_at);
          const proven = previous
            ? companyChanges(
                JSON.parse(previous.company),
                JSON.parse(r.company),
              )
            : [];
          if (proven.length)
            saveCompanyUpdate(r.id, head.event_id, head.changed_at, proven);
        }
      }
      db.prepare(
        "UPDATE docs_customers SET received_at=?,source_updated_at=MAX(source_updated_at,?),search_text=? WHERE id=?",
      ).run(stamp, input.occurredAt, searchText(r), r.id);
      db.prepare("INSERT INTO docs_customer_receipts VALUES(?,?,?,?)").run(
        input.eventId,
        digest,
        r.id,
        stamp,
      );
      db.prepare(
        "UPDATE docs_customer_connection SET last_received_at=? WHERE id=1",
      ).run(stamp);
      return { customerId: r.id };
    });
    res.status(result.duplicate ? 200 : 201).json({
      ok: true,
      eventId: input.eventId,
      externalId: input.user.id,
      ...result,
    });
  }
  function heartbeat(req, res) {
    authorize(req);
    const b = req.body;
    if (
      !b ||
      typeof b.scanOk !== "boolean" ||
      !Number.isSafeInteger(b.pending) ||
      b.pending < 0 ||
      !Number.isSafeInteger(b.rejected) ||
      b.rejected < 0 ||
      ![
        "",
        "users_read_failed",
        "companies_read_failed",
        "invalid_source_data",
        "delivery_delayed",
      ].includes(b.errorCode || "")
    )
      throw bad("Некорректный статус синхронизации.");
    db.prepare(
      "UPDATE docs_customer_connection SET last_heartbeat_at=?,pending=?,rejected=?,scan_ok=?,error_code=? WHERE id=1",
    ).run(
      new Date(now()).toISOString(),
      b.pending,
      b.rejected,
      Number(b.scanOk),
      b.errorCode || "",
    );
    res.json({ ok: true, source: "boykovdocs.ru" });
  }
  function list(req) {
    const q = customerText(req.query.q, 300).toLowerCase(),
      status = String(req.query.status || "all"),
      sort = String(req.query.sort || "newest"),
      page = Number(req.query.page || 1),
      view = String(req.query.view || "active");
    if (
      !["active", "trash"].includes(view) ||
      !["all", "uncalled", "called"].includes(status) ||
      !["newest", "oldest"].includes(sort) ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 100000
    )
      throw bad("Проверьте фильтры клиентов.");
    const where = [
        view === "trash" ? "deleted_at IS NOT NULL" : "deleted_at IS NULL",
      ],
      args = [];
    if (q) {
      where.push("search_text LIKE ? ESCAPE '\\'");
      args.push("%" + q.replace(/[\\%_]/g, "\\$&") + "%");
    }
    if (status === "uncalled") where.push("call_count=0");
    if (status === "called") where.push("call_count>0");
    if (req.query.company === "1") where.push("company IS NOT NULL");
    if (req.query.mine === "1") {
      if (!req.actor?.id)
        throw bad("Для личного фильтра войдите под своим аккаунтом.");
      where.push(
        "EXISTS(SELECT 1 FROM docs_customer_calls c WHERE c.customer_id=docs_customers.id AND c.actor_id=? AND c.voided_at IS NULL)",
      );
      args.push(req.actor.id);
    }
    const unread =
      "(u.event_id IS NOT NULL AND u.fields<>'[]' AND (v.event_id IS NULL OR v.event_id<>u.event_id))";
    const joined =
      " FROM docs_customers LEFT JOIN docs_customer_company_updates u ON u.customer_id=docs_customers.id LEFT JOIN docs_customer_company_reviews v ON v.customer_id=docs_customers.id AND v.actor_key=?";
    if (req.query.updated === "1") where.push(unread);
    const condition = where.length ? " WHERE " + where.join(" AND ") : "",
      total = db
        .prepare("SELECT count(*) amount" + joined + condition)
        .get(reviewActor(req), ...args).amount;
    const stats = db
      .prepare(
        "SELECT count(*) total,COALESCE(SUM(company IS NOT NULL),0) companies,COALESCE(SUM(call_count=0),0) uncalled,COALESCE(SUM(call_count>0),0) called FROM docs_customers WHERE deleted_at IS NULL",
      )
      .get();
    const pages = Math.max(1, Math.ceil(total / 25)),
      current = Math.min(page, pages);
    const rows = db
      .prepare(
        "SELECT docs_customers.*" +
          joined +
          condition +
          (sort === "oldest"
            ? " ORDER BY source_updated_at ASC,id"
            : " ORDER BY " +
              unread +
              " DESC,CASE WHEN " +
              unread +
              " THEN u.changed_at ELSE source_updated_at END DESC,id") +
          " LIMIT 25 OFFSET ?",
      )
      .all(reviewActor(req), ...args, (current - 1) * 25);
    return {
      companyUpdates: db
        .prepare(
          "SELECT count(*) pending,MAX(u.changed_at) lastChangedAt" +
            joined +
            " WHERE docs_customers.deleted_at IS NULL AND " +
            unread,
        )
        .get(reviewActor(req)),
      customers: rows.map((r) => present(r, req)),
      trashCount: db
        .prepare(
          "SELECT count(*) amount FROM docs_customers WHERE deleted_at IS NOT NULL",
        )
        .get().amount,
      total,
      page: current,
      pages,
      stats,
    };
  }
  function updateCallSummary(id) {
    const last = db
        .prepare(
          "SELECT id FROM docs_customer_calls WHERE customer_id=? AND voided_at IS NULL ORDER BY rowid DESC LIMIT 1",
        )
        .get(id),
      n = db
        .prepare(
          "SELECT count(*) amount FROM docs_customer_calls WHERE customer_id=? AND voided_at IS NULL",
        )
        .get(id).amount;
    db.prepare(
      "UPDATE docs_customers SET call_count=?,last_call_id=?,version=version+1 WHERE id=?",
    ).run(n, last?.id || null, id);
  }
  function mutateCall(req, action) {
    const id = req.params.id,
      b = req.body,
      a = actor(req);
    if (
      !b ||
      !/^[a-f0-9-]{36}$/.test(b.requestId || "") ||
      !Number.isSafeInteger(b.version) ||
      b.version < 1
    )
      throw bad("Обновите карточку клиента и повторите действие.");
    const note = action === "call" ? customerCallNote(b.note) : "",
      outcome = action === "call" ? b.outcome : null;
    if (action === "call" && !Object.hasOwn(DOCS_CALL_OUTCOMES, outcome || ""))
      throw bad("Выберите результат звонка.");
    const content = hash(
        JSON.stringify({
          action,
          id,
          callId: req.params.callId || null,
          version: b.version,
          note,
          outcome,
        }),
      ),
      actorKey = a.id || "shared";
    return transaction(db, () => {
      const repeated = db
        .prepare("SELECT * FROM docs_customer_actions WHERE request_id=?")
        .get(b.requestId);
      if (repeated) {
        if (
          repeated.customer_id !== id ||
          repeated.actor_key !== actorKey ||
          repeated.payload_hash !== content
        )
          throw bad("Идентификатор действия уже использован.", 409);
        return JSON.parse(repeated.result);
      }
      const r = get(id);
      if (r.deleted_at)
        throw bad(
          "Клиент находится в корзине. Сначала восстановите карточку.",
          409,
        );
      if (r.version !== b.version)
        throw bad(
          "Карточка обновилась. Данные обновлены; проверьте их и сохраните звонок ещё раз.",
          409,
        );
      const stamp = new Date(now()).toISOString();
      let callId = req.params.callId;
      if (action === "call") {
        callId = randomUUID();
        db.prepare(
          "INSERT INTO docs_customer_calls(id,customer_id,created_at,outcome,note,phone,actor_id,actor_name,actor_kind) VALUES(?,?,?,?,?,?,?,?,?)",
        ).run(callId, id, stamp, outcome, note, r.phone, a.id, a.name, a.kind);
      } else {
        const c = db
          .prepare(
            "SELECT * FROM docs_customer_calls WHERE id=? AND customer_id=?",
          )
          .get(callId, id);
        if (!c) throw bad("Звонок не найден.", 404);
        if (!callView(c, req).canVoid)
          throw bad("Отменить отметку может её автор или администратор.", 403);
        db.prepare(
          "UPDATE docs_customer_calls SET voided_at=?,voided_by_id=?,voided_by_name=?,voided_by_kind=? WHERE id=?",
        ).run(stamp, a.id, a.name, a.kind, callId);
      }
      updateCallSummary(id);
      const result = { ok: true, customerId: id, callId };
      db.prepare("INSERT INTO docs_customer_actions VALUES(?,?,?,?,?)").run(
        b.requestId,
        id,
        actorKey,
        content,
        JSON.stringify(result),
      );
      return result;
    });
  }
  function mutateTrash(req) {
    const id = req.params.id,
      b = req.body,
      a = actor(req);
    if (
      !b ||
      !/^[a-f0-9-]{36}$/.test(b.requestId || "") ||
      !["delete", "restore"].includes(b.action) ||
      !Number.isSafeInteger(b.version) ||
      b.version < 1
    )
      throw bad("Обновите карточку клиента и повторите действие.");
    const content = hash(
      JSON.stringify({
        operation: "trash",
        id,
        action: b.action,
        version: b.version,
      }),
    );
    const actorKey = a.id || "shared";
    return transaction(db, () => {
      const repeated = db
        .prepare("SELECT * FROM docs_customer_actions WHERE request_id=?")
        .get(b.requestId);
      if (repeated) {
        if (
          repeated.customer_id !== id ||
          repeated.actor_key !== actorKey ||
          repeated.payload_hash !== content
        )
          throw bad("Идентификатор действия уже использован.", 409);
        return JSON.parse(repeated.result);
      }
      const r = get(id);
      if (
        r.version !== b.version ||
        Boolean(r.deleted_at) !== (b.action === "restore")
      )
        throw bad(
          "Карточку уже изменили. Обновите данные, проверьте их и повторите действие.",
          409,
        );
      const stamp = new Date(now()).toISOString(),
        deleting = b.action === "delete";
      db.prepare(
        "UPDATE docs_customers SET deleted_at=?,deleted_by_id=?,deleted_by_name=?,deleted_by_kind=?,version=version+1 WHERE id=?",
      ).run(
        deleting ? stamp : null,
        deleting ? a.id : null,
        deleting ? a.name : null,
        deleting ? a.kind : null,
        id,
      );
      db.prepare(
        "INSERT INTO docs_customer_lifecycle VALUES(?,?,?,?,?,?,?)",
      ).run(randomUUID(), id, b.action, stamp, a.id, a.name, a.kind);
      const result = { ok: true, customerId: id, action: b.action };
      db.prepare("INSERT INTO docs_customer_actions VALUES(?,?,?,?,?)").run(
        b.requestId,
        id,
        actorKey,
        content,
        JSON.stringify(result),
      );
      return result;
    });
  }
  function reviewCompanyUpdate(req) {
    const eventId = customerText(req.body?.eventId, 160, true),
      id = req.params.id;
    return transaction(db, () => {
      const r = get(id),
        update = companyUpdate(id, req);
      if (r.deleted_at)
        throw bad(
          "Карточка находится в корзине. Сначала восстановите её.",
          409,
        );
      if (!update || update.eventId !== eventId)
        throw bad(
          "Компания снова обновилась. Проверьте новые данные и отметьте их просмотренными.",
          409,
        );
      const stamp = new Date(now()).toISOString();
      db.prepare(
        "INSERT INTO docs_customer_company_reviews VALUES(?,?,?,?) ON CONFLICT(customer_id,actor_key) DO UPDATE SET event_id=excluded.event_id,reviewed_at=excluded.reviewed_at WHERE docs_customer_company_reviews.event_id<>excluded.event_id",
      ).run(id, reviewActor(req), eventId, stamp);
      return { ok: true, eventId };
    });
  }
  const admin = (req) => {
    if (req.actor?.role !== "admin")
      throw bad("Настраивать подключение может администратор.", 403);
  };
  function register(app) {
    app.get(
      "/api/docs-customers",
      wrap((req, res) => res.json(list(req))),
    );
    app.get(
      "/api/docs-customers/connection",
      wrap((req, res) =>
        res.json({
          ...connection(),
          canConfigure: req.actor?.role === "admin",
        }),
      ),
    );
    app.post(
      "/api/docs-customers/connection/key",
      wrap((req, res) => {
        admin(req);
        const token = randomBytes(32).toString("hex");
        db.prepare(
          "UPDATE docs_customer_connection SET token_hash=?,token_issued_at=?,last_heartbeat_at=NULL WHERE id=1",
        ).run(hash(token), new Date(now()).toISOString());
        res.json({
          token,
          endpoint: "https://boykov-services.ru/hooks/docs-customers",
          since: connectionRow().import_since,
        });
      }),
    );
    app.get(
      "/api/docs-customers/:id",
      wrap((req, res) => res.json(detail(req.params.id, req))),
    );
    app.post(
      "/api/docs-customers/:id/company-update/seen",
      wrap((req, res) => res.json(reviewCompanyUpdate(req))),
    );
    app.post(
      "/api/docs-customers/:id/trash",
      wrap((req, res) => res.json(mutateTrash(req))),
    );
    app.post(
      "/api/docs-customers/:id/calls",
      wrap((req, res) => res.json(mutateCall(req, "call"))),
    );
    app.post(
      "/api/docs-customers/:id/calls/:callId/void",
      wrap((req, res) => res.json(mutateCall(req, "void"))),
    );
  }
  return {
    register,
    authorize,
    receive: wrap(receive),
    heartbeat: wrap(heartbeat),
    handshake: wrap((req, res) => {
      authorize(req);
      res.json({
        ok: true,
        source: "boykovdocs.ru",
        since: connectionRow().import_since,
        version: 1,
      });
    }),
    connection,
  };
}
