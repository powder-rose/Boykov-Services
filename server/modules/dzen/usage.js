import { randomUUID } from "node:crypto";
import { fail } from "./model.js";

export const DZEN_MODEL = "yandexgpt/latest";
export const RUB_MICROS = 1_000_000;

function tokenCount(value) {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^\d+$/.test(value))
  )
    return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 && count <= 10_000_000
    ? count
    : null;
}

export function parseDzenUsage(data) {
  const result = data?.result ?? data;
  const usage = result?.usage;
  const input = tokenCount(usage?.inputTextTokens);
  const output = tokenCount(usage?.completionTokens);
  const total = tokenCount(usage?.totalTokens);
  const modelVersion =
    typeof result?.modelVersion === "string"
      ? result.modelVersion.slice(0, 100)
      : "";
  if (
    input === null ||
    output === null ||
    (total !== null && total !== input + output)
  )
    return { modelVersion, tokens: null };
  return { modelVersion, tokens: { input, output, total: input + output } };
}

const dayKey = (ms) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
const iso = (ms) =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();
const rub = (micros) => (micros === null ? null : micros / RUB_MICROS);
const rateMicros = (value) => Math.round(value * RUB_MICROS);

export function createDzenUsageStore(db, now = Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS dzen_ai_requests (
    id TEXT PRIMARY KEY, comment_id TEXT, kind TEXT NOT NULL, automatic INTEGER NOT NULL,
    prompt_version INTEGER, started_at INTEGER NOT NULL, day TEXT NOT NULL, completed_at INTEGER,
    outcome TEXT NOT NULL DEFAULT 'pending', model TEXT NOT NULL, model_version TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
    input_rate INTEGER NOT NULL, output_rate INTEGER NOT NULL, cost_micros INTEGER
  ); CREATE INDEX IF NOT EXISTS dzen_ai_requests_day ON dzen_ai_requests(day,started_at);
  CREATE INDEX IF NOT EXISTS dzen_ai_requests_comment ON dzen_ai_requests(comment_id,started_at);`);
  db.prepare(
    "UPDATE dzen_ai_requests SET outcome='interrupted',completed_at=? WHERE outcome='pending'",
  ).run(now());

  function start({
    commentId = null,
    kind,
    automatic = false,
    promptVersion = null,
    inputRub,
    outputRub,
  }) {
    const id = randomUUID();
    const started = now();
    db.prepare(
      "INSERT INTO dzen_ai_requests(id,comment_id,kind,automatic,prompt_version,started_at,day,model,input_rate,output_rate) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      commentId,
      kind,
      Number(automatic),
      promptVersion,
      started,
      dayKey(started),
      DZEN_MODEL,
      rateMicros(inputRub),
      rateMicros(outputRub),
    );
    return id;
  }
  function record(id, response) {
    const row = db
      .prepare(
        "SELECT input_rate,output_rate FROM dzen_ai_requests WHERE id=? AND outcome='pending' AND total_tokens IS NULL",
      )
      .get(id);
    if (!row || !response) return;
    const { tokens, modelVersion } = response;
    const input = tokenCount(tokens?.input),
      output = tokenCount(tokens?.output),
      total = tokenCount(tokens?.total);
    if (input === null || output === null || total !== input + output) {
      db.prepare("UPDATE dzen_ai_requests SET model_version=? WHERE id=?").run(
        modelVersion || "",
        id,
      );
      return;
    }
    const cost = Number(
      (BigInt(input) * BigInt(row.input_rate) +
        BigInt(output) * BigInt(row.output_rate) +
        500n) /
        1000n,
    );
    if (!Number.isSafeInteger(cost)) return;
    db.prepare(
      "UPDATE dzen_ai_requests SET input_tokens=?,output_tokens=?,total_tokens=?,cost_micros=?,model_version=? WHERE id=? AND outcome='pending' AND total_tokens IS NULL",
    ).run(input, output, total, cost, modelVersion || "", id);
  }
  function complete(id, outcome) {
    db.prepare(
      "UPDATE dzen_ai_requests SET outcome=?,completed_at=? WHERE id=? AND outcome='pending'",
    ).run(outcome, now(), id);
  }
  function comment(id) {
    const row = db
      .prepare(
        "SELECT count(*) requests,count(cost_micros) priced,coalesce(sum(cost_micros),0) cost,coalesce(sum(total_tokens),0) tokens FROM dzen_ai_requests WHERE comment_id=? OR comment_id IN (SELECT comment_id FROM dzen_comment_archives WHERE canonical_id=?)",
      )
      .get(id, id);
    return {
      requests: row.requests,
      priced: row.priced,
      costRub: rub(row.cost),
      tokens: row.tokens,
    };
  }
  function report(period = "30", page = 1) {
    if (!["today", "7", "30", "90", "all"].includes(period))
      throw fail("Некорректный период расходов.");
    const today = dayKey(now());
    const startDay =
      period === "all"
        ? null
        : period === "today"
          ? today
          : dayKey(now() - (Number(period) - 1) * 86400000);
    const where = startDay ? " WHERE day>=? AND day<=?" : "";
    const args = startDay ? [startDay, today] : [];
    const totals = db
      .prepare(
        `SELECT count(*) requests,count(cost_micros) priced,coalesce(sum(cost_micros),0) cost,coalesce(sum(input_tokens),0) input,coalesce(sum(output_tokens),0) output,coalesce(sum(total_tokens),0) tokens,count(DISTINCT CASE WHEN kind='reply' AND cost_micros IS NOT NULL THEN coalesce((SELECT canonical_id FROM dzen_comment_archives archive WHERE archive.comment_id=dzen_ai_requests.comment_id),comment_id) END) comments,coalesce(sum(CASE WHEN kind='reply' THEN cost_micros ELSE 0 END),0) reply_cost,coalesce(sum(CASE WHEN kind='preview' THEN cost_micros ELSE 0 END),0) preview_cost FROM dzen_ai_requests${where}`,
      )
      .get(...args);
    const daily = db
      .prepare(
        `SELECT day,count(*) requests,count(cost_micros) priced,coalesce(sum(cost_micros),0) cost,coalesce(sum(total_tokens),0) tokens FROM dzen_ai_requests${where} GROUP BY day ORDER BY day DESC LIMIT 90`,
      )
      .all(...args)
      .reverse()
      .map((row) => ({
        day: row.day,
        requests: row.requests,
        priced: row.priced,
        costRub: rub(row.cost),
        tokens: row.tokens,
      }));
    page = Math.max(
      1,
      Math.min(10000, Number.isInteger(Number(page)) ? Number(page) : 1),
    );
    const rows = db
      .prepare(
        `SELECT a.*,c.author,c.article,c.text FROM dzen_ai_requests a LEFT JOIN dzen_comments c ON c.id=a.comment_id${startDay ? " WHERE a.day>=? AND a.day<=?" : ""} ORDER BY a.started_at DESC,a.id DESC LIMIT 30 OFFSET ?`,
      )
      .all(...args, (page - 1) * 30)
      .map((row) => ({
        id: row.id,
        commentId: row.comment_id,
        author: row.author ?? "",
        article: row.article ?? "",
        text: row.text ?? "",
        kind: row.kind,
        automatic: !!row.automatic,
        startedAt: iso(row.started_at),
        outcome: row.outcome,
        model: row.model,
        modelVersion: row.model_version,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        totalTokens: row.total_tokens,
        inputRub: rub(row.input_rate),
        outputRub: rub(row.output_rate),
        costRub: rub(row.cost_micros),
      }));
    const first = db
      .prepare("SELECT min(started_at) first FROM dzen_ai_requests")
      .get().first;
    return {
      period,
      page,
      pageSize: 30,
      total: totals.requests,
      coverageFrom: iso(first),
      requests: totals.requests,
      priced: totals.priced,
      unknown: totals.requests - totals.priced,
      inputTokens: totals.input,
      outputTokens: totals.output,
      totalTokens: totals.tokens,
      costRub: rub(totals.cost),
      replyCostRub: rub(totals.reply_cost),
      previewCostRub: rub(totals.preview_cost),
      comments: totals.comments,
      averageRequestRub: totals.priced
        ? rub(totals.cost) / totals.priced
        : null,
      averageCommentRub: totals.comments
        ? rub(totals.reply_cost) / totals.comments
        : null,
      daily,
      rows,
    };
  }
  return { start, record, complete, comment, report };
}
