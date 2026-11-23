#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ "$EUID" == 0 ]] || { echo TEMPLATE_DEPLOY_REQUIRES_ROOT; exit 1; }
[[ -f .env && -f worker/template_library.py ]] || { echo TEMPLATE_DEPLOY_SOURCE_MISSING; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo TEMPLATE_DEPLOY_TRACKED_CHANGES; exit 1; }
report=$(bash scripts/backup-contract-templates.sh)
backup=${report#BACKUP=}
printf 'PRE_DEPLOY_BACKUP=%s\n' "$backup"
python3 - "$backup/documents.zip" <<'PY'
from pathlib import Path
from zipfile import ZipFile
from hashlib import sha256
import sys
with ZipFile(sys.argv[1]) as archive:
    if 'data/template-library.sqlite' in archive.namelist():
        print('TEMPLATE_LIBRARY=EXISTING_PRESERVED')
    else:
        # The initial import must not silently replace a manual hotfix.
        actual={name.removeprefix('legacy/'):sha256(archive.read(name)).hexdigest() for name in archive.namelist() if name.startswith('legacy/')}
        repository={p.name:sha256(p.read_bytes()).hexdigest() for p in Path('worker/vendor/core').glob('*.docm')}
        if actual!=repository:
            raise SystemExit('TEMPLATE_SOURCE_MISMATCH: existing Word templates differ from Git; backup preserved, no deployment performed')
        print('TEMPLATE_LIBRARY=INITIAL_IMPORT_VERIFIED')
PY
stamp="$(date -u +%Y%m%d%H%M%S)-${RANDOM}"
app_previous="boykov-services-app:pre-templates-$stamp"
worker_previous="boykov-services-documents:pre-templates-$stamp"
docker image tag "$(docker inspect boykov-services-app-1 --format '{{.Image}}')" "$app_previous"
docker image tag "$(docker inspect boykov-services-documents-1 --format '{{.Image}}')" "$worker_previous"
git rev-parse HEAD > "$backup/source-commit.txt"
cat > "$backup/rollback-images.sh" <<ROLLBACK
#!/usr/bin/env bash
set -Eeuo pipefail
cd /opt/boykov-services
docker image tag '$app_previous' boykov-services-app:latest
docker image tag '$worker_previous' boykov-services-documents:latest
docker compose up -d --no-build --wait --wait-timeout 120 documents app
ROLLBACK
chmod 700 "$backup/rollback-images.sh"
paused=0
recover() {
  code=$?
  if [[ "$code" != 0 ]]; then
    if [[ "$paused" == 1 ]]; then
      bash "$backup/rollback-images.sh" || true
    fi
    printf 'TEMPLATE_DEPLOY_FAILED BACKUP=%s\n' "$backup"
  fi
}
trap recover EXIT
# Build while the existing service is still running.
docker compose build documents app
# Prevent new generation/publication requests only for the switchover.
paused=1
docker compose stop app
jobs=1
for attempt in $(seq 1 30); do
    jobs=$(docker compose exec -T documents python -c "import os,sqlite3; from pathlib import Path; p=Path(os.getenv('CONTRACTS_DATA_DIR') or '/app/data/contracts')/'jobs.sqlite'; db=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True); print(db.execute(\"SELECT count(*) FROM jobs WHERE status IN ('queued','running')\").fetchone()[0]);db.close()")
    if [[ "$jobs" == 0 ]]; then break; fi
    sleep 3
done
[[ "$jobs" == 0 ]] || { echo TEMPLATE_DEPLOY_QUEUE_BUSY; exit 1; }
final_report=$(bash scripts/backup-contract-templates.sh)
printf 'QUIESCENT_%s\n' "$final_report"
docker compose up -d --no-deps --no-build --wait --wait-timeout 120 documents
docker compose exec -T documents python - <<'PY'
import json, os, urllib.request, hashlib, sqlite3
from pathlib import Path
headers={'Authorization':'Bearer '+os.environ['WORKER_TOKEN']}
def get(route):
    with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8790'+route,headers=headers),timeout=15) as response:
        return json.load(response)
health=get('/health')
if health.get('templateLibrary') is not True: raise RuntimeError('TEMPLATE_LIBRARY_NOT_READY')
items=get('/templates')['templates']
if len(items)!=6: raise RuntimeError('TEMPLATE_CATALOG_INCOMPLETE')
data=Path(os.getenv('CONTRACTS_DATA_DIR') or '/app/data/contracts')
db=sqlite3.connect((data/'template-library.sqlite').as_uri()+'?mode=ro',uri=True)
try:
    if db.execute('PRAGMA quick_check').fetchone()[0]!='ok': raise RuntimeError('TEMPLATE_DATABASE_FAILED')
    for item in items:
        active=item['active']
        row=db.execute('SELECT content FROM template_versions WHERE template_id=? AND version=?',(item['id'],active['version'])).fetchone()
        if not row or hashlib.sha256(row[0]).hexdigest()!=active['sha256']: raise RuntimeError('TEMPLATE_INTEGRITY_FAILED')
        print('TEMPLATE='+item['id']+' VERSION='+str(active['version'])+' SHA256='+active['sha256'][:12])
finally:
    db.close()
print('TEMPLATE_LIBRARY=OK')
PY
docker compose up -d --no-deps --no-build --wait --wait-timeout 120 app
paused=0
docker compose exec -T app node --input-type=module - <<'NODE'
const base='http://127.0.0.1:8787';
const h=await fetch(base+'/healthz',{signal:AbortSignal.timeout(10000)});
if(!h.ok||!(await h.json()).ok)throw Error('APP_HEALTH_FAILED');
const r=await fetch(base+'/api/contracts/templates',{signal:AbortSignal.timeout(10000)});
if(r.status!==401)throw Error('TEMPLATES_AUTH_FAILED');
console.log('TEMPLATE_AUTH=OK');
NODE
docker compose ps
printf 'TEMPLATE_DEPLOY=OK\nDEPLOY_COMMIT=%s\nBACKUP=%s\n' "$(git rev-parse --short HEAD)" "$backup"
