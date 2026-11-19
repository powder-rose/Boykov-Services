#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ "$EUID" == 0 ]] || { echo 'ACCOUNTS_DEPLOY_REQUIRES_ROOT'; exit 1; }
[[ -f server/manage-accounts.js && -f .env ]] || { echo 'ACCOUNTS_SOURCE_OR_ENV_MISSING'; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo 'ACCOUNTS_DEPLOY_STOPPED_TRACKED_LOCAL_CHANGES'; exit 1; }
roster=${1:-}
if [[ -n "$roster" ]]; then
  [[ -f "$roster" && ! -L "$roster" ]] || { echo 'ACCOUNTS_ROSTER_MISSING'; exit 1; }
  chmod 600 "$roster"
  docker compose exec -T app node -e 'const fs=require("node:fs");const raw=fs.readFileSync(0,"utf8");if(Buffer.byteLength(raw)>65536)throw Error("ROSTER_TOO_LARGE");const rows=JSON.parse(raw);if(!Array.isArray(rows)||!rows.length||rows.length>100||rows.some(r=>typeof r.name!=="string"||!r.name.trim()||r.name.length>120||typeof r.login!=="string"||! /^[a-z0-9][a-z0-9._-]{2,63}$/.test(r.login)||Object.keys(r).some(k=>!["login","name"].includes(k))))throw Error("INVALID_ROSTER");console.log("ACCOUNTS_ROSTER="+rows.length);' < "$roster"
fi
mkdir -p /root/boykov-services-backups
backup=$(mktemp -d /root/boykov-services-backups/pre-accounts-XXXXXXXX)
chmod 700 "$backup"
previous=$(docker inspect boykov-services-app-1 --format '{{.Image}}')
previous_tag="boykov-services-app:pre-accounts-$(date -u +%Y%m%d%H%M%S)-${RANDOM}"
docker image tag "$previous" "$previous_tag"
printf '%s\n' "$previous_tag" > "$backup/previous-image.txt"
git rev-parse HEAD > "$backup/source-commit.txt"
printf 'BACKUP=%s\n' "$backup"
trap 'code=$?; if [[ "$code" != 0 ]]; then printf "ACCOUNTS_DEPLOY_FAILED BACKUP=%s\n" "$backup"; fi' EXIT
docker compose exec -T app node --input-type=module - <<'DB_BACKUP' > "$backup/database-backup.json"
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const directory = '/app/data/backups/pre-accounts-' + randomUUID();
mkdirSync(directory, { recursive: true, mode: 0o700 });
const db = new DatabaseSync('/app/data/platform.sqlite');
try {
  db.exec('PRAGMA busy_timeout=5000');
  const destination = directory + '/platform.sqlite';
  db.exec("VACUUM INTO '" + destination.replaceAll("'", "''") + "'");
  chmodSync(destination, 0o600);
  const snapshot = new DatabaseSync(destination, { readOnly: true });
  try { if (snapshot.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('BACKUP_INTEGRITY_FAILED'); }
  finally { snapshot.close(); }
  console.log(JSON.stringify({ database: destination }));
} finally { db.close(); }
DB_BACKUP
cat > "$backup/rollback-app.sh" <<ROLLBACK
#!/usr/bin/env bash
set -Eeuo pipefail
cd /opt/boykov-services
docker image tag '$previous_tag' boykov-services-app:latest
docker compose up -d --no-deps --no-build --wait --wait-timeout 120 app
ROLLBACK
chmod 700 "$backup/rollback-app.sh"
docker compose build app
docker compose up -d --no-deps --no-build --wait --wait-timeout 120 app
docker compose exec -T app node --input-type=module - <<'VERIFY_ACCOUNTS'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/app/data/platform.sqlite', { readOnly: true });
try {
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('DATABASE_CHECK_FAILED');
  for(const table of ['workspace_accounts','account_sessions','workspace_document_owners']) {
    if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))throw new Error('ACCOUNTS_MIGRATION_MISSING');
  }
  if (!db.prepare('PRAGMA table_info(sales_leads)').all().some(c => c.name === 'assignee_id')) throw new Error('ASSIGNEE_MIGRATION_MISSING');
  if (!db.prepare('PRAGMA table_info(sales_history)').all().some(c => c.name === 'actor_id')) throw new Error('ACTOR_MIGRATION_MISSING');
  if (db.prepare('PRAGMA table_info(sessions)').all().length!==3) throw new Error('SHARED_SESSION_COMPATIBILITY_FAILED');
  console.log('ACCOUNTS_SHARED_SESSION_SCHEMA=OK');
} finally { db.close(); }
const health = await fetch('http://127.0.0.1:8787/healthz', {signal: AbortSignal.timeout(10000)});
if (!health.ok || (await health.json()).ok !== true) throw new Error('HEALTH_FAILED');
const auth = await fetch('http://127.0.0.1:8787/api/accounts', {
  method: 'POST', headers: {'Content-Type':'application/json','X-Boykov-Request':'1'}, body: '{}', signal: AbortSignal.timeout(10000),
});
if (auth.status !== 401) throw new Error('ACCOUNT_AUTH_CHECK_FAILED');
console.log('ACCOUNTS_MODULE=OK\nACCOUNTS_AUTH=OK');
VERIFY_ACCOUNTS
if [[ -n "$roster" ]]; then
  docker compose exec -T app node server/manage-accounts.js prepare-sales < "$roster"
fi
docker compose ps
printf 'ACCOUNTS_DEPLOY=OK\nBACKUP=%s\n' "$backup"
