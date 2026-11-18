import { DatabaseSync } from "node:sqlite";
import { statSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

export function installAccessibilityOutbox(db) {
  const fields = db
    .prepare("PRAGMA table_info(leads)")
    .all()
    .map((r) => r.name);
  if (!["id", "payload", "created_at"].every((f) => fields.includes(f)))
    throw new Error("UNEXPECTED_SOURCE_SCHEMA");
  db.exec("BEGIN IMMEDIATE");
  try {
    // Snapshot and lead share a commit; removal in the old admin preserves delivery.
    db.exec(`CREATE TABLE IF NOT EXISTS boykov_lead_outbox (
        id TEXT PRIMARY KEY NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS boykov_lead_capture AFTER INSERT ON leads
      BEGIN
        INSERT OR IGNORE INTO boykov_lead_outbox(id,payload,created_at)
        VALUES(NEW.id,NEW.payload,NEW.created_at);
      END;
      INSERT OR IGNORE INTO boykov_lead_outbox(id,payload,created_at)
      SELECT id,payload,created_at FROM leads;`);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [source, backup] = process.argv.slice(2);
  if (
    !source ||
    !backup ||
    !statSync(source).isFile() ||
    existsSync(backup) ||
    resolve(source) === resolve(backup)
  )
    throw new Error(
      "Usage: node accessibility-outbox.mjs EXISTING_DATABASE NEW_BACKUP_FILE",
    );
  process.umask(0o077);
  mkdirSync(dirname(resolve(backup)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(source);
  try {
    db.exec("PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL;");
    db.prepare("VACUUM INTO ?").run(resolve(backup));
    chmodSync(backup, 0o600);
    installAccessibilityOutbox(db);
    console.log("ACCESSIBILITY_OUTBOX=INSTALLED");
    console.log(
      "SNAPSHOTS=" +
        db.prepare("SELECT count(*) AS n FROM boykov_lead_outbox").get().n,
    );
  } finally {
    db.close();
  }
}
