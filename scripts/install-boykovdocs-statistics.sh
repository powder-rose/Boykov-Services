#!/usr/bin/env bash
# Run only on the BoykovDocs VPS. Do not restart the website or other collectors.
set -Eeuo pipefail
umask 077
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ "$EUID" == 0 ]] || { echo BOYKOVDOCS_STATISTICS_REQUIRES_ROOT; exit 1; }
docker compose version >/dev/null
existing_config=/opt/boykovdocs-customers-delivery/config.json
[[ -f "$existing_config" ]] || { echo BOYKOVDOCS_CONNECT_CUSTOMERS_FIRST; exit 1; }
source_dir=$(docker inspect boykovdocs-api --format '{{range .Mounts}}{{if eq .Destination "/app/src/data"}}{{.Source}}{{end}}{{end}}')
[[ "$source_dir" == /* && -f "$source_dir/analytics/visitor-events.jsonl" ]] || { echo BOYKOVDOCS_VISITOR_JOURNAL_NOT_FOUND; exit 1; }
source_uid=$(docker exec boykovdocs-api id -u)
source_gid=$(docker exec boykovdocs-api id -g)
[[ "$source_uid" =~ ^[0-9]+$ && "$source_gid" =~ ^[0-9]+$ ]] || exit 1
root=/opt/boykovdocs-statistics-delivery
install -d -m 700 "$root"
backup=$(mktemp -d "$root/pre-connect-XXXXXXXX")
for file in config.json compose.json; do
  if [[ -f "$root/$file" ]]; then cp -p "$root/$file" "$backup/$file"; fi
done
python3 - "$existing_config" "$backup/candidate-config.json" <<'PY'
import json,sys,re,urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args): return None
try:
 with open(sys.argv[1],encoding='utf-8') as file: old=json.load(file)
 if old['endpoint']!='https://boykov-services.ru/hooks/docs-customers': raise ValueError()
 key=old['token']
 if not re.fullmatch('[a-f0-9]{64}',key): raise ValueError()
 endpoint=old['endpoint']+'/statistics'
 request=urllib.request.Request(endpoint+'/handshake',data=b'{}',headers={'Content-Type':'application/json','Authorization':'Bearer '+key},method='POST')
 with urllib.request.build_opener(NoRedirect).open(request,timeout=20) as response: result=json.load(response)
 if result!={'ok':True,'source':'boykovdocs-statistics','protocol':1,'scope':'traffic'}: raise ValueError()
 with open(sys.argv[2],'x',encoding='utf-8') as file: json.dump({'endpoint':endpoint,'token':key,'sourceDir':'/source','stateDir':'/state'},file)
except Exception: raise SystemExit('BOYKOVDOCS_STATISTICS_HUB_CHECK_FAILED')
print('BOYKOVDOCS_STATISTICS_HUB=OK')
PY
code=$(mktemp -d "$root/code-XXXXXXXX")
chmod 755 "$code"
install -d -m 755 "$code/integrations/statistics" "$code/shared"
install -m 644 integrations/statistics/boykovdocs-agent.mjs "$code/integrations/statistics/"
install -m 644 shared/statistics.js "$code/shared/"
printf '{"type":"module"}\n' > "$code/package.json"
chmod 644 "$code/package.json"
install -d -m 700 -o "$source_uid" -g "$source_gid" "$root/state"
python3 - "$root" "$code" "$source_dir/analytics" "$source_uid" "$source_gid" "$backup/candidate-compose.json" <<'PY'
import json,sys
root,code,source,uid,gid,destination=sys.argv[1:]
service={
 'image':'node:24-bookworm-slim','user':uid+':'+gid,'restart':'unless-stopped',
 'command':['node','/connector/integrations/statistics/boykovdocs-agent.mjs','/config/config.json'],
 'environment':{'NODE_OPTIONS':'--max-old-space-size=384'},
 'read_only':True,'cap_drop':['ALL'],'security_opt':['no-new-privileges:true'],
 'mem_limit':'512m','pids_limit':64,'stop_grace_period':'30s',
 'tmpfs':['/tmp:rw,noexec,nosuid,size=16m'],
 'volumes':[
  {'type':'bind','source':source,'target':'/source','read_only':True},
  {'type':'bind','source':code,'target':'/connector','read_only':True},
  {'type':'bind','source':root+'/config.json','target':'/config/config.json','read_only':True},
  {'type':'bind','source':root+'/state','target':'/state'}],
 'logging':{'driver':'json-file','options':{'max-size':'2m','max-file':'2'}},
 'healthcheck':{'test':['CMD','node','-e',"const s=JSON.parse(require('fs').readFileSync('/state/status.json'));process.exit(s.ok&&Date.now()-Date.parse(s.generatedAt)<180000?0:1)"],'interval':'30s','timeout':'5s','start_period':'90s','retries':3}}
with open(destination,'x') as file: json.dump({'name':'boykovdocs-statistics-delivery','services':{'delivery':service}},file,indent=2)
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
    printf 'BOYKOVDOCS_STATISTICS_CHECK_REQUIRED BACKUP=%s\n' "$backup"
  fi
}
trap recover EXIT
docker compose -f "$backup/candidate-compose.json" config --quiet
docker compose -f "$backup/candidate-compose.json" pull delivery
changed=1
if [[ -f "$root/compose.json" ]]; then docker compose -f "$root/compose.json" stop delivery; fi
for file in last-packet.json status.json; do
  if [[ -f "$root/state/$file" ]]; then cp -p "$root/state/$file" "$backup/$file"; fi
done
install -m 600 -o "$source_uid" -g "$source_gid" "$backup/candidate-config.json" "$root/config.json"
install -m 600 "$backup/candidate-compose.json" "$root/compose.json"
compose=(docker compose -f "$root/compose.json")
"${compose[@]}" run --rm --no-deps delivery node /connector/integrations/statistics/boykovdocs-agent.mjs /config/config.json --once
"${compose[@]}" up -d --no-deps --wait --wait-timeout 150 delivery
"${compose[@]}" ps
printf 'BOYKOVDOCS_STATISTICS_CONNECTION=OK\nBACKUP=%s\n' "$backup"
