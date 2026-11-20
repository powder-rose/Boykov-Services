#!/usr/bin/env bash
# Frontend + a narrow CSP change only. No data migration or additional service.
set -Eeuo pipefail
umask 022
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ "$EUID" == 0 ]] || { echo PHOTO_PDF_DEPLOY_REQUIRES_ROOT; exit 1; }
[[ -f src/features/photo-pdf/PhotoPdf.tsx && -f .env ]] || { echo PHOTO_PDF_SOURCE_OR_ENV_MISSING; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo PHOTO_PDF_TRACKED_LOCAL_CHANGES; exit 1; }
install -d -m 700 /root/boykov-services-backups
backup=$(mktemp -d /root/boykov-services-backups/pre-photo-pdf-XXXXXXXX)
previous=$(docker inspect boykov-services-app-1 --format '{{.Image}}')
tag="boykov-services-app:pre-photo-pdf-$(date -u +%Y%m%d%H%M%S)-${RANDOM}"
docker image tag "$previous" "$tag"
printf '%s\n' "$tag" > "$backup/previous-image.txt"
git rev-parse HEAD > "$backup/source-commit.txt"
cat > "$backup/rollback-app.sh" <<ROLLBACK
#!/usr/bin/env bash
set -Eeuo pipefail
cd /opt/boykov-services
docker image tag '$tag' boykov-services-app:latest
docker compose up -d --no-deps --no-build --wait --wait-timeout 120 app
ROLLBACK
chmod 700 "$backup/rollback-app.sh"
printf 'BACKUP=%s\n' "$backup"
trap 'result=$?; if [[ "$result" != 0 ]]; then printf "PHOTO_PDF_DEPLOY_CHECK_REQUIRED BACKUP=%s\n" "$backup"; fi' EXIT
docker compose build app
docker compose up -d --no-deps --no-build --wait --wait-timeout 120 app
docker compose exec -T app node --input-type=module - <<'VERIFY_PHOTO_PDF'
import {readdirSync,statSync} from 'node:fs';
const response=await fetch('http://127.0.0.1:8787/healthz',{signal:AbortSignal.timeout(10000)});
if(!response.ok||(await response.json()).ok!==true)throw Error('PHOTO_PDF_HEALTH_FAILED');
const csp=response.headers.get('content-security-policy')||'';
if(!csp.includes("img-src 'self' data: blob:;")||!csp.includes("script-src 'self';")||!csp.includes("connect-src 'self';"))throw Error('PHOTO_PDF_CSP_CHECK_FAILED');
const files=readdirSync('/app/dist/assets');
if(!files.some(file=>/^worker-.*\.js$/.test(file)&&statSync('/app/dist/assets/'+file).size>0))throw Error('PHOTO_PDF_WORKER_MISSING');
const index=await fetch('http://127.0.0.1:8787/',{signal:AbortSignal.timeout(10000)});
if(!index.ok||!(await index.text()).includes('id="root"'))throw Error('PHOTO_PDF_FRONTEND_FAILED');
console.log('PHOTO_PDF_MODULE=OK\nPHOTO_PDF_CSP=OK\nPHOTO_PDF_HEALTH=OK');
VERIFY_PHOTO_PDF
docker compose ps
printf 'PHOTO_PDF_DEPLOY=OK\nDEPLOY_COMMIT=%s\nBACKUP=%s\n' "$(git rev-parse --short HEAD)" "$backup"
