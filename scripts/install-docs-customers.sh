#!/usr/bin/env bash
# Run as root on the BoykovDocs server from an up-to-date Boykov-Services checkout.
set -Eeuo pipefail
umask 077
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ "$EUID" == 0 ]] || { echo DOCS_CONNECT_REQUIRES_ROOT; exit 1; }
for command in docker python3; do command -v "$command" >/dev/null || { echo "DOCS_CONNECT_MISSING=$command"; exit 1; }; done
docker compose version >/dev/null
[[ -f integrations/docs-customers/agent.mjs && -f shared/docs-customers.js ]] || { echo DOCS_CONNECT_SOURCE_MISSING; exit 1; }
source_dir=$(docker inspect boykovdocs-api --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}')
[[ "$source_dir" == /* && -f "$source_dir/users.json" ]] || { echo DOCS_SOURCE_DATA_NOT_FOUND; exit 1; }
source_uid=$(docker exec boykovdocs-api id -u)
source_gid=$(docker exec boykovdocs-api id -g)
[[ "$source_uid" =~ ^[0-9]+$ && "$source_gid" =~ ^[0-9]+$ ]] || exit 1
root=/opt/boykovdocs-customers-delivery
install -d -m 700 "$root"
backup=$(mktemp -d "$root/pre-connect-XXXXXXXX")
for file in config.json compose.json; do if [[ -f "$root/$file" ]]; then cp -p "$root/$file" "$backup/$file"; fi; done
# Prompt uses /dev/tty; key never appears in shell history, arguments or console output.
python3 - "$backup/new-config.json" <<'PY'
import sys,json,getpass,urllib.request,urllib.error,re,os
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args): return None
try:
 tty=open('/dev/tty','r+')
except OSError: raise SystemExit('DOCS_CONNECT_REQUIRES_INTERACTIVE_SSH_TERMINAL')
with tty: key=getpass.getpass('Вставьте ключ подключения BoykovDocs и нажмите Enter: ',stream=tty)
if not re.fullmatch('[a-f0-9]{64}',key): raise SystemExit('DOCS_CONNECTION_KEY_INVALID')
endpoint='https://boykov-services.ru/hooks/docs-customers'
request=urllib.request.Request(endpoint+'/handshake',data=b'{}',headers={'Content-Type':'application/json','Authorization':'Bearer '+key},method='POST')
try:
 with urllib.request.build_opener(NoRedirect).open(request,timeout=20) as response:
  result=json.load(response)
 if result.get('ok') is not True or result.get('source')!='boykovdocs.ru' or not result.get('since'): raise ValueError()
except Exception: raise SystemExit('DOCS_HUB_CONNECTION_FAILED: проверьте ключ и доступность Boykov Services')
with open(sys.argv[1],'x',encoding='utf-8') as file: json.dump({'endpoint':endpoint,'token':key,'since':result['since'],'sourceDir':'/source','stateDir':'/state'},file)
os.chmod(sys.argv[1],0o600)
print('DOCS_HUB_CONNECTION=OK')
PY
code=$(mktemp -d "$root/code-XXXXXXXX")
install -d -m 755 "$code/integrations/docs-customers" "$code/shared"
chmod 755 "$code"
install -m 644 integrations/docs-customers/agent.mjs "$code/integrations/docs-customers/agent.mjs"
install -m 644 shared/docs-customers.js "$code/shared/docs-customers.js"
# Explicit module type is required when this code runs outside the repository.
printf '{"type":"module"}\n' > "$code/package.json"
chmod 644 "$code/package.json"
install -d -m 700 -o "$source_uid" -g "$source_gid" "$root/state"
install -m 600 -o "$source_uid" -g "$source_gid" "$backup/new-config.json" "$root/config.json"
python3 - "$root" "$code" "$source_dir" "$source_uid" "$source_gid" <<'PY'
import json,sys
root,code,source,uid,gid=sys.argv[1:]
service={
 'image':'node:24-bookworm-slim','user':uid+':'+gid,'restart':'unless-stopped',
 'command':['node','/connector/integrations/docs-customers/agent.mjs','/config/config.json'],
 'read_only':True,'cap_drop':['ALL'],'security_opt':['no-new-privileges:true'],
 'mem_limit':'256m','pids_limit':64,'stop_grace_period':'180s',
 'tmpfs':['/tmp:rw,noexec,nosuid,size=16m'],
 'volumes':[
  {'type':'bind','source':source,'target':'/source','read_only':True},
  {'type':'bind','source':code,'target':'/connector','read_only':True},
  {'type':'bind','source':root+'/config.json','target':'/config/config.json','read_only':True},
  {'type':'bind','source':root+'/state','target':'/state'}],
 'logging':{'driver':'json-file','options':{'max-size':'5m','max-file':'2'}},
 'healthcheck':{'test':['CMD','node','-e',"const s=JSON.parse(require('fs').readFileSync('/state/status.json'));process.exit(Date.now()-Date.parse(s.checkedAt)<180000&&s.scanOk&&s.rejected===0?0:1)"],'interval':'30s','timeout':'5s','start_period':'120s','retries':3}}
with open(root+'/compose.json','w') as file: json.dump({'name':'boykovdocs-customers-delivery','services':{'delivery':service}},file,indent=2)
PY
# An existing delivery agent is stopped only after credentials and source are validated.
# Keep one writer to this queue. Source BoykovDocs containers are never restarted.
compose=(docker compose -f "$root/compose.json")
recover() {
  result=$?
  if [[ "$result" != 0 ]]; then
    if [[ -f "$backup/compose.json" && -f "$backup/config.json" ]]; then
      cp -p "$backup/config.json" "$root/config.json"
      cp -p "$backup/compose.json" "$root/compose.json"
      docker compose -f "$root/compose.json" up -d --no-deps delivery || true
    fi
    printf 'DOCS_CONNECT_CHECK_REQUIRED BACKUP=%s\n' "$backup"
  fi
}
trap recover EXIT
"${compose[@]}" pull delivery
"${compose[@]}" stop delivery

"${compose[@]}" run --rm --no-deps delivery node /connector/integrations/docs-customers/agent.mjs /config/config.json --once
"${compose[@]}" up -d --no-deps --wait --wait-timeout 180 delivery
"${compose[@]}" ps
printf 'DOCS_CUSTOMERS_CONNECTION=OK\nDOCS_AGENT_DIRECTORY=%s\nBACKUP=%s\n' "$root" "$backup"
