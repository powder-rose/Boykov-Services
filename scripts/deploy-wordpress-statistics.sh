#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ "$EUID" == 0 ]] || { echo 'WORDPRESS_STATISTICS_DEPLOY_REQUIRES_ROOT'; exit 1; }
[[ -f integrations/leads/wordpress/boykov-leads/includes/statistics.php && -f .env ]] || { echo 'WORDPRESS_STATISTICS_SOURCE_OR_ENV_MISSING'; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo 'WORDPRESS_STATISTICS_DEPLOY_STOPPED_TRACKED_LOCAL_CHANGES'; exit 1; }
mkdir -p /root/boykov-services-backups
backup=$(mktemp -d /root/boykov-services-backups/pre-wordpress-statistics-XXXXXXXX)
chmod 700 "$backup"
previous=$(docker inspect boykov-services-app-1 --format '{{.Image}}')
previous_tag="boykov-services-app:pre-wordpress-statistics-$(date -u +%Y%m%d%H%M%S)-${RANDOM}"
docker image tag "$previous" "$previous_tag"
printf '%s\n' "$previous_tag" > "$backup/previous-image.txt"
git rev-parse HEAD > "$backup/source-commit.txt"
printf 'BACKUP=%s\n' "$backup"
trap 'code=$?; if [[ "$code" != 0 ]]; then printf "WORDPRESS_STATISTICS_DEPLOY_FAILED BACKUP=%s\n" "$backup"; fi' EXIT
docker compose exec -T app node --input-type=module - <<'DOCS_BACKUP' > "$backup/database-backup.json"
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const directory='/app/data/backups/pre-wordpress-statistics-'+randomUUID();
mkdirSync(directory,{recursive:true,mode:0o700});
const db=new DatabaseSync('/app/data/platform.sqlite');
try {
 db.exec('PRAGMA busy_timeout=10000');
 const destination=directory+'/platform.sqlite';
 db.prepare('VACUUM INTO ?').run(destination);chmodSync(destination,0o600);
 const snapshot=new DatabaseSync(destination,{readOnly:true});
 try {if(snapshot.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('BACKUP_INTEGRITY_FAILED');}finally{snapshot.close();}
 console.log(JSON.stringify({database:destination}));
}finally{db.close();}
DOCS_BACKUP
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
docker compose exec -T app node --input-type=module - <<'VERIFY_WORDPRESS_STATISTICS'
import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync('/app/data/platform.sqlite',{readOnly:true});
try {
 if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('DATABASE_CHECK_FAILED');
 for(const table of ['statistics_native_reports','statistics_site_colors'])if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))throw Error('WORDPRESS_STATISTICS_MIGRATION_MISSING');
}finally{db.close();}
const health=await fetch('http://127.0.0.1:8787/healthz',{signal:AbortSignal.timeout(10000)});
if(!health.ok||(await health.json()).ok!==true)throw Error('HEALTH_FAILED');
for(const route of ['/api/statistics/overview?period=7','/api/statistics/sites','/api/statistics/report?site=nwd&period=24h']){
 const response=await fetch('http://127.0.0.1:8787'+route,{signal:AbortSignal.timeout(10000)});
 if(response.status!==401)throw Error('WORDPRESS_STATISTICS_AUTH_FAILED');
}
const {nativeSources}=await import('./shared/statistics.js');
if(nativeSources['energo-365.ru']?.kind!=='wordpress')throw Error('WORDPRESS_SOURCE_MISSING');
const hook=await fetch('http://127.0.0.1:8787/hooks/statistics/unauthorized-probe',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
if(hook.status!==401)throw Error('WORDPRESS_HOOK_AUTH_FAILED');
console.log('WORDPRESS_STATISTICS_MODULE=OK\nWORDPRESS_STATISTICS_AUTH=OK\nWORDPRESS_STATISTICS_DATABASE=OK');
VERIFY_WORDPRESS_STATISTICS
docker compose ps
printf 'WORDPRESS_STATISTICS_DEPLOY=OK\nDEPLOY_COMMIT=%s\nBACKUP=%s\n' "$(git rev-parse --short HEAD)" "$backup"
