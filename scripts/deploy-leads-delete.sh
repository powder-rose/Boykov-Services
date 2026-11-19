#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ "$EUID" == 0 ]] || { echo 'LEADS_DELETE_DEPLOY_REQUIRES_ROOT'; exit 1; }
[[ -f docs/LEADS-DELETE.md && -f .env ]] || { echo 'LEADS_DELETE_SOURCE_OR_ENV_MISSING'; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo 'LEADS_DELETE_DEPLOY_STOPPED_TRACKED_LOCAL_CHANGES'; exit 1; }
mkdir -p /root/boykov-services-backups
backup=$(mktemp -d /root/boykov-services-backups/pre-leads-delete-XXXXXXXX)
chmod 700 "$backup"
previous=$(docker inspect boykov-services-app-1 --format '{{.Image}}')
previous_tag="boykov-services-app:pre-leads-delete-$(date -u +%Y%m%d%H%M%S)-${RANDOM}"
docker image tag "$previous" "$previous_tag"
printf '%s\n' "$previous_tag" > "$backup/previous-image.txt"
git rev-parse HEAD > "$backup/source-commit.txt"
printf 'BACKUP=%s\n' "$backup"
trap 'code=$?; if [[ "$code" != 0 ]]; then printf "LEADS_DELETE_DEPLOY_FAILED BACKUP=%s\n" "$backup"; fi' EXIT
docker compose exec -T app node --input-type=module - <<'DB_BACKUP' > "$backup/database-backup.json"
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const directory = '/app/data/backups/pre-leads-delete-' + randomUUID();
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
docker compose exec -T app node --input-type=module - <<'VERIFY_LEADS_DELETE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/app/data/platform.sqlite', { readOnly: true });
try {
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('DATABASE_CHECK_FAILED');
  if (!db.prepare('PRAGMA table_info(sales_leads)').all().some(c => c.name === 'deleted_at')) throw new Error('DELETE_MIGRATION_MISSING');
  if (!db.prepare('PRAGMA table_info(sales_history)').all().some(c => c.name === 'action')) throw new Error('DELETE_HISTORY_MIGRATION_MISSING');
  console.log('LEADS_ACTIVE=' + db.prepare('SELECT count(*) AS n FROM sales_leads WHERE deleted_at IS NULL').get().n);
  console.log('LEADS_TRASHED=' + db.prepare('SELECT count(*) AS n FROM sales_leads WHERE deleted_at IS NOT NULL').get().n);
} finally { db.close(); }
const health = await fetch('http://127.0.0.1:8787/healthz', {signal: AbortSignal.timeout(10000)});
if (!health.ok || (await health.json()).ok !== true) throw new Error('HEALTH_FAILED');
const auth = await fetch('http://127.0.0.1:8787/api/leads/trash', {
  method: 'POST', headers: {'Content-Type':'application/json','X-Boykov-Request':'1'}, body: '{}', signal: AbortSignal.timeout(10000),
});
if (auth.status !== 401) throw new Error('DELETE_AUTH_CHECK_FAILED');
console.log('LEADS_DELETE_MODULE=OK\nLEADS_DELETE_AUTH=OK');
VERIFY_LEADS_DELETE
docker compose ps
printf 'LEADS_DELETE_DEPLOY=OK\nBACKUP=%s\n' "$backup"
