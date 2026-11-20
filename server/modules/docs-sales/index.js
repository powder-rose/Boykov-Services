import { createHash } from "node:crypto";
import { customerDate, customerText } from "../../../shared/docs-customers.js";
import {
  normalizeDocsSale,
  salesRange,
  moscowDay,
} from "../../../shared/docs-sales.js";
const bad = (message, status = 400) =>
  Object.assign(new Error(message), { status });
const hash = (v) => createHash("sha256").update(v).digest("hex");
const wrap = (fn) => (req, res, next) =>
  Promise.resolve()
    .then(() => fn(req, res))
    .catch(next);
const transaction = (db, fn) => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
};
export function createDocsSalesModule(
  db,
  { authorize, configured, now = Date.now },
) {
  db.exec(`CREATE TABLE IF NOT EXISTS docs_sales_purchases(id TEXT PRIMARY KEY,buyer_id TEXT NOT NULL,instruction_id TEXT NOT NULL,title TEXT NOT NULL,format TEXT NOT NULL,amount_minor INTEGER NOT NULL,created_at TEXT NOT NULL,received_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS docs_sales_purchases_date ON docs_sales_purchases(created_at DESC,id);
 CREATE UNIQUE INDEX IF NOT EXISTS docs_sales_purchases_access ON docs_sales_purchases(buyer_id,instruction_id,format);
 CREATE INDEX IF NOT EXISTS docs_sales_purchases_buyer ON docs_sales_purchases(buyer_id,created_at DESC);
 CREATE TABLE IF NOT EXISTS docs_sales_buyers(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,phone TEXT NOT NULL,registered_at TEXT,observed_at TEXT NOT NULL,search_text TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS docs_sales_receipts(event_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,purchase_id TEXT NOT NULL,received_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS docs_sales_connection(id INTEGER PRIMARY KEY CHECK(id=1),last_heartbeat_at TEXT,last_received_at TEXT,source_generated_at TEXT,source_count INTEGER NOT NULL DEFAULT 0,pending INTEGER NOT NULL DEFAULT 0,rejected INTEGER NOT NULL DEFAULT 0,scan_ok INTEGER NOT NULL DEFAULT 0,error_code TEXT NOT NULL DEFAULT '');
 INSERT OR IGNORE INTO docs_sales_connection(id) VALUES(1);`);
  const storedCount = () =>
    db.prepare("SELECT count(*) n FROM docs_sales_purchases").get().n;
  function connection() {
    const row = db
        .prepare("SELECT * FROM docs_sales_connection WHERE id=1")
        .get(),
      count = storedCount(),
      hasKey = configured(),
      age = row.last_heartbeat_at
        ? now() - Date.parse(row.last_heartbeat_at)
        : Infinity;
    return {
      configured: hasKey,
      lastHeartbeatAt: row.last_heartbeat_at,
      lastReceivedAt: row.last_received_at,
      sourceGeneratedAt: row.source_generated_at,
      sourceCount: row.source_count,
      storedCount: count,
      pending: row.pending,
      rejected: row.rejected,
      scanOk: !!row.scan_ok,
      errorCode: row.error_code,
      status: !hasKey
        ? "unconfigured"
        : !row.last_heartbeat_at
          ? "waiting"
          : age > 180000
            ? "offline"
            : !row.scan_ok || row.rejected || row.error_code
              ? "attention"
              : row.pending
                ? "syncing"
                : row.source_count !== count
                  ? "attention"
                  : "online",
    };
  }
  function receive(req, res) {
    authorize(req);
    const e = normalizeDocsSale(req.body, now()),
      digest = hash(JSON.stringify(e));
    const result = transaction(db, () => {
      const receipt = db
        .prepare("SELECT * FROM docs_sales_receipts WHERE event_id=?")
        .get(e.eventId);
      if (receipt) {
        if (receipt.payload_hash !== digest)
          throw bad(
            "Идентификатор покупки уже использован с другими данными.",
            409,
          );
        return { duplicate: true };
      }
      const p = e.purchase,
        old = db
          .prepare("SELECT * FROM docs_sales_purchases WHERE id=?")
          .get(p.id),
        stamp = new Date(now()).toISOString();
      if (
        old &&
        (old.buyer_id !== e.user.id ||
          old.instruction_id !== p.instructionId ||
          old.title !== p.title ||
          old.format !== p.format ||
          old.amount_minor !== p.amountMinor ||
          old.created_at !== p.createdAt)
      )
        throw bad("Сохранённая покупка отличается от данных источника.", 409);
      const access = db
        .prepare(
          "SELECT id FROM docs_sales_purchases WHERE buyer_id=? AND instruction_id=? AND format=?",
        )
        .get(e.user.id, p.instructionId, p.format);
      if (access && access.id !== p.id)
        throw bad(
          "Для этого пользователя уже сохранена покупка такого формата инструкции.",
          409,
        );
      const buyer = db
          .prepare("SELECT * FROM docs_sales_buyers WHERE id=?")
          .get(e.user.id),
        u = e.user;
      if (!buyer || e.observedAt > buyer.observed_at)
        db.prepare(
          "INSERT INTO docs_sales_buyers VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,phone=excluded.phone,registered_at=COALESCE(docs_sales_buyers.registered_at,excluded.registered_at),observed_at=excluded.observed_at,search_text=excluded.search_text",
        ).run(
          u.id,
          u.name,
          u.email,
          u.phone,
          u.registeredAt,
          e.observedAt,
          [u.id, u.name, u.email, u.phone, u.phone.replace(/\D/g, "")]
            .join(" ")
            .toLowerCase(),
        );
      if (!old)
        db.prepare(
          "INSERT INTO docs_sales_purchases VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          p.id,
          u.id,
          p.instructionId,
          p.title,
          p.format,
          p.amountMinor,
          p.createdAt,
          stamp,
        );
      db.prepare("INSERT INTO docs_sales_receipts VALUES(?,?,?,?)").run(
        e.eventId,
        digest,
        p.id,
        stamp,
      );
      db.prepare(
        "UPDATE docs_sales_connection SET last_received_at=? WHERE id=1",
      ).run(stamp);
      return { duplicate: !!old };
    });
    res.status(result.duplicate ? 200 : 201).json({
      ok: true,
      eventId: e.eventId,
      externalId: e.user.id,
      saleId: e.purchase.id,
      duplicate: result.duplicate,
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
        "invalid_source_data",
        "delivery_delayed",
        "source_count_decreased",
      ].includes(b.errorCode || "")
    )
      throw bad("Некорректный статус доставки продаж.");
    const sourceAt = customerDate(b.sourceGeneratedAt, { now: now() });
    db.prepare(
      "UPDATE docs_sales_connection SET last_heartbeat_at=?,source_generated_at=?,source_count=?,pending=?,rejected=?,scan_ok=?,error_code=? WHERE id=1",
    ).run(
      new Date(now()).toISOString(),
      sourceAt,
      b.sourceCount,
      b.pending,
      b.rejected,
      Number(b.scanOk),
      b.errorCode || "",
    );
    res.json({ ok: true, source: "boykovdocs-sales" });
  }
  function filters(req) {
    const period = String(req.query.period || "total"),
      format = String(req.query.format || "all"),
      range = salesRange(period, now());
    if (!["all", "pdf", "docx"].includes(format))
      throw bad("Выберите формат инструкции.");
    const where = ["p.created_at<=?"],
      args = [range.end];
    if (range.start) {
      where.push("p.created_at>=?");
      args.push(range.start);
    }
    if (format !== "all") {
      where.push("p.format=?");
      args.push(format);
    }
    return { period, format, range, where, args };
  }
  const condition = (f) => " WHERE " + f.where.join(" AND ");
  function totals(f) {
    return db
      .prepare(
        "SELECT count(*) count,COALESCE(SUM(p.amount_minor),0) amountMinor,count(DISTINCT p.buyer_id) buyers,count(DISTINCT p.instruction_id) instructions,COALESCE(SUM(p.format='pdf'),0) pdf,COALESCE(SUM(p.format='docx'),0) docx,MIN(p.created_at) firstPurchaseAt,MAX(p.created_at) lastPurchaseAt FROM docs_sales_purchases p" +
          condition(f),
      )
      .get(...f.args);
  }
  function pagination(req, total) {
    const n = Number(req.query.page || 1);
    if (!Number.isSafeInteger(n) || n < 1 || n > 100000)
      throw bad("Проверьте номер страницы.");
    const pages = Math.max(1, Math.ceil(total / 25));
    return { page: Math.min(n, pages), pages, total };
  }
  function buyerView(row) {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      registeredAt: row.registered_at,
      customerId: row.customer_deleted ? null : row.customer_id || null,
      customerInTrash: !!row.customer_deleted,
    };
  }
  function chart(f, t) {
    const start = f.range.start || t.firstPurchaseAt;
    if (!start) return { unit: "day", items: [] };
    const first = moscowDay(Date.parse(start)),
      last = moscowDay(now()),
      monthly = (Date.parse(last) - Date.parse(first)) / 86400000 > 120;
    const unit = monthly ? "month" : "day",
      size = monthly ? 7 : 10;
    const rows = db
        .prepare(
          "SELECT substr(datetime(p.created_at,'+3 hours'),1," +
            size +
            ") key,count(*) count,SUM(p.amount_minor) amountMinor FROM docs_sales_purchases p" +
            condition(f) +
            " GROUP BY key ORDER BY key",
        )
        .all(...f.args),
      byKey = new Map(rows.map((r) => [r.key, r]));
    const items = [];
    let cursor = first.slice(0, size),
      limit = last.slice(0, size);
    while (cursor <= limit) {
      items.push(
        byKey.get(cursor) || { key: cursor, count: 0, amountMinor: 0 },
      );
      cursor = monthly
        ? new Date(
            Date.UTC(Number(cursor.slice(0, 4)), Number(cursor.slice(5, 7)), 1),
          )
            .toISOString()
            .slice(0, 7)
        : new Date(Date.parse(cursor + "T12:00:00Z") + 86400000)
            .toISOString()
            .slice(0, 10);
    }
    return { unit, items };
  }
  function report(req) {
    const f = filters(req),
      summary = totals(f),
      q = customerText(req.query.q, 300).toLowerCase(),
      sort = String(req.query.sort || "purchases");
    if (!["purchases", "amount", "recent"].includes(sort))
      throw bad("Проверьте сортировку покупателей.");
    const filtered = { where: [...f.where], args: [...f.args] };
    if (q) {
      filtered.where.push("b.search_text LIKE ? ESCAPE '\\'");
      filtered.args.push("%" + q.replace(/[\\%_]/g, "\\$&") + "%");
    }
    const join =
      " FROM docs_sales_purchases p JOIN docs_sales_buyers b ON b.id=p.buyer_id LEFT JOIN docs_customers c ON c.external_id=b.id";
    const total = db
        .prepare("SELECT count(DISTINCT b.id) n" + join + condition(filtered))
        .get(...filtered.args).n,
      page = pagination(req, total);
    const rows = db
      .prepare(
        "SELECT b.*,c.id customer_id,c.deleted_at customer_deleted,count(*) purchaseCount,count(DISTINCT p.instruction_id) uniqueInstructions,SUM(p.amount_minor) amountMinor,MAX(p.created_at) lastPurchaseAt,SUM(p.format='pdf') pdf,SUM(p.format='docx') docx" +
          join +
          condition(filtered) +
          " GROUP BY b.id ORDER BY " +
          {
            purchases:
              "purchaseCount DESC,amountMinor DESC,lastPurchaseAt DESC",
            amount: "amountMinor DESC,purchaseCount DESC,lastPurchaseAt DESC",
            recent: "lastPurchaseAt DESC,purchaseCount DESC",
          }[sort] +
          ",b.id LIMIT 25 OFFSET ?",
      )
      .all(...filtered.args, (page.page - 1) * 25);
    const topInstructions = db
      .prepare(
        "SELECT p.instruction_id id,p.title,count(*) count,SUM(p.amount_minor) amountMinor FROM docs_sales_purchases p" +
          condition(f) +
          " GROUP BY p.instruction_id ORDER BY count DESC,amountMinor DESC,p.instruction_id LIMIT 10",
      )
      .all(...f.args);
    return {
      range: f.range,
      format: f.format,
      summary,
      connection: connection(),
      chart: chart(f, summary),
      topInstructions,
      buyers: rows.map((r) => ({
        ...buyerView(r),
        purchaseCount: r.purchaseCount,
        uniqueInstructions: r.uniqueInstructions,
        amountMinor: r.amountMinor,
        lastPurchaseAt: r.lastPurchaseAt,
        pdf: r.pdf,
        docx: r.docx,
      })),
      ...page,
    };
  }
  function buyer(req) {
    const id = customerText(req.params.id, 160, true),
      row = db
        .prepare(
          "SELECT b.*,c.id customer_id,c.deleted_at customer_deleted FROM docs_sales_buyers b LEFT JOIN docs_customers c ON c.external_id=b.id WHERE b.id=?",
        )
        .get(id);
    if (!row) throw bad("Покупатель не найден.", 404);
    const f = filters(req);
    f.where.push("p.buyer_id=?");
    f.args.push(id);
    const summary = totals(f),
      page = pagination(req, summary.count);
    const purchases = db
      .prepare(
        "SELECT id,instruction_id instructionId,title,format,amount_minor amountMinor,created_at createdAt FROM docs_sales_purchases p" +
          condition(f) +
          " ORDER BY p.created_at DESC,p.id LIMIT 25 OFFSET ?",
      )
      .all(...f.args, (page.page - 1) * 25);
    const lifetime = totals({
      where: ["p.buyer_id=?", "p.created_at<=?"],
      args: [id, new Date(now()).toISOString()],
    });
    return {
      buyer: buyerView(row),
      range: f.range,
      format: f.format,
      summary,
      lifetime,
      purchases,
      ...page,
    };
  }
  function register(app) {
    app.get(
      "/api/docs-sales/report",
      wrap((req, res) => res.json(report(req))),
    );
    app.get(
      "/api/docs-sales/buyers/:id",
      wrap((req, res) => res.json(buyer(req))),
    );
  }
  return {
    register,
    connection,
    receive: wrap(receive),
    heartbeat: wrap(heartbeat),
    handshake: wrap((req, res) => {
      authorize(req);
      res.json({
        ok: true,
        source: "boykovdocs-sales",
        protocol: 1,
        scope: "all-purchases",
      });
    }),
  };
}
