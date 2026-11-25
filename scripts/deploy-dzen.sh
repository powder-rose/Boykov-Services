#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ "$EUID" == 0 ]] || { echo DZEN_DEPLOY_REQUIRES_ROOT; exit 1; }
[[ -f .env && -f server/modules/dzen/index.js ]] || { echo DZEN_DEPLOY_SOURCE_MISSING; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo DZEN_DEPLOY_TRACKED_CHANGES; exit 1; }
mkdir -p /root/boykov-services-backups
backup=$(mktemp -d /root/boykov-services-backups/pre-dzen-XXXXXXXX)
chmod 700 "$backup"
previous=$(docker inspect boykov-services-app-1 --format '{{.Image}}')
previous_tag="boykov-services-app:pre-dzen-$(date -u +%Y%m%d%H%M%S)-${RANDOM}"
docker image tag "$previous" "$previous_tag"
git rev-parse HEAD > "$backup/source-commit.txt"
printf 'BACKUP=%s\n' "$backup"
switched=0
recover(){ code=$?; if [[ "$code" != 0 ]]; then
  if [[ "$switched" == 1 ]]; then docker image tag "$previous_tag" boykov-services-app:latest; docker compose up -d --no-deps --no-build --wait --wait-timeout 120 app || true; fi
  printf 'DZEN_DEPLOY_FAILED BACKUP=%s\n' "$backup"
fi; }
trap recover EXIT
docker compose exec -T app node --input-type=module - <<'DZEN_BACKUP' > "$backup/database-backup.txt"
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const directory='/app/data/backups/pre-dzen-'+randomUUID();
mkdirSync(directory,{recursive:true,mode:0o700});
const db=new DatabaseSync('/app/data/platform.sqlite');
try {db.exec('PRAGMA busy_timeout=10000');const file=directory+'/platform.sqlite';db.prepare('VACUUM INTO ?').run(file);chmodSync(file,0o600);const copy=new DatabaseSync(file,{readOnly:true});try{if(copy.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('BACKUP_INTEGRITY_FAILED');}finally{copy.close();}console.log(file);}finally{db.close();}
DZEN_BACKUP
docker compose build app
switched=1
docker compose up -d --no-deps --no-build --wait --wait-timeout 120 app
docker compose exec -T app node --input-type=module - <<'DZEN_VERIFY'
import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync('/app/data/platform.sqlite',{readOnly:true});
try {if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('DATABASE_CHECK_FAILED');for(const table of ['dzen_settings','dzen_comments','dzen_tasks','dzen_runtime','dzen_events','dzen_prompt_history'])if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))throw Error('DZEN_SCHEMA_MISSING');}finally{db.close();}
const base='http://127.0.0.1:8787';const health=await fetch(base+'/healthz');if(!health.ok||!(await health.json()).ok)throw Error('HEALTH_FAILED');
const auth=await fetch(base+'/api/dzen');if(auth.status!==401)throw Error('DZEN_AUTH_FAILED');
const hook=await fetch(base+'/hooks/dzen/poll',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(![401,503].includes(hook.status))throw Error('DZEN_HOOK_AUTH_FAILED');
console.log('DZEN_MODULE=OK\nDZEN_AUTH=OK\nDZEN_HOOK_AUTH=OK');
DZEN_VERIFY
switched=0
docker compose ps
printf 'DZEN_DEPLOY=OK\nDEPLOY_COMMIT=%s\nBACKUP=%s\n' "$(git rev-parse --short HEAD)" "$backup"
