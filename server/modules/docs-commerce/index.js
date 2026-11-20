import { createHash } from "node:crypto";
import { customerDate, customerText } from "../../../shared/docs-customers.js";
import { normalizeDocsCommerce } from "../../../shared/docs-commerce.js";
import { salesRange } from "../../../shared/docs-sales.js";
const bad = (message, status = 400) =>
  Object.assign(new Error(message), { status });
const hash = (v) => createHash("sha256").update(v).digest("hex");
const wrap = (fn) => (req, res, next) =>
  Promise.resolve()
    .then(() => fn(req, res))
    .catch(next);
export function createDocsCommerceModule(
  db,
  { authorize, configured, now = Date.now },
) {
  db.exec(`CREATE TABLE IF NOT EXISTS docs_commerce_buyers(id TEXT PRIMARY KEY,external_id TEXT UNIQUE,name TEXT NOT NULL,email TEXT NOT NULL,phone TEXT NOT NULL,registered_at TEXT,observed_at TEXT NOT NULL,search_text TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS docs_commerce_operations(kind TEXT NOT NULL,id TEXT NOT NULL,buyer_id TEXT NOT NULL,title TEXT NOT NULL,title_key TEXT NOT NULL,amount_minor INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,status TEXT NOT NULL,refunded_at TEXT,generated_at TEXT,payload TEXT NOT NULL,PRIMARY KEY(kind,id));
  CREATE INDEX IF NOT EXISTS docs_commerce_date ON docs_commerce_operations(kind,created_at DESC);
  CREATE INDEX IF NOT EXISTS docs_commerce_buyer ON docs_commerce_operations(buyer_id,created_at DESC);
  CREATE INDEX IF NOT EXISTS docs_commerce_refund ON docs_commerce_operations(refunded_at);
  CREATE TABLE IF NOT EXISTS docs_commerce_receipts(event_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,received_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS docs_commerce_connection(id INTEGER PRIMARY KEY CHECK(id=1),last_heartbeat_at TEXT,last_received_at TEXT,source_generated_at TEXT,source_count INTEGER NOT NULL DEFAULT 0,pending INTEGER NOT NULL DEFAULT 0,rejected INTEGER NOT NULL DEFAULT 0,scan_ok INTEGER NOT NULL DEFAULT 0,error_code TEXT NOT NULL DEFAULT '');
  INSERT OR IGNORE INTO docs_commerce_connection(id) VALUES(1);`);
  function connection() {
    const r = db
        .prepare("SELECT * FROM docs_commerce_connection WHERE id=1")
        .get(),
      storedCount = db
        .prepare("SELECT count(*) n FROM docs_commerce_operations")
        .get().n,
      hasKey = configured(),
      age = r.last_heartbeat_at
        ? now() - Date.parse(r.last_heartbeat_at)
        : Infinity;
    return {
      configured: hasKey,
      lastHeartbeatAt: r.last_heartbeat_at,
      lastReceivedAt: r.last_received_at,
      sourceCount: r.source_count,
      storedCount,
      pending: r.pending,
      rejected: r.rejected,
      errorCode: r.error_code,
      status: !hasKey
        ? "unconfigured"
        : !r.last_heartbeat_at
          ? "waiting"
          : age > 180000
            ? "offline"
            : !r.scan_ok || r.rejected || r.error_code
              ? "attention"
              : r.pending
                ? "syncing"
                : storedCount !== r.source_count
                  ? "attention"
                  : "online",
    };
  }
  function receive(req, res) {
    authorize(req);
    const e = normalizeDocsCommerce(req.body, now()),
      digest = hash(JSON.stringify(e)),
      o = e.operation,
      key = e.user?.id || "guest:" + o.id,
      stamp = new Date(now()).toISOString();
    let duplicate = false;
    db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = db
        .prepare(
          "SELECT payload_hash FROM docs_commerce_receipts WHERE event_id=?",
        )
        .get(e.eventId);
      if (receipt) {
        if (receipt.payload_hash !== digest)
          throw bad(
            "Идентификатор операции уже использован с другими данными.",
            409,
          );
        duplicate = true;
      } else {
        const old = db
          .prepare(
            "SELECT * FROM docs_commerce_operations WHERE kind=? AND id=?",
          )
          .get(o.kind, o.id);
        if (old) {
          const previous = JSON.parse(old.payload);
          if (
            previous.amountMinor !== o.amountMinor ||
            previous.createdAt !== o.createdAt ||
            previous.referenceId !== o.referenceId ||
            previous.parentId !== o.parentId ||
            (old.buyer_id !== key && !old.buyer_id.startsWith("guest:"))
          )
            throw bad(
              "Финансовые данные операции отличаются от источника.",
              409,
            );
          if (
            o.kind !== "generation" &&
            JSON.stringify(previous) !== JSON.stringify(o)
          )
            throw bad("Подтверждённый платёж нельзя изменить.", 409);
          if (
            o.updatedAt === old.updated_at &&
            JSON.stringify(previous) !== JSON.stringify(o)
          )
            throw bad("Версия заказа содержит другие данные.", 409);
          if (
            o.updatedAt > old.updated_at &&
            previous.refundedAt &&
            previous.refundedAt !== o.refundedAt
          )
            throw bad("Подтверждённый возврат нельзя изменить.", 409);
        }
        const b = db
            .prepare("SELECT * FROM docs_commerce_buyers WHERE id=?")
            .get(key),
          u = e.user || {
            name: "Гостевой заказ",
            email: o.contactEmail,
            phone: "",
            registeredAt: null,
          };
        if (!b || e.observedAt > b.observed_at)
          db.prepare(
            "INSERT INTO docs_commerce_buyers VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,phone=excluded.phone,registered_at=COALESCE(docs_commerce_buyers.registered_at,excluded.registered_at),observed_at=excluded.observed_at,search_text=excluded.search_text",
          ).run(
            key,
            e.user?.id || null,
            u.name,
            u.email,
            u.phone,
            u.registeredAt,
            e.observedAt,
            [
              e.user?.id || "",
              u.name,
              u.email,
              u.phone,
              u.phone.replace(/\D/g, ""),
            ]
              .join(" ")
              .toLowerCase(),
          );
        if (!old || o.updatedAt > old.updated_at)
          db.prepare(
            "INSERT INTO docs_commerce_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET buyer_id=excluded.buyer_id,title=excluded.title,title_key=excluded.title_key,updated_at=excluded.updated_at,status=excluded.status,refunded_at=excluded.refunded_at,generated_at=excluded.generated_at,payload=excluded.payload",
          ).run(
            o.kind,
            o.id,
            key,
            o.title,
            o.title.replace(/\s+/g, " ").toLocaleLowerCase("ru-RU"),
            o.amountMinor,
            o.createdAt,
            o.updatedAt,
            o.status,
            o.refundedAt,
            o.generatedAt,
            JSON.stringify(o),
          );
        if (o.kind !== "generation") {
          const parentId = o.kind === "topup" ? o.id : o.parentId;
          const parent = db
            .prepare(
              "SELECT * FROM docs_commerce_operations WHERE kind='topup' AND id=?",
            )
            .get(parentId);
          if (parent) {
            const refunds = db
              .prepare(
                "SELECT * FROM docs_commerce_operations WHERE kind='topup-refund' AND json_extract(payload,'$.parentId')=?",
              )
              .all(parentId);
            const referenceId = JSON.parse(parent.payload).referenceId;
            if (
              refunds.some(
                (r) =>
                  r.buyer_id !== parent.buyer_id ||
                  JSON.parse(r.payload).referenceId !== referenceId,
              ) ||
              refunds.reduce((sum, r) => sum + r.amount_minor, 0) >
                parent.amount_minor
            )
              throw bad("Возврат не соответствует пополнению.", 409);
          }
        }
        db.prepare("INSERT INTO docs_commerce_receipts VALUES(?,?,?)").run(
          e.eventId,
          digest,
          stamp,
        );
        db.prepare(
          "UPDATE docs_commerce_connection SET last_received_at=? WHERE id=1",
        ).run(stamp);
        duplicate = !!old;
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
    res.status(duplicate ? 200 : 201).json({
      ok: true,
      eventId: e.eventId,
      externalId: e.user?.id || null,
      recordId: o.kind + ":" + o.id,
      duplicate,
    });
  }
  function heartbeat(req, res) {
    authorize(req);
    const b = req.body;
    if (
      !b ||
      typeof b.scanOk !== "boolean" ||
      !["sourceCount", "pending", "rejected"].every(
        (k) => Number.isSafeInteger(b[k]) && b[k] >= 0,
      ) ||
      ![
        "",
        "wallet_read_failed",
        "users_read_failed",
        "orders_read_failed",
        "invalid_source_data",
        "delivery_delayed",
        "source_count_decreased",
      ].includes(b.errorCode || "")
    )
      throw bad("Некорректный статус синхронизации операций.");
    db.prepare(
      "UPDATE docs_commerce_connection SET last_heartbeat_at=?,source_generated_at=?,source_count=?,pending=?,rejected=?,scan_ok=?,error_code=? WHERE id=1",
    ).run(
      new Date(now()).toISOString(),
      customerDate(b.sourceGeneratedAt, { now: now() }),
      b.sourceCount,
      b.pending,
      b.rejected,
      Number(b.scanOk),
      b.errorCode || "",
    );
    res.json({ ok: true, source: "boykovdocs-commerce" });
  }
  function filters(req) {
    const kind = String(req.query.kind || "generations");
    if (!["generations", "topups"].includes(kind))
      throw bad("Выберите раздел операций.");
    const range = salesRange(String(req.query.period || "total"), now());
    const conditions = ["a.occurred_at<=?"],
      args = [range.end];
    if (range.start) {
      conditions.push("a.occurred_at>=?");
      args.push(range.start);
    }
    return { kind, range, conditions, args };
  }
  function activity(kind) {
    const fields =
      "o.id,o.buyer_id,o.title,o.title_key,o.amount_minor,o.status,o.generated_at";
    return (
      "WITH activity AS (" +
      (kind === "generations"
        ? `SELECT ${fields},o.created_at occurred_at,0 refund FROM docs_commerce_operations o WHERE o.kind='generation' UNION ALL SELECT ${fields},o.refunded_at occurred_at,1 refund FROM docs_commerce_operations o WHERE o.kind='generation' AND o.refunded_at IS NOT NULL`
        : `SELECT ${fields},o.created_at occurred_at,(o.kind='topup-refund') refund FROM docs_commerce_operations o WHERE o.kind IN ('topup','topup-refund')`) +
      ") "
    );
  }
  const where = (f) => " WHERE " + f.conditions.join(" AND ");
  function totals(f) {
    return db
      .prepare(
        activity(f.kind) +
          `SELECT COALESCE(SUM(NOT a.refund),0) count,COALESCE(SUM(CASE WHEN NOT a.refund THEN a.amount_minor ELSE 0 END),0) amountMinor,COALESCE(SUM(a.refund),0) refundedCount,COALESCE(SUM(CASE WHEN a.refund THEN a.amount_minor ELSE 0 END),0) refundedAmountMinor,count(DISTINCT CASE WHEN NOT a.refund THEN b.external_id END) buyers,COALESCE(SUM(NOT a.refund AND b.external_id IS NULL),0) guestOrders,COALESCE(SUM(NOT a.refund AND a.generated_at IS NOT NULL),0) generatedCount FROM activity a JOIN docs_commerce_buyers b ON b.id=a.buyer_id` +
          where(f),
      )
      .get(...f.args);
  }
  function pagination(req, total) {
    const page = Number(req.query.page || 1),
      pages = Math.max(1, Math.ceil(total / 25));
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000)
      throw bad("Проверьте номер страницы.");
    return { total, page: Math.min(page, pages), pages };
  }
  const join =
    " FROM activity a JOIN docs_commerce_buyers b ON b.id=a.buyer_id LEFT JOIN docs_customers c ON c.external_id=b.external_id";
  function person(r) {
    return {
      id: r.id,
      externalId: r.external_id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      registeredAt: r.registered_at,
      customerId: r.customer_deleted ? null : r.customer_id || null,
      customerInTrash: !!r.customer_deleted,
    };
  }
  function report(req) {
    const f = filters(req),
      summary = totals(f),
      q = customerText(req.query.q, 300).toLowerCase(),
      sort = String(req.query.sort || "recent");
    if (!["recent", "count", "amount"].includes(sort))
      throw bad("Проверьте сортировку.");
    if (q) {
      f.conditions.push("b.search_text LIKE ? ESCAPE '\\'");
      f.args.push("%" + q.replace(/[\\%_]/g, "\\$&") + "%");
    }
    const total = db
        .prepare(
          activity(f.kind) + "SELECT count(DISTINCT b.id) n" + join + where(f),
        )
        .get(...f.args).n,
      page = pagination(req, total);
    const rows = db
      .prepare(
        activity(f.kind) +
          `SELECT b.*,c.id customer_id,c.deleted_at customer_deleted,SUM(NOT a.refund) operationCount,SUM(CASE WHEN NOT a.refund THEN a.amount_minor ELSE 0 END) amountMinor,SUM(CASE WHEN a.refund THEN a.amount_minor ELSE 0 END) refundedAmountMinor,MAX(a.occurred_at) lastAt` +
          join +
          where(f) +
          " GROUP BY b.id ORDER BY " +
          {
            recent: "lastAt DESC",
            count: "operationCount DESC,amountMinor DESC,lastAt DESC",
            amount: "amountMinor DESC,operationCount DESC,lastAt DESC",
          }[sort] +
          ",b.id LIMIT 25 OFFSET ?",
      )
      .all(...f.args, (page.page - 1) * 25);
    return {
      kind: f.kind,
      range: f.range,
      summary,
      connection: connection(),
      buyers: rows.map((r) => ({
        ...person(r),
        operationCount: r.operationCount,
        amountMinor: r.amountMinor,
        refundedAmountMinor: r.refundedAmountMinor,
        lastAt: r.lastAt,
      })),
      ...page,
    };
  }
  function buyer(req) {
    const id = customerText(req.params.id, 200, true),
      r = db
        .prepare(
          "SELECT b.*,c.id customer_id,c.deleted_at customer_deleted FROM docs_commerce_buyers b LEFT JOIN docs_customers c ON c.external_id=b.external_id WHERE b.id=?",
        )
        .get(id);
    if (!r) throw bad("Пользователь не найден.", 404);
    const f = filters(req);
    f.conditions.push("a.buyer_id=?");
    f.args.push(id);
    const summary = totals(f),
      total = db
        .prepare(
          activity(f.kind) + "SELECT count(*) n FROM activity a" + where(f),
        )
        .get(...f.args).n,
      page = pagination(req, total);
    const operations = db
      .prepare(
        activity(f.kind) +
          "SELECT a.id,a.title,a.amount_minor amountMinor,a.occurred_at occurredAt,a.refund,a.status,a.generated_at generatedAt FROM activity a" +
          where(f) +
          " ORDER BY a.occurred_at DESC,a.refund DESC,a.id LIMIT 25 OFFSET ?",
      )
      .all(...f.args, (page.page - 1) * 25)
      .map((o) => ({ ...o, refund: !!o.refund }));
    const groupPageNumber = Number(req.query.groupsPage || 1);
    if (
      !Number.isSafeInteger(groupPageNumber) ||
      groupPageNumber < 1 ||
      groupPageNumber > 100000
    )
      throw bad("Проверьте номер страницы документов.");
    const gf = { ...f, conditions: [...f.conditions, "NOT a.refund"] };
    const groupCount = db
        .prepare(
          activity(f.kind) +
            "SELECT count(DISTINCT a.title_key) n FROM activity a" +
            where(gf),
        )
        .get(...gf.args).n,
      groupPages = Math.max(1, Math.ceil(groupCount / 25)),
      groupsPage = Math.min(groupPageNumber, groupPages);
    const documents =
      f.kind === "generations"
        ? db
            .prepare(
              activity(f.kind) +
                "SELECT MIN(a.title) title,count(*) count,SUM(a.amount_minor) amountMinor FROM activity a" +
                where(gf) +
                " GROUP BY a.title_key ORDER BY count DESC,title LIMIT 25 OFFSET ?",
            )
            .all(...gf.args, (groupsPage - 1) * 25)
        : [];
    return {
      buyer: person(r),
      kind: f.kind,
      range: f.range,
      summary,
      operations,
      documents,
      groupsPage,
      groupPages,
      groupCount,
      ...page,
    };
  }
  return {
    connection,
    receive: wrap(receive),
    heartbeat: wrap(heartbeat),
    handshake: wrap((req, res) => {
      authorize(req);
      res.json({
        ok: true,
        source: "boykovdocs-commerce",
        protocol: 1,
        scope: "generations-and-topups",
      });
    }),
    register(app) {
      app.get(
        "/api/docs-commerce/report",
        wrap((req, res) => res.json(report(req))),
      );
      app.get(
        "/api/docs-commerce/buyers/:id",
        wrap((req, res) => res.json(buyer(req))),
      );
    },
  };
}
