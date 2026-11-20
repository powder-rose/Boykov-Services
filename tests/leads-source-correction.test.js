import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLeadsModule } from "../server/modules/leads/index.js";
import { correctEnergoSource } from "../server/correct-energo-source.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "energo-source-"));
  const file = path.join(root, "platform.sqlite"),
    backup = path.join(root, "backup");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL");
  createLeadsModule(db);
  db.prepare(
    "INSERT INTO sales_sites(id,name,host,token_hash,created_at) VALUES(?,?,?,?,?)",
  ).run(
    "energo",
    "LP Энерго",
    "lp.energo-365.ru",
    "a".repeat(64),
    new Date().toISOString(),
  );
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { db, file, backup };
}

test("Energo source correction preserves its key, ID and lead data and creates a consistent backup", async (t) => {
  const f = await fixture(t);
  const now = new Date().toISOString();
  f.db
    .prepare(
      "INSERT INTO sales_leads(id,site_id,event_id,payload_hash,payload,search_text,created_at,received_at,status,note,version,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "lead-1",
      "energo",
      "event-1",
      "hash",
      "{}",
      "",
      now,
      now,
      "working",
      "Keep my note",
      3,
      now,
    );
  const before = f.db.prepare("SELECT * FROM sales_leads").all();
  const result = correctEnergoSource(f.file, f.backup);
  assert.equal(result.status, "corrected");
  assert.equal(result.leadsPreserved, 1);
  assert.equal(result.siteId, "energo");
  assert.equal(
    f.db.prepare("SELECT host FROM sales_sites WHERE id='energo'").get().host,
    "energo-365.ru",
  );
  assert.equal(
    f.db.prepare("SELECT token_hash FROM sales_sites WHERE id='energo'").get()
      .token_hash,
    "a".repeat(64),
  );
  assert.deepEqual(f.db.prepare("SELECT * FROM sales_leads").all(), before);
  const snapshot = new DatabaseSync(result.backup, { readOnly: true });
  assert.equal(snapshot.prepare("PRAGMA quick_check").get().quick_check, "ok");
  assert.equal(
    snapshot.prepare("SELECT host FROM sales_sites WHERE id='energo'").get()
      .host,
    "lp.energo-365.ru",
  );
  snapshot.close();
  assert.equal(correctEnergoSource(f.file, f.backup).status, "already_correct");
  assert.equal((await readdir(f.backup)).length, 1);
});

test("Energo source correction refuses conflicting sources without deleting either source", async (t) => {
  const f = await fixture(t);
  f.db
    .prepare("INSERT INTO sales_sites(id,name,host,created_at) VALUES(?,?,?,?)")
    .run("existing", "Energo", "energo-365.ru", new Date().toISOString());
  const before = f.db.prepare("SELECT * FROM sales_sites ORDER BY id").all();
  assert.throws(
    () => correctEnergoSource(f.file, f.backup),
    /BOTH_SOURCES_EXIST_NO_CHANGES/,
  );
  assert.deepEqual(
    f.db.prepare("SELECT * FROM sales_sites ORDER BY id").all(),
    before,
  );
});
