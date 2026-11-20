import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function correctEnergoSource(databaseFile, backupDirectory) {
  if (!existsSync(databaseFile)) throw new Error("DATABASE_NOT_FOUND");
  const db = new DatabaseSync(databaseFile, { timeout: 10000 });
  let backup;
  try {
    db.exec("PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL;");
    const getSites = () =>
      db
        .prepare(
          "SELECT id,name,host FROM sales_sites WHERE lower(host) IN (?,?) ORDER BY host",
        )
        .all("lp.energo-365.ru", "energo-365.ru");
    const sites = getSites();
    const old = sites.find((s) => s.host.toLowerCase() === "lp.energo-365.ru");
    const current = sites.find((s) => s.host.toLowerCase() === "energo-365.ru");
    if (!old && current)
      return {
        status: "already_correct",
        siteId: current.id,
        host: current.host,
      };
    if (!old) throw new Error("LP_SOURCE_NOT_FOUND");
    if (current) throw new Error("BOTH_SOURCES_EXIST_NO_CHANGES");
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    backup = path.join(
      backupDirectory,
      "pre-energo-source-" + randomUUID() + ".sqlite",
    );
    db.prepare("VACUUM INTO ?").run(backup);
    const copy = new DatabaseSync(backup, { readOnly: true });
    try {
      if (copy.prepare("PRAGMA quick_check").get().quick_check !== "ok")
        throw new Error("BACKUP_CHECK_FAILED");
    } finally {
      copy.close();
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const latest = getSites();
      if (
        latest.length !== 1 ||
        latest[0].id !== old.id ||
        latest[0].host !== old.host
      )
        throw new Error("SOURCE_CHANGED_RETRY_REQUIRED");
      // Keep source ID, token hash, leads, status, ownership and history unchanged.
      const changed = db
        .prepare(
          "UPDATE sales_sites SET host=?,name=?,delivery_mode='agent' WHERE id=? AND host=?",
        )
        .run("energo-365.ru", "Энерго 365", old.id, old.host);
      if (changed.changes !== 1) throw new Error("SOURCE_UPDATE_FAILED");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return {
      status: "corrected",
      siteId: old.id,
      host: "energo-365.ru",
      backup,
      leadsPreserved: db
        .prepare("SELECT COUNT(*) amount FROM sales_leads WHERE site_id=?")
        .get(old.id).amount,
    };
  } finally {
    db.close();
  }
}

if (process.env.BOYKOV_CORRECT_ENERGO === "1") {
  try {
    const dataDir = path.resolve(process.env.DATA_DIR || "/app/data");
    const result = correctEnergoSource(
      path.join(dataDir, "platform.sqlite"),
      path.join(dataDir, "backups"),
    );
    console.log("ENERGO_SOURCE=" + result.status.toUpperCase());
    console.log("ENERGO_SITE_ID=" + result.siteId);
    console.log("ENERGO_HOST=" + result.host);
    if (result.backup) console.log("BACKUP=" + result.backup);
    if (result.leadsPreserved !== undefined)
      console.log("LEADS_PRESERVED=" + result.leadsPreserved);
  } catch (error) {
    console.error(
      "ENERGO_CORRECTION_STOPPED=" +
        (/^[A-Z_]+$/.test(error.message)
          ? error.message
          : "DATABASE_CHECK_FAILED"),
    );
    process.exitCode = 1;
  }
}
