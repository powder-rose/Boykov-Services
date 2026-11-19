#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ "$EUID" == 0 ]] || { echo 'STATISTICS_DEPLOY_REQUIRES_ROOT'; exit 1; }
[[ -f server/modules/statistics/index.js && -f .env ]] || { echo 'STATISTICS_SOURCE_OR_ENV_MISSING'; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo 'STATISTICS_DEPLOY_STOPPED_TRACKED_LOCAL_CHANGES'; exit 1; }
mkdir -p /root/boykov-services-backups
backup=$(mktemp -d /root/boykov-services-backups/pre-statistics-XXXXXXXX)
chmod 700 "$backup"
previous=$(docker inspect boykov-services-app-1 --format '{{.Image}}')
previous_tag="boykov-services-app:pre-statistics-$(date -u +%Y%m%d%H%M%S)-${RANDOM}"
docker image tag "$previous" "$previous_tag"
printf '%s\n' "$previous_tag" > "$backup/previous-image.txt"
git rev-parse HEAD > "$backup/source-commit.txt"
printf 'BACKUP=%s\n' "$backup"
trap 'code=$?; if [[ "$code" != 0 ]]; then printf "STATISTICS_DEPLOY_FAILED BACKUP=%s\n" "$backup"; fi' EXIT
docker compose exec -T app node --input-type=module - <<'STATS_BACKUP' > "$backup/database-backup.json"
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, copyFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const directory='/app/data/backups/pre-statistics-'+randomUUID();
mkdirSync(directory,{recursive:true,mode:0o700});
const db=new DatabaseSync('/app/data/platform.sqlite');
try {
 db.exec('PRAGMA busy_timeout=10000');
 const destination=directory+'/platform.sqlite';
 db.prepare('VACUUM INTO ?').run(destination);chmodSync(destination,0o600);
 const snapshot=new DatabaseSync(destination,{readOnly:true});
 try {if(snapshot.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('BACKUP_INTEGRITY_FAILED');}finally{snapshot.close();}
 const secret='/app/data/statistics/metrika.json';
 if(existsSync(secret)){copyFileSync(secret,directory+'/metrika.json');chmodSync(directory+'/metrika.json',0o600);}
 console.log(JSON.stringify({database:destination,statisticsSecretSaved:existsSync(secret)}));
}finally{db.close();}
STATS_BACKUP
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
docker compose exec -T app node --input-type=module - <<'VERIFY_STATISTICS'
import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync('/app/data/platform.sqlite',{readOnly:true});
try {
 if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('DATABASE_CHECK_FAILED');
 for(const table of ['statistics_settings','statistics_cache'])if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))throw Error('STATISTICS_MIGRATION_MISSING');
}finally{db.close();}
const health=await fetch('http://127.0.0.1:8787/healthz',{signal:AbortSignal.timeout(10000)});
if(!health.ok||(await health.json()).ok!==true)throw Error('HEALTH_FAILED');
for(const route of ['/api/statistics/sites','/api/statistics/counters','/api/statistics/report?site=nwd&period=24h']){
 const response=await fetch('http://127.0.0.1:8787'+route,{signal:AbortSignal.timeout(10000)});
 if(response.status!==401)throw Error('STATISTICS_AUTH_CHECK_FAILED');
}
console.log('STATISTICS_MODULE=OK\nSTATISTICS_AUTH=OK');
VERIFY_STATISTICS
docker compose ps
printf 'STATISTICS_DEPLOY=OK\nDEPLOY_COMMIT=%s\nBACKUP=%s\n' "$(git rev-parse --short HEAD)" "$backup"
