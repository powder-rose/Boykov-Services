#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ "$EUID" == 0 && "$PWD" == /opt/boykov-services ]] || { echo 'DZEN_SERVER_SETUP_REQUIRES_PROJECT_ROOT'; exit 1; }
[[ -f .env.dzen && -f integrations/dzen/server/compose.yaml ]] || { echo 'DZEN_SERVER_SOURCE_MISSING'; exit 1; }
mem_total=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
mem_available=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
disk_available=$(df -Pk /var/lib/docker | awk 'NR==2{print $4}')
if (( mem_total < 1800000 || mem_available < 800000 || disk_available < 6000000 || $(nproc) < 2 )); then
  echo 'DZEN_SERVER_RESOURCES_INSUFFICIENT (need 2GB RAM, 800MB available, 6GB free Docker disk, 2 CPU)'
  exit 1
fi
compose_file=integrations/dzen/server/compose.yaml
profile_file="$PWD/integrations/dzen/server/seccomp_profile.json"
studio_url=$(docker compose exec -T app node --input-type=module - <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync('/app/data/platform.sqlite',{readOnly:true});
try {
  const mode=JSON.parse(db.prepare('SELECT data FROM dzen_settings WHERE id=1').get().data).mode;
  const active=db.prepare("SELECT count(*) n FROM dzen_tasks WHERE phase IN ('leased','begun')").get().n;
  const source=db.prepare('SELECT studio_url FROM dzen_runtime WHERE id=1').get().studio_url;
  if(mode!=='paused'||active||!source)throw Error('DZEN_SERVER_HANDOVER_REQUIRES_PAUSE_AND_NO_ACTIVE_TASKS');
  console.log(source);
}finally{db.close();}
NODE
)
if [[ -n "$(docker compose -f "$compose_file" ps --status running -q 2>/dev/null)" ]]; then
  echo 'DZEN_SERVER_STOP_EXISTING_AGENT_FIRST'; exit 1
fi
public_author=${1:-https://dzen.ru/specons}
if [[ ! -s "$profile_file" ]]; then
  temporary=$(mktemp "$PWD/integrations/dzen/server/seccomp-XXXXXX")
  trap 'rm -f -- "$temporary"' EXIT
  curl --fail --location --proto '=https' --tlsv1.2 --max-time 45 --silent --show-error \
    https://raw.githubusercontent.com/microsoft/playwright/v1.64.1/utils/docker/seccomp_profile.json -o "$temporary"
  python3 - "$temporary" <<'PY'
import json,sys
with open(sys.argv[1]) as f: profile=json.load(f)
if profile.get('defaultAction') != 'SCMP_ACT_ERRNO' or not isinstance(profile.get('syscalls'),list):
    raise SystemExit('DZEN_SERVER_SECCOMP_INVALID')
PY
  mv -- "$temporary" "$profile_file"
  trap - EXIT
fi
docker compose -f "$compose_file" build agent
docker compose -f "$compose_file" run --rm -T --no-deps agent python /app/server_agent.py self-test
python3 - "$studio_url" "$public_author" <<'PY' | docker compose -f "$compose_file" run --rm -T --no-deps agent python /app/server_agent.py configure-stdin
import json,sys
from pathlib import Path
token=''
for line in Path('.env.dzen').read_text(encoding='utf-8-sig').splitlines():
    key,sep,value=line.partition('=')
    if sep and key.strip()=='DZEN_AGENT_TOKEN': token=value.strip().strip('"\'')
if len(token)<32: raise SystemExit('DZEN_AGENT_TOKEN_MISSING')
print(json.dumps({'hub':'https://boykov-services.ru','studioUrl':sys.argv[1],'publicAuthorUrl':sys.argv[2],'token':token}))
PY
echo 'DZEN_SERVER_SETUP=OK'
echo 'Next: open an SSH tunnel, then run the temporary login service.'
