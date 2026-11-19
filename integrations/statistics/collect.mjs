import { DatabaseSync } from "node:sqlite";
import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { NativeReportBuilder, cleanPath } from "../../shared/statistics.js";
import { isBotVisit } from "./security-bots.mjs";
export function collectAccessibility({ sourceFile, now = Date.now() }) {
  const db = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=10000; BEGIN");
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((t) => t.name),
    );
    if (
      !["analytics_visits", "analytics_pageviews", "leads"].every((t) =>
        tables.has(t),
      )
    )
      throw Error("NATIVE_ANALYTICS_TABLES_NOT_FOUND");
    const titles = new Map();
    if (tables.has("articles")) {
      for (const row of db
        .prepare("SELECT slug,payload FROM articles")
        .iterate()) {
        const payload = JSON.parse(row.payload);
        titles.set(
          "/blog/" + row.slug + "/",
          typeof payload.title === "string" && payload.title.trim()
            ? payload.title.trim()
            : row.slug,
        );
      }
      if (tables.has("article_slugs"))
        for (const row of db
          .prepare(
            "SELECT s.slug,a.payload FROM article_slugs s JOIN articles a ON a.id=s.article_id",
          )
          .iterate()) {
          const payload = JSON.parse(row.payload);
          titles.set("/blog/" + row.slug + "/", payload.title || row.slug);
        }
    }
    const builder = new NativeReportBuilder({
      host: "pasport-dostupnosty.ru",
      kind: "accessibility",
      now,
      articles: tables.has("articles"),
    });
    const first = builder.frames.at(-1).range.start,
      end = builder.frames[0].range.end;
    for (const row of db
      .prepare(
        "SELECT started_at,source FROM analytics_visits WHERE started_at>=? AND started_at<?",
      )
      .iterate(first, end))
      builder.record("visits", row.started_at, { source: row.source });
    for (const row of db
      .prepare(
        "SELECT path,created_at FROM analytics_pageviews WHERE created_at>=? AND created_at<?",
      )
      .iterate(first, end)) {
      const p = cleanPath(row.path);
      builder.record("views", row.created_at, {
        path: p,
        title: titles.get(p?.endsWith("/") ? p : p + "/"),
      });
    }
    for (const row of db
      .prepare(
        "SELECT created_at FROM leads WHERE created_at>=? AND created_at<?",
      )
      .iterate(new Date(first).toISOString(), new Date(end).toISOString()))
      builder.record("leads", Date.parse(row.created_at));
    db.exec("COMMIT");
    return builder.packet();
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
}
async function* jsonLines(file) {
  const before = await stat(file);
  if (!before.isFile()) throw Error("SOURCE_NOT_A_REGULAR_FILE");
  if (!before.size) return;
  let remaining = "";
  for await (const chunk of createReadStream(file, {
    encoding: "utf8",
    end: before.size - 1,
  })) {
    remaining += chunk;
    if (remaining.length > 5e6) throw Error("SOURCE_LINE_TOO_LARGE");
    let newline;
    while ((newline = remaining.indexOf("\n")) !== -1) {
      const line = remaining.slice(0, newline).trim();
      remaining = remaining.slice(newline + 1);
      if (line) yield JSON.parse(line);
    }
  }
  // An unfinished append is not yet a committed JSONL record; retry next cycle.
  const after = await stat(file);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size < before.size
  )
    throw Error("SOURCE_CHANGED_DURING_READ");
}
function securitySource(row) {
  const utm =
    row.attribution?.utm?.utm_source ||
    row.attribution?.utm_source ||
    row.attribution?.utmSource;
  if (typeof utm === "string" && utm.trim()) return "utm:" + utm.slice(0, 64);
  if (!row.referrer) return "direct";
  try {
    const host = new URL(row.referrer).hostname.toLowerCase();
    return ["pasport-bezopasnosty.ru", "www.pasport-bezopasnosty.ru"].includes(
      host,
    )
      ? "internal"
      : "ref:" + host;
  } catch {
    return "unknown";
  }
}
export async function collectSecurity({
  sourceFile,
  leadsFile,
  now = Date.now(),
}) {
  const builder = new NativeReportBuilder({
    host: "pasport-bezopasnosty.ru",
    kind: "security",
    now,
    views: false,
    articles: false,
  });
  for await (const row of jsonLines(sourceFile))
    if (!isBotVisit(row))
      builder.record("visits", Date.parse(row.receivedAt), {
        source: securitySource(row),
      });
  for await (const row of jsonLines(leadsFile))
    builder.record("leads", Date.parse(row.receivedAt || row.submittedAt));
  return builder.packet();
}
export async function collectNative(config) {
  if (config.kind === "accessibility") return collectAccessibility(config);
  if (config.kind === "security") return collectSecurity(config);
  throw Error("UNKNOWN_NATIVE_COLLECTOR");
}
