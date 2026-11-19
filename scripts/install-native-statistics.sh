#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ "$EUID" == 0 ]] || { echo NATIVE_INSTALL_REQUIRES_ROOT; exit 1; }
kind=${1:-}
[[ "$kind" == accessibility || "$kind" == security ]] || { echo 'Usage: bash scripts/install-native-statistics.sh accessibility|security [VISITS_FILE LEADS_FILE]'; exit 2; }
export NATIVE_INSTALL_KIND="$kind" NATIVE_SOURCE_ROOT="$PWD"
export NATIVE_VISITS_OVERRIDE="${2:-}" NATIVE_LEADS_OVERRIDE="${3:-}"
python3 - <<'PY'
import os,json,subprocess,pathlib,pwd,re,shutil,datetime,sys
kind=os.environ['NATIVE_INSTALL_KIND'];source=pathlib.Path(os.environ['NATIVE_SOURCE_ROOT'])
sys.path.insert(0,str(source/'integrations/statistics'))
from source_config import read_env,security_paths
base=pathlib.Path('/opt/boykov-native-statistics-'+kind);base.mkdir(parents=True,exist_ok=True)
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+str(os.getpid())
backup=base/('backup-'+stamp);backup.mkdir(mode=0o700)
for name in ['config.json','compose.json','collector.service']:
 if (base/name).is_file():shutil.copy2(base/name,backup/name)
code=base/('code-'+stamp)
for relative in ['shared/statistics.js','integrations/statistics/agent.mjs','integrations/statistics/collect.mjs','integrations/statistics/security-bots.mjs']:
 target=code/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source/relative,target);target.chmod(0o644)
for d,_,_ in os.walk(code):os.chmod(d,0o755)
def inspect(name):return json.loads(subprocess.check_output(['docker','inspect',name],text=True))[0]
if kind=='accessibility':
 agent=inspect('boykov-leads-accessibility-delivery-1');app=inspect('accessibility-passport-app-1')
 env=dict(x.split('=',1) for x in agent['Config']['Env'] if '=' in x)
 mount=next((m for m in app['Mounts'] if m['Destination']=='/app/data'),None)
 if not mount:raise SystemExit('NATIVE_SITE_DATA_MOUNT_NOT_FOUND')
 uid=int(subprocess.check_output(['docker','exec',app['Id'],'id','-u'],text=True));gid=int(subprocess.check_output(['docker','exec',app['Id'],'id','-g'],text=True))
 config={'kind':kind,'host':'pasport-dostupnosty.ru','sourceFile':'/source/site.sqlite','stateDir':'/state','leadsEndpoint':env.get('LEADS_ENDPOINT'),'token':env.get('LEADS_TOKEN')}
 image=agent['Image']
else:
 env=read_env('/etc/boykov-leads-security.env',{'LEADS_ENDPOINT','LEADS_TOKEN'})
 socket=subprocess.check_output(['ss','-lntp','sport = :8787'],text=True)
 match=re.search(r'pid=(\d+)',socket)
 if not match:raise SystemExit('NATIVE_BACKEND_PROCESS_NOT_FOUND')
 pid=match[1];uid=pathlib.Path('/proc/'+pid).stat().st_uid;gid=pwd.getpwuid(uid).pw_gid;user=pwd.getpwuid(uid).pw_name
 live=dict(x.decode().split('=',1) for x in pathlib.Path('/proc/'+pid+'/environ').read_bytes().split(b'\0') if b'=' in x)
 cwd=os.readlink('/proc/'+pid+'/cwd')
 visits,leads=security_paths(cwd,live,os.environ.get('NATIVE_VISITS_OVERRIDE',''),os.environ.get('NATIVE_LEADS_OVERRIDE',''))
 if not visits.is_file() or not leads.is_file():
  print('NATIVE_VISITS_FILE='+str(visits));print('NATIVE_LEADS_FILE='+str(leads));raise SystemExit('NATIVE_SOURCE_FILE_NOT_FOUND: pass the actual VISITS_FILE and LEADS_FILE as arguments 2 and 3; no existing services changed.')
 config={'kind':kind,'host':'pasport-bezopasnosty.ru','sourceFile':str(visits),'leadsFile':str(leads),'stateDir':'/var/lib/boykov-native-statistics-security','leadsEndpoint':env.get('LEADS_ENDPOINT'),'token':env.get('LEADS_TOKEN')}
