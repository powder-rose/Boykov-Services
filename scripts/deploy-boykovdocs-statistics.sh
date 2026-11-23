#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ "$EUID" == 0 ]] || { echo BOYKOVDOCS_STATISTICS_DEPLOY_REQUIRES_ROOT; exit 1; }
[[ -f integrations/statistics/boykovdocs-agent.mjs && -f .env ]] || { echo BOYKOVDOCS_STATISTICS_SOURCE_OR_ENV_MISSING; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo BOYKOVDOCS_STATISTICS_TRACKED_CHANGES; exit 1; }
mkdir -p /root/boykov-services-backups
backup=$(mktemp -d /root/boykov-services-backups/pre-boykovdocs-statistics-XXXXXXXX)
previous=$(docker inspect boykov-services-app-1 --format '{{.Image}}')
previous_tag="boykov-services-app:pre-boykovdocs-statistics-$(date -u +%Y%m%d%H%M%S)-${RANDOM}"
docker image tag "$previous" "$previous_tag"
git rev-parse HEAD > "$backup/source-commit.txt"
printf 'BACKUP=%s\n' "$backup"
trap 'code=$?; if [[ "$code" != 0 ]]; then printf "BOYKOVDOCS_STATISTICS_DEPLOY_FAILED BACKUP=%s\n" "$backup"; fi' EXIT
docker compose exec -T app node --input-type=module - <<'BACKUP_DB' > "$backup/database-backup.json"
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const directory='/app/data/backups/pre-boykovdocs-statistics-'+randomUUID();
mkdirSync(directory,{recursive:true,mode:0o700});
const db=new DatabaseSync('/app/data/platform.sqlite');
try {
  db.exec('PRAGMA busy_timeout=10000');
  const destination=directory+'/platform.sqlite';
  db.prepare('VACUUM INTO ?').run(destination);chmodSync(destination,0o600);
  const snapshot=new DatabaseSync(destination,{readOnly:true});
  try { if(snapshot.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('BACKUP_INTEGRITY_FAILED'); } finally { snapshot.close(); }
  console.log(JSON.stringify({database:destination}));
} finally { db.close(); }
BACKUP_DB
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
docker compose exec -T app node --input-type=module - <<'VERIFY'
import { DatabaseSync } from 'node:sqlite';
import { docsStatisticsSite, nativeSources } from './shared/statistics.js';
if(nativeSources[docsStatisticsSite.host]?.kind!=='boykovdocs')throw Error('BOYKOVDOCS_MODULE_MISSING');
const db=new DatabaseSync('/app/data/platform.sqlite',{readOnly:true});
try {
  if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('DATABASE_CHECK_FAILED');
  if(!db.prepare('SELECT token_hash IS NOT NULL configured FROM docs_customer_connection WHERE id=1').get()?.configured)throw Error('CONNECT_CUSTOMERS_FIRST');
} finally { db.close(); }
const base='http://127.0.0.1:8787';
const request=(route,options={})=>fetch(base+route,{...options,signal:AbortSignal.timeout(10000)});
const health=await request('/healthz');if(!health.ok||(await health.json()).ok!==true)throw Error('HEALTH_FAILED');
for(const path of ['/hooks/docs-customers/statistics','/hooks/docs-customers/statistics/handshake']){
  const response=await request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  if(response.status!==401)throw Error('STATISTICS_HOOK_AUTH_FAILED');
}
if((await request('/api/statistics/overview?period=7')).status!==401)throw Error('STATISTICS_AUTH_FAILED');
console.log('BOYKOVDOCS_STATISTICS_MODULE=OK\nBOYKOVDOCS_STATISTICS_AUTH=OK\nDATABASE=OK');
VERIFY
docker compose ps
bash scripts/check-boykovdocs-statistics.sh
printf 'BOYKOVDOCS_STATISTICS_DEPLOY=OK\nDEPLOY_COMMIT=%s\nBACKUP=%s\n' "$(git rev-parse --short HEAD)" "$backup"
