#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ "$EUID" == 0 ]] || { echo 'TILDA_DEPLOY_REQUIRES_ROOT'; exit 1; }
[[ -f server/modules/leads/tilda.js && -f .env ]] || { echo 'TILDA_SOURCE_OR_ENV_MISSING'; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo 'TILDA_DEPLOY_STOPPED_TRACKED_LOCAL_CHANGES'; exit 1; }
mkdir -p /root/boykov-services-backups
backup=$(mktemp -d /root/boykov-services-backups/pre-tilda-XXXXXXXX)
chmod 700 "$backup"
previous=$(docker inspect boykov-services-app-1 --format '{{.Image}}')
previous_tag="boykov-services-app:pre-tilda-$(date -u +%Y%m%d%H%M%S)-${RANDOM}"
docker image tag "$previous" "$previous_tag"
printf '%s\n' "$previous_tag" > "$backup/previous-image.txt"
git rev-parse HEAD > "$backup/source-commit.txt"
printf 'BACKUP=%s\n' "$backup"
trap 'code=$?; if [[ "$code" != 0 ]]; then printf "TILDA_DEPLOY_FAILED BACKUP=%s\n" "$backup"; fi' EXIT
docker compose exec -T app node --input-type=module - <<'DB_BACKUP' > "$backup/database-backup.json"
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const directory = '/app/data/backups/pre-tilda-' + randomUUID();
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
docker compose exec -T app node --input-type=module - <<'VERIFY_TILDA'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/app/data/platform.sqlite', { readOnly: true });
let site;
try {
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('DATABASE_CHECK_FAILED');
  site = db.prepare("SELECT id,delivery_mode FROM sales_sites WHERE host='boykovgroup.ru'").get();
  if (!site || site.delivery_mode !== 'tilda') throw new Error('TILDA_SITE_NOT_READY');
} finally { db.close(); }
const health = await fetch('http://127.0.0.1:8787/healthz');
if (!health.ok || (await health.json()).ok !== true) throw new Error('HEALTH_FAILED');
const test = await fetch('http://127.0.0.1:8787/hooks/tilda/' + site.id, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'test=test',
});
if (test.status !== 401) throw new Error('TILDA_AUTH_CHECK_FAILED');
const publicProbe = await fetch('https://boykov-services.ru/hooks/tilda/' + site.id, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'test=test',
  redirect: 'error', signal: AbortSignal.timeout(10000),
});
if (publicProbe.status !== 401 || (await publicProbe.json()).error !== 'Нет доступа к приёму заявок.')
  throw new Error('TILDA_PUBLIC_ROUTE_CHECK_FAILED');
console.log('TILDA_MODULE=OK\nTILDA_AUTH=OK\nTILDA_PUBLIC_AUTH=OK\nTILDA_SITE_ID=' + site.id);
VERIFY_TILDA
docker compose ps
printf 'TILDA_DEPLOY=OK\nBACKUP=%s\n' "$backup"
