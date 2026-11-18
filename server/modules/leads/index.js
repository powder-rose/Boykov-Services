import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

const statuses = ["new", "working", "processed"];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const bad = (message, status = 400) =>
  Object.assign(new Error(message), { status });
function text(value, limit, required = false) {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.length > limit || value.includes("\0"))
    throw bad("Проверьте состав и длину полей заявки.");
  const result = value.trim();
  if (required && !result) throw bad("Заполните обязательные поля.");
  return result;
}
function date(value) {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw bad("Укажите дату заявки с часовым поясом.");
  return new Date(value).toISOString();
}
export function normalizeLead(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw bad("Не удалось прочитать заявку.");
  const eventId = text(input.eventId, 160, true);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(eventId))
    throw bad("Некорректный идентификатор заявки.");
  const phone = text(input.phone, 80),
    email = text(input.email, 254);
  const pageUrl = text(input.pageUrl, 2000);
  if (pageUrl) {
    let url;
    try {
      url = new URL(pageUrl);
    } catch {
      throw bad("Некорректный адрес страницы.");
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password)
      throw bad("Некорректный адрес страницы.");
  }
  const fields = input.fields ?? [];
  if (!Array.isArray(fields) || fields.length > 100)
    throw bad("Слишком много дополнительных полей.");
  return {
    eventId,
    createdAt: date(input.createdAt),
    name: text(input.name, 200),
    phone,
    email,
    service: text(input.service, 500),
    message: text(input.message, 12000),
    pageUrl,
    form: text(input.form, 300),
    fields: fields.map((field) => ({
      label: text(field?.label, 200, true),
      value: text(field?.value, 16000),
    })),
  };
}
function transaction(db, action) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function createLeadsModule(db, { now = Date.now } = {}) {
  // An acknowledgement is sent only after SQLite has committed the record.
  db.exec(`PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS sales_sites (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL UNIQUE,
      token_hash TEXT, token_issued_at TEXT, created_at TEXT NOT NULL, last_received_at TEXT,
      last_heartbeat_at TEXT, pending_count INTEGER NOT NULL DEFAULT 0,
      rejected_count INTEGER NOT NULL DEFAULT 0, oldest_pending_at TEXT,
      scan_ok INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS sales_leads (
      id TEXT PRIMARY KEY, site_id TEXT NOT NULL, event_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL, payload TEXT NOT NULL, search_text TEXT NOT NULL,
      created_at TEXT NOT NULL, received_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','working','processed')),
      note TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL, UNIQUE(site_id,event_id)
    );
    CREATE INDEX IF NOT EXISTS sales_leads_created ON sales_leads(created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS sales_leads_site_status ON sales_leads(site_id,status,created_at DESC);
    CREATE TABLE IF NOT EXISTS sales_history (
      id INTEGER PRIMARY KEY, lead_id TEXT NOT NULL, created_at TEXT NOT NULL,
      status TEXT NOT NULL, note TEXT NOT NULL, version INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sales_history_lead ON sales_history(lead_id,id);
    CREATE TABLE IF NOT EXISTS sales_actions (
      request_id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, payload_hash TEXT NOT NULL
    );`);
  if (
    !db
      .prepare("PRAGMA table_info(sales_sites)")
      .all()
      .some((column) => column.name === "token_issued_at")
  )
    db.exec("ALTER TABLE sales_sites ADD COLUMN token_issued_at TEXT");
  const iso = () => new Date(now()).toISOString();
  const seed = db.prepare(
    "INSERT OR IGNORE INTO sales_sites(id,name,host,created_at) VALUES(?,?,?,?)",
  );
  for (const site of [
    ["nwd", "NWD Electricity", "nwdelectricity.ru"],
    ["accessibility", "Паспорт доступности", "pasport-dostupnosty.ru"],
    ["security", "Паспорт безопасности", "pasport-bezopasnosty.ru"],
  ])
    seed.run(...site, iso());

  const wrap = (action) => (req, res, next) => {
    res.set("Cache-Control", "no-store");
    try {
      action(req, res);
    } catch (error) {
      if (error.status) res.status(error.status).json({ error: error.message });
      else next(error);
    }
  };
  function authorize(req) {
    const site = db
      .prepare("SELECT * FROM sales_sites WHERE id=?")
      .get(req.params.siteId);
    const token = /^Bearer ([a-f0-9]{64})$/.exec(
      req.get("authorization") || "",
    )?.[1];
    const actual = Buffer.from(digest(token || ""), "hex");
    const expected = Buffer.from(site?.token_hash || "0".repeat(64), "hex");
    if (!token || !site?.token_hash || !timingSafeEqual(actual, expected))
      throw bad("Нет доступа к приёму заявок.", 401);
    return site;
  }
  function present(row) {
    if (!row) throw bad("Заявка не найдена.", 404);
    return {
      ...JSON.parse(row.payload),
      id: row.id,
      siteId: row.site_id,
      status: row.status,
      note: row.note,
      version: row.version,
      receivedAt: row.received_at,
      updatedAt: row.updated_at,
    };
  }
  function get(id) {
    return present(db.prepare("SELECT * FROM sales_leads WHERE id=?").get(id));
  }
  const receive = wrap((req, res) => {
    const site = authorize(req),
      payload = normalizeLead(req.body),
      encoded = JSON.stringify(payload);
    const hash = digest(encoded),
      receivedAt = iso();
    const result = transaction(db, () => {
      const existing = db
        .prepare(
          "SELECT id,payload_hash FROM sales_leads WHERE site_id=? AND event_id=?",
        )
        .get(site.id, payload.eventId);
      if (existing) {
        if (existing.payload_hash !== hash)
          throw bad("Этот идентификатор уже сохранён с другими данными.", 409);
        return { id: existing.id, duplicate: true };
      }
      const id = randomUUID();
      const search = [
        payload.name,
        payload.phone,
        payload.email,
        payload.service,
        payload.message,
        ...payload.fields.flatMap((f) => [f.label, f.value]),
      ]
        .join(" ")
        .toLocaleLowerCase("ru");
      db.prepare(
        `INSERT INTO sales_leads(id,site_id,event_id,payload_hash,payload,search_text,created_at,received_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        site.id,
        payload.eventId,
        hash,
        encoded,
        search,
        payload.createdAt,
        receivedAt,
        receivedAt,
      );
      db.prepare(
        "INSERT INTO sales_history(lead_id,created_at,status,note,version) VALUES(?,?,'new','',1)",
      ).run(id, receivedAt);
      db.prepare("UPDATE sales_sites SET last_received_at=? WHERE id=?").run(
        receivedAt,
        site.id,
      );
      return { id, duplicate: false };
    });
    res
      .status(result.duplicate ? 200 : 201)
      .json({ ok: true, siteId: site.id, eventId: payload.eventId, ...result });
  });
  const heartbeat = wrap((req, res) => {
    const site = authorize(req),
      input = req.body;
    if (
      !input ||
      !Number.isSafeInteger(input.pending) ||
      input.pending < 0 ||
      !Number.isSafeInteger(input.rejected) ||
      input.rejected < 0 ||
      typeof input.scanOk !== "boolean"
    )
      throw bad("Некорректный отчёт доставки.");
    const oldest = input.oldestPendingAt ? date(input.oldestPendingAt) : null;
    db.prepare(
      "UPDATE sales_sites SET last_heartbeat_at=?,pending_count=?,rejected_count=?,oldest_pending_at=?,scan_ok=? WHERE id=?",
    ).run(
      iso(),
      input.pending,
      input.rejected,
      oldest,
      Number(input.scanOk),
      site.id,
    );
    res.json({ ok: true, siteId: site.id });
  });
  function sites() {
    const counts = db
      .prepare(
        "SELECT site_id,status,count(*) AS count FROM sales_leads GROUP BY site_id,status",
      )
      .all();
    return db
      .prepare("SELECT * FROM sales_sites ORDER BY name COLLATE NOCASE,host")
      .all()
      .map((row) => {
        const stats = { new: 0, working: 0, processed: 0 };
        for (const count of counts.filter((c) => c.site_id === row.id))
          stats[count.status] = count.count;
        let connection = "unconfigured";
        if (row.token_hash) {
          connection = !row.last_heartbeat_at
            ? now() - Date.parse(row.token_issued_at || row.created_at) > 120000
              ? "offline"
              : "waiting"
            : now() - Date.parse(row.last_heartbeat_at) > 120000
              ? "offline"
              : !row.scan_ok ||
                  row.rejected_count ||
                  (row.oldest_pending_at &&
                    now() - Date.parse(row.oldest_pending_at) > 300000)
                ? "attention"
                : "online";
        }
        return {
          id: row.id,
          name: row.name,
          host: row.host,
          configured: Boolean(row.token_hash),
          connection,
          stats,
          lastReceivedAt: row.last_received_at,
          lastHeartbeatAt: row.last_heartbeat_at,
          pending: row.pending_count,
          rejected: row.rejected_count,
          scanOk: Boolean(row.scan_ok),
        };
      });
  }
  function issueToken(siteId) {
    const token = randomBytes(32).toString("hex");
    if (
      !db
        .prepare(
          "UPDATE sales_sites SET token_hash=?,token_issued_at=?,last_heartbeat_at=NULL WHERE id=?",
        )
        .run(digest(token), iso(), siteId).changes
    )
      throw bad("Сайт не найден.", 404);
    return { token, endpoint: `/hooks/leads/${siteId}`, siteId };
  }
  function register(app) {
    app.get(
      "/api/leads/sites",
      wrap((req, res) => res.json({ sites: sites() })),
    );
    app.post(
      "/api/leads/sites",
      wrap((req, res) => {
        const name = text(req.body?.name, 120, true),
          input = text(req.body?.host, 253, true);
        const host = input.toLowerCase().replace(/^www\./, "");
        if (
          !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
        )
          throw bad("Введите домен без протокола и пути.");
        if (db.prepare("SELECT id FROM sales_sites WHERE host=?").get(host))
          throw bad("Этот сайт уже добавлен.", 409);
        const result = transaction(db, () => {
          const id = randomUUID();
          db.prepare(
            "INSERT INTO sales_sites(id,name,host,created_at) VALUES(?,?,?,?)",
          ).run(id, name, host, iso());
          return issueToken(id);
        });
        res.status(201).json(result);
      }),
    );
    app.post(
      "/api/leads/sites/:siteId/token",
      wrap((req, res) => res.json(issueToken(req.params.siteId))),
    );
    app.get(
      "/api/leads",
      wrap((req, res) => {
        const site = text(req.query.site, 64),
          status = text(req.query.status, 20),
          q = text(req.query.q, 200).toLocaleLowerCase("ru");
        const order = req.query.order ?? "newest",
          page = req.query.page ?? "1";
        if (
          !["newest", "oldest", "status"].includes(order) ||
          !/^[1-9]\d{0,5}$/.test(page) ||
          (status && !statuses.includes(status))
        )
          throw bad("Некорректный фильтр заявок.");
        const where = [],
          args = [];
        if (site) {
          where.push("site_id=?");
          args.push(site);
        }
        if (status) {
          where.push("status=?");
          args.push(status);
        }
        if (q) {
          where.push("search_text LIKE ? ESCAPE '\\'");
          args.push("%" + q.replace(/[\\%_]/g, "\\$&") + "%");
        }
        const filter = where.length ? "WHERE " + where.join(" AND ") : "";
        const sorting =
          order === "oldest"
            ? "created_at ASC,id ASC"
            : order === "status"
              ? "CASE status WHEN 'new' THEN 0 WHEN 'working' THEN 1 ELSE 2 END,created_at DESC,id DESC"
              : "created_at DESC,id DESC";
        const total = db
          .prepare(`SELECT count(*) AS count FROM sales_leads ${filter}`)
          .get(...args).count;
        const leads = db
          .prepare(
            `SELECT * FROM sales_leads ${filter} ORDER BY ${sorting} LIMIT 50 OFFSET ?`,
          )
          .all(...args, (Number(page) - 1) * 50)
          .map(present);
        res.json({
          leads,
          total,
          page: Number(page),
          pages: Math.max(1, Math.ceil(total / 50)),
        });
      }),
    );
    app.get(
      "/api/leads/:id",
      wrap((req, res) =>
        res.json({
          lead: get(req.params.id),
          history: db
            .prepare(
              "SELECT created_at AS createdAt,status,note,version FROM sales_history WHERE lead_id=? ORDER BY id DESC",
            )
            .all(req.params.id),
        }),
      ),
    );
    app.patch(
      "/api/leads/:id",
      wrap((req, res) => {
        const { requestId, version, status } = req.body ?? {},
          note = text(req.body?.note, 12000);
        if (
          !/^[a-f0-9-]{36}$/.test(requestId || "") ||
          !Number.isSafeInteger(version) ||
          version < 1 ||
          !statuses.includes(status)
        )
          throw bad("Некорректное изменение заявки.");
        const hash = digest(
          JSON.stringify({ id: req.params.id, version, status, note }),
        );
        transaction(db, () => {
          const previous = db
            .prepare("SELECT * FROM sales_actions WHERE request_id=?")
            .get(requestId);
          if (previous) {
            if (
              previous.lead_id !== req.params.id ||
              previous.payload_hash !== hash
            )
              throw bad("Идентификатор изменения уже использован.", 409);
            return;
          }
          get(req.params.id);
          const updatedAt = iso();
          if (
            !db
              .prepare(
                "UPDATE sales_leads SET status=?,note=?,version=version+1,updated_at=? WHERE id=? AND version=?",
              )
              .run(status, note, updatedAt, req.params.id, version).changes
          )
            throw bad(
              "Заявку уже изменил другой сотрудник. Обновите карточку и проверьте изменения.",
              409,
            );
          db.prepare(
            "INSERT INTO sales_history(lead_id,created_at,status,note,version) VALUES(?,?,?,?,?)",
          ).run(req.params.id, updatedAt, status, note, version + 1);
          db.prepare("INSERT INTO sales_actions VALUES(?,?,?)").run(
            requestId,
            req.params.id,
            hash,
          );
        });
        res.json({ lead: get(req.params.id) });
      }),
    );
  }
  return { receive, heartbeat, register };
}