if not re.fullmatch(r'[a-f0-9]{64}',config.get('token') or '') or not re.fullmatch(r'https://[^/?#]+/hooks/leads/[A-Za-z0-9_-]+',config.get('leadsEndpoint') or ''):raise SystemExit('NATIVE_EXISTING_LEADS_CONNECTION_NOT_FOUND: no keys were changed.')
state=pathlib.Path(config['stateDir']) if kind=='security' else base/'state';state.mkdir(parents=True,exist_ok=True);state.chmod(0o700);os.chown(state,uid,gid)
file=base/'config.json';temporary=base/('.config-'+stamp);temporary.write_text(json.dumps(config));temporary.chmod(0o600);os.chown(temporary,uid,gid);temporary.replace(file)
if kind=='accessibility':
 compose={'name':'boykov-native-statistics-accessibility','services':{'collector':{'image':image,'pull_policy':'never','init':True,'restart':'unless-stopped','user':str(uid)+':'+str(gid),'read_only':True,'tmpfs':['/tmp'],'command':['node','/collector/integrations/statistics/agent.mjs','/config/config.json'],'volumes':[str(code)+':/collector:ro',str(file)+':/config/config.json:ro',mount['Source']+':/source:ro',str(state)+':/state'],'mem_limit':'256m','logging':{'driver':'json-file','options':{'max-size':'5m','max-file':'3'}},'healthcheck':{'test':['CMD','node','-e',"const f=require('node:fs');try{const s=JSON.parse(f.readFileSync('/state/status.json'));process.exit(s.ok&&Date.now()-Date.parse(s.generatedAt)<180000?0:1)}catch{process.exit(1)}"],'interval':'30s','timeout':'5s','start_period':'30s','retries':3}}}}
 (base/'compose.json').write_text(json.dumps(compose,indent=2))
else:
 node=shutil.which('node')
 if not node or int(subprocess.check_output([node,'-p','process.versions.node.split(".")[0]'],text=True))!=24:raise SystemExit('NATIVE_REQUIRES_NODE_24')
 unit='''[Unit]
Description=Native statistics for Security Passport
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=USER_VALUE
Group=GROUP_VALUE
UMask=0077
ExecStart=NODE_VALUE CODE_VALUE/integrations/statistics/agent.mjs CONFIG_VALUE
Restart=always
RestartSec=15
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=STATE_VALUE
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
MemoryMax=256M
[Install]
WantedBy=multi-user.target
'''
 for key,value in {'USER_VALUE':user,'GROUP_VALUE':str(gid),'NODE_VALUE':node,'CODE_VALUE':str(code),'CONFIG_VALUE':str(file),'STATE_VALUE':str(state)}.items():unit=unit.replace(key,value)
 (base/'collector.service').write_text(unit)
 (base/'node-path.txt').write_text(node)
 (base/'code-path.txt').write_text(str(code))
print('NATIVE_BACKUP='+str(backup))
PY
base="/opt/boykov-native-statistics-$kind"
if [[ "$kind" == accessibility ]]; then
  docker compose -f "$base/compose.json" run --rm --no-deps collector node /collector/integrations/statistics/agent.mjs /config/config.json --once
  docker compose -f "$base/compose.json" up -d --wait --wait-timeout 120
  docker compose -f "$base/compose.json" ps
else
  node_path=$(cat "$base/node-path.txt")
  code_path=$(cat "$base/code-path.txt")
  owner=$(stat -c %U "$base/config.json")
  runuser -u "$owner" -- "$node_path" "$code_path/integrations/statistics/agent.mjs" "$base/config.json" --once
  install -m 644 "$base/collector.service" /etc/systemd/system/boykov-native-statistics-security.service
  systemctl daemon-reload
  systemctl enable boykov-native-statistics-security.service
  systemctl restart boykov-native-statistics-security.service
  systemctl is-active boykov-native-statistics-security.service
fi
printf 'NATIVE_STATISTICS_CONNECTION=OK SOURCE=%s\n' "$kind"
