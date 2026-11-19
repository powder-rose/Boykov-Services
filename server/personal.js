import { validId } from "./modules/wordstat/batches.js";
const bad = (message, status = 400) =>
  Object.assign(new Error(message), { status });
export function createPersonalModule(db, { worker, now = Date.now }) {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_document_owners (
    job_id TEXT PRIMARY KEY, account_id TEXT, actor_name TEXT,
    actor_kind TEXT NOT NULL CHECK(actor_kind IN ('account','shared','legacy')),
    created_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS workspace_document_account ON workspace_document_owners(account_id,actor_kind);`);
  const owner = (id) =>
    db
      .prepare("SELECT * FROM workspace_document_owners WHERE job_id=?")
      .get(id);
  const same = (row, actor) =>
    row.actor_kind === "legacy" ||
    (actor?.id
      ? row.actor_kind === "account" && row.account_id === actor.id
      : row.actor_kind === "shared");
  async function reserve(req) {
    const raw = req.body?.requestId;
    if (typeof raw !== "string" || !validId(raw))
      throw bad("Некорректный номер задачи документа.");
    const id = raw.toLowerCase(),
      previous = owner(id);
    if (previous) {
      if (!same(previous, req.actor))
        throw bad(
          "Эта задача создана другим аккаунтом. Создайте новый документ.",
          409,
        );
      return;
    }
    let legacy = false;
    try {
      const existing = await (await worker("/jobs/" + id)).json();
      if (existing?.id !== id)
        throw bad(
          "Не удалось проверить историю документа. Повторите запрос.",
          503,
        );
      legacy = true;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      if (req.actor?.id) {
        const active = db
          .prepare(
            "SELECT enabled,auth_version FROM workspace_accounts WHERE id=?",
          )
          .get(req.actor.id);
        if (!active?.enabled || active.auth_version !== req.accountAuthVersion)
          throw bad("Доступ аккаунта изменился. Войдите заново.", 403);
      }
      db.prepare(
        "INSERT OR IGNORE INTO workspace_document_owners(job_id,account_id,actor_name,actor_kind,created_at) VALUES(?,?,?,?,?)",
      ).run(
        id,
        legacy ? null : req.actor?.id || null,
        legacy ? null : req.actor?.name || "Общий доступ",
        legacy ? "legacy" : req.actor?.id ? "account" : "shared",
        new Date(now()).toISOString(),
      );
      if (!same(owner(id), req.actor))
        throw bad(
          "Эта задача создана другим аккаунтом. Создайте новый документ.",
          409,
        );
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
  function annotate(job) {
    const row = owner(job.id);
    return {
      ...job,
      createdBy:
        row && row.actor_kind !== "legacy"
          ? { id: row.account_id, name: row.actor_name, kind: row.actor_kind }
          : null,
    };
  }
  function register(app) {
    app.get("/api/me/documents", async (req, res) => {
      const page = req.query.page ?? "1";
      if (typeof page !== "string" || !/^[1-9]\d{0,5}$/.test(page))
        throw bad("Некорректная страница документов.");
      const rows = req.actor?.id
        ? db
            .prepare(
              "SELECT job_id FROM workspace_document_owners WHERE actor_kind='account' AND account_id=?",
            )
            .all(req.actor.id)
        : db
            .prepare(
              "SELECT job_id FROM workspace_document_owners WHERE actor_kind='shared'",
            )
            .all();
      const ids = new Set(rows.map((row) => row.job_id));
      try {
        const data = await (await worker("/jobs")).json();
        if (!Array.isArray(data.jobs))
          throw bad("История документов недоступна.", 503);
        const jobs = data.jobs
          .filter((job) => job.kind === "generate" && ids.has(job.id))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(annotate);
        res.json({
          available: true,
          documents: jobs.slice((Number(page) - 1) * 30, Number(page) * 30),
          total: jobs.length,
          completed: jobs.filter((job) => job.status === "completed").length,
          page: Number(page),
          pages: Math.max(1, Math.ceil(jobs.length / 30)),
        });
      } catch {
        res.json({
          available: false,
          documents: [],
          total: null,
          completed: null,
          page: 1,
          pages: 1,
          error:
            "История документов временно недоступна. Заявки продолжают работать.",
        });
      }
    });
  }
  return { reserve, annotate, register };
}
