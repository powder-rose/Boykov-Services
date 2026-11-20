#!/usr/bin/env bash
# Run on the BoykovDocs VPS. Installs a separate collector for paid generations and wallet credits/refunds.
set -Eeuo pipefail
umask 077
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ "$EUID" == 0 ]] || { echo DOCS_COMMERCE_REQUIRES_ROOT; exit 1; }
for command in docker python3; do command -v "$command" >/dev/null || { echo "DOCS_COMMERCE_MISSING=$command"; exit 1; }; done
docker compose version >/dev/null
for file in integrations/docs-customers/commerce-agent.mjs integrations/docs-customers/sales-agent.mjs shared/docs-commerce.js shared/docs-sales.js shared/docs-customers.js; do [[ -f "$file" ]] || { echo DOCS_COMMERCE_SOURCE_MISSING; exit 1; }; done
existing_config=/opt/boykovdocs-customers-delivery/config.json
[[ -f "$existing_config" ]] || { echo DOCS_COMMERCE_CONNECT_CUSTOMERS_FIRST; exit 1; }
source_dir=$(docker inspect boykovdocs-api --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}')
[[ "$source_dir" == /* && -f "$source_dir/users.json" ]] || { echo DOCS_COMMERCE_SOURCE_DATA_NOT_FOUND; exit 1; }
orders_source=$(docker inspect boykovdocs-api --format '{{range .Mounts}}{{if eq .Destination "/app/src/data"}}{{.Source}}{{end}}{{end}}')
[[ "$orders_source" == /* && -d "$orders_source/publicGenerationOrders" ]] || { echo DOCS_COMMERCE_GENERATION_SOURCE_NOT_FOUND; exit 1; }
source_uid=$(docker exec boykovdocs-api id -u)
source_gid=$(docker exec boykovdocs-api id -g)
[[ "$source_uid" =~ ^[0-9]+$ && "$source_gid" =~ ^[0-9]+$ ]] || exit 1
root=/opt/boykovdocs-commerce-delivery
install -d -m 700 "$root"
backup=$(mktemp -d "$root/pre-connect-XXXXXXXX")
for file in config.json compose.json; do if [[ -f "$root/$file" ]]; then cp -p "$root/$file" "$backup/$file"; fi; done
# Reuse the already installed private key; never echo it or pass it in arguments.
python3 - "$existing_config" "$backup/candidate-config.json" <<'PY'
import sys,json,re,urllib.request,urllib.parse,os
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args): return None
try:
 with open(sys.argv[1],encoding='utf-8') as file: old=json.load(file)
 url=urllib.parse.urlsplit(old['endpoint'])
 if url.scheme!='https' or not url.netloc or url.username or url.password or url.query or url.fragment or url.path!='/hooks/docs-customers': raise ValueError()
 key=old['token']
 if not re.fullmatch('[a-f0-9]{64}',key): raise ValueError()
 endpoint=old['endpoint']+'/commerce'
 request=urllib.request.Request(endpoint+'/handshake',data=b'{}',headers={'Content-Type':'application/json','Authorization':'Bearer '+key},method='POST')
 with urllib.request.build_opener(NoRedirect).open(request,timeout=20) as response: result=json.load(response)
 if result.get('ok') is not True or result.get('source')!='boykovdocs-commerce' or result.get('protocol')!=1 or result.get('scope')!='generations-and-topups': raise ValueError()
 with open(sys.argv[2],'x',encoding='utf-8') as file: json.dump({'endpoint':endpoint,'token':key,'sourceDir':'/source','stateDir':'/state','ordersDir':'/orders/publicGenerationOrders'},file)
 os.chmod(sys.argv[2],0o600)
except Exception: raise SystemExit('DOCS_COMMERCE_HUB_CHECK_FAILED: сначала обновите Boykov Services и проверьте подключение клиентов')
print('DOCS_COMMERCE_HUB=OK')
PY
code=$(mktemp -d "$root/code-XXXXXXXX")
chmod 755 "$code"
install -d -m 755 "$code/integrations/docs-customers" "$code/shared"
install -m 644 integrations/docs-customers/commerce-agent.mjs integrations/docs-customers/sales-agent.mjs "$code/integrations/docs-customers/"
install -m 644 shared/docs-commerce.js shared/docs-sales.js shared/docs-customers.js "$code/shared/"
printf '{"type":"module"}\n' > "$code/package.json"
chmod 644 "$code/package.json"
install -d -m 700 -o "$source_uid" -g "$source_gid" "$root/state"
python3 - "$root" "$code" "$source_dir" "$orders_source" "$source_uid" "$source_gid" "$backup/candidate-compose.json" <<'PY'
import json,sys
root,code,source,orders,uid,gid,destination=sys.argv[1:]
service={
 'image':'node:24-bookworm-slim','user':uid+':'+gid,'restart':'unless-stopped',
 'command':['node','/connector/integrations/docs-customers/commerce-agent.mjs','/config/config.json'],
 'environment':{'NODE_OPTIONS':'--max-old-space-size=384'},
 'read_only':True,'cap_drop':['ALL'],'security_opt':['no-new-privileges:true'],
 'mem_limit':'512m','pids_limit':64,'stop_grace_period':'180s',
 'tmpfs':['/tmp:rw,noexec,nosuid,size=16m'],
 'volumes':[
  {'type':'bind','source':source,'target':'/source','read_only':True},
  {'type':'bind','source':orders,'target':'/orders','read_only':True},
  {'type':'bind','source':code,'target':'/connector','read_only':True},
  {'type':'bind','source':root+'/config.json','target':'/config/config.json','read_only':True},
  {'type':'bind','source':root+'/state','target':'/state'}],
 'logging':{'driver':'json-file','options':{'max-size':'5m','max-file':'2'}},
 'healthcheck':{'test':['CMD','node','-e',"const s=JSON.parse(require('fs').readFileSync('/state/status.json'));process.exit(Date.now()-Date.parse(s.checkedAt)<180000&&s.scanOk&&s.rejected===0&&!s.errorCode?0:1)"],'interval':'30s','timeout':'5s','start_period':'120s','retries':3}}
with open(destination,'x') as file: json.dump({'name':'boykovdocs-commerce-delivery','services':{'delivery':service}},file,indent=2)
PY
changed=0
recover() {
 result=$?
 if [[ "$result" != 0 ]]; then
  if [[ "$changed" == 1 ]]; then
   docker compose -f "$root/compose.json" stop delivery || true
   if [[ -f "$backup/compose.json" && -f "$backup/config.json" ]]; then
    cp -p "$backup/config.json" "$root/config.json"
    cp -p "$backup/compose.json" "$root/compose.json"
    docker compose -f "$root/compose.json" up -d --no-deps delivery || true
   fi
  fi
  printf 'DOCS_COMMERCE_CHECK_REQUIRED BACKUP=%s\n' "$backup"
 fi
}
trap recover EXIT
# Validate and pull before stopping a previous commerce collector. The website and customer collector stay running.
docker compose -f "$backup/candidate-compose.json" config --quiet
docker compose -f "$backup/candidate-compose.json" pull delivery
changed=1
if [[ -f "$root/compose.json" ]]; then docker compose -f "$root/compose.json" stop delivery; fi
python3 - "$root/state/delivery.sqlite" "$backup/delivery.sqlite" <<'BACKUP_QUEUE'
import sqlite3,sys,os
if os.path.isfile(sys.argv[1]):
 with sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True) as source, sqlite3.connect(sys.argv[2]) as destination:
  source.backup(destination)
 os.chmod(sys.argv[2],0o600)
BACKUP_QUEUE
install -m 600 -o "$source_uid" -g "$source_gid" "$backup/candidate-config.json" "$root/config.json"
install -m 600 "$backup/candidate-compose.json" "$root/compose.json"
compose=(docker compose -f "$root/compose.json")
"${compose[@]}" run --rm --no-deps delivery node /connector/integrations/docs-customers/commerce-agent.mjs /config/config.json --once
"${compose[@]}" up -d --no-deps --wait --wait-timeout 180 delivery
"${compose[@]}" ps
printf 'DOCS_COMMERCE_CONNECTION=OK\nDOCS_COMMERCE_DIRECTORY=%s\nBACKUP=%s\n' "$root" "$backup"
