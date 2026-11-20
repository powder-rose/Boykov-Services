#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ "$EUID" == 0 ]] || { echo 'DOCS_CUSTOMERS_DEPLOY_REQUIRES_ROOT'; exit 1; }
[[ -f server/modules/docs-customers/index.js && -f .env ]] || { echo 'DOCS_CUSTOMERS_SOURCE_OR_ENV_MISSING'; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo 'DOCS_CUSTOMERS_DEPLOY_STOPPED_TRACKED_LOCAL_CHANGES'; exit 1; }
mkdir -p /root/boykov-services-backups
backup=$(mktemp -d /root/boykov-services-backups/pre-docs-customers-XXXXXXXX)
chmod 700 "$backup"
previous=$(docker inspect boykov-services-app-1 --format '{{.Image}}')
previous_tag="boykov-services-app:pre-docs-customers-$(date -u +%Y%m%d%H%M%S)-${RANDOM}"
docker image tag "$previous" "$previous_tag"
printf '%s\n' "$previous_tag" > "$backup/previous-image.txt"
git rev-parse HEAD > "$backup/source-commit.txt"
printf 'BACKUP=%s\n' "$backup"
trap 'code=$?; if [[ "$code" != 0 ]]; then printf "DOCS_CUSTOMERS_DEPLOY_FAILED BACKUP=%s\n" "$backup"; fi' EXIT
docker compose exec -T app node --input-type=module - <<'DOCS_BACKUP' > "$backup/database-backup.json"
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, copyFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const directory='/app/data/backups/pre-docs-customers-'+randomUUID();
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
docker compose exec -T app node --input-type=module - <<'VERIFY_DOCS_CUSTOMERS'
import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync('/app/data/platform.sqlite',{readOnly:true});
try {
 if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('DATABASE_CHECK_FAILED');
 for(const table of ['docs_customers','docs_customer_calls','docs_customer_company_versions','docs_customer_lifecycle','docs_customer_company_updates','docs_customer_company_reviews','docs_customer_module_meta'])if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))throw Error('DOCS_CUSTOMERS_MIGRATION_MISSING');
 for(const name of ['deleted_at','deleted_by_id','deleted_by_name','deleted_by_kind'])if(!db.prepare('PRAGMA table_info(docs_customers)').all().some(c=>c.name===name))throw Error('DOCS_CUSTOMERS_TRASH_MIGRATION_MISSING');
}finally{db.close();}
const health=await fetch('http://127.0.0.1:8787/healthz',{signal:AbortSignal.timeout(10000)});
if(!health.ok||(await health.json()).ok!==true)throw Error('HEALTH_FAILED');
for(const route of ['/api/docs-customers','/api/docs-customers/connection']){
 const response=await fetch('http://127.0.0.1:8787'+route,{signal:AbortSignal.timeout(10000)});
 if(response.status!==401)throw Error('DOCS_CUSTOMERS_AUTH_CHECK_FAILED');
}
const hook=await fetch('http://127.0.0.1:8787/hooks/docs-customers',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
if(hook.status!==401)throw Error('DOCS_CUSTOMERS_HOOK_AUTH_FAILED');
console.log('DOCS_CUSTOMERS_MODULE=OK\nDOCS_CUSTOMERS_TRASH=OK\nDOCS_CUSTOMERS_UPDATES=OK\nDOCS_CUSTOMERS_AUTH=OK');
VERIFY_DOCS_CUSTOMERS
docker compose ps
printf 'DOCS_CUSTOMERS_DEPLOY=OK\nDEPLOY_COMMIT=%s\nBACKUP=%s\n' "$(git rev-parse --short HEAD)" "$backup"
