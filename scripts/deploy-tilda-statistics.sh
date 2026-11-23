#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ "$EUID" == 0 ]] || { echo 'TILDA_STATISTICS_DEPLOY_REQUIRES_ROOT'; exit 1; }
[[ -f server/modules/statistics/tilda.js && -f .env ]] || { echo 'TILDA_STATISTICS_SOURCE_OR_ENV_MISSING'; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo 'TILDA_STATISTICS_DEPLOY_STOPPED_TRACKED_LOCAL_CHANGES'; exit 1; }
mkdir -p /root/boykov-services-backups
backup=$(mktemp -d /root/boykov-services-backups/pre-tilda-statistics-XXXXXXXX)
previous=$(docker inspect boykov-services-app-1 --format '{{.Image}}')
previous_tag="boykov-services-app:pre-tilda-statistics-$(date -u +%Y%m%d%H%M%S)-${RANDOM}"
docker image tag "$previous" "$previous_tag"
printf '%s\n' "$previous_tag" > "$backup/previous-image.txt"
git rev-parse HEAD > "$backup/source-commit.txt"
printf 'BACKUP=%s\n' "$backup"
trap 'code=$?; if [[ "$code" != 0 ]]; then printf "TILDA_STATISTICS_DEPLOY_FAILED BACKUP=%s\n" "$backup"; fi' EXIT
docker compose exec -T app node --input-type=module - <<'BACKUP_DB' > "$backup/database-backup.json"
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const directory='/app/data/backups/pre-tilda-statistics-'+randomUUID();
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
docker compose exec -T app node --input-type=module - <<'VERIFY_TILDA_STATISTICS'
import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync('/app/data/platform.sqlite',{readOnly:true});
try {
  if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('DATABASE_CHECK_FAILED');
  for(const table of ['statistics_native_reports','statistics_tilda_state','statistics_tilda_views','statistics_tilda_sessions','statistics_tilda_budget'])if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))throw Error('MIGRATION_MISSING');
} finally { db.close(); }
const base='http://127.0.0.1:8787';
const request=(route,options={})=>fetch(base+route,{...options,signal:AbortSignal.timeout(10000)});
const health=await request('/healthz');if(!health.ok||(await health.json()).ok!==true)throw Error('HEALTH_FAILED');
const js=await request('/hooks/tilda-statistics/counter.js');if(!js.ok||!js.headers.get('content-type')?.includes('javascript')||!(await js.text()).includes('boykov_tilda_statistics_session_v1'))throw Error('COUNTER_MISSING');
const cors=await request('/hooks/tilda-statistics/view',{method:'OPTIONS',headers:{Origin:'https://boykovgroup.ru','Access-Control-Request-Method':'POST'}});if(cors.status!==204||cors.headers.get('access-control-allow-origin')!=='https://boykovgroup.ru')throw Error('COUNTER_ORIGIN_FAILED');
const auth=await request('/api/statistics/overview?period=7');if(auth.status!==401)throw Error('STATISTICS_AUTH_FAILED');
console.log('TILDA_STATISTICS_MODULE=OK\nTILDA_STATISTICS_DATABASE=OK\nTILDA_STATISTICS_AUTH=OK');
VERIFY_TILDA_STATISTICS
docker compose ps
bash scripts/check-tilda-statistics.sh
printf 'TILDA_STATISTICS_DEPLOY=OK\nDEPLOY_COMMIT=%s\nBACKUP=%s\n' "$(git rev-parse --short HEAD)" "$backup"
