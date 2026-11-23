#!/usr/bin/env bash
# Independent host backup; includes the document jobs DB and version library.
set -Eeuo pipefail
umask 077
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ "$EUID" == 0 ]] || { echo TEMPLATE_BACKUP_REQUIRES_ROOT >&2; exit 1; }
mkdir -p /root/boykov-services-backups
backup=$(mktemp -d /root/boykov-services-backups/contract-templates-XXXXXXXX)
docker compose exec -T documents python - <<'PY' > "$backup/documents.zip"
from pathlib import Path
from tempfile import TemporaryDirectory
import os, sqlite3, sys, zipfile
root=Path('/app')
data=Path(os.getenv('CONTRACTS_DATA_DIR') or root / os.getenv('DATA_DIR','data') / 'contracts').resolve()
with TemporaryDirectory() as folder:
    work=Path(folder)
    for filename in ('jobs.sqlite','template-library.sqlite'):
        source=data/filename
        if not source.exists():
            if filename=='jobs.sqlite' or (data/'template-library.initialized').exists():
                raise RuntimeError('Required documents database missing')
            continue
        old=sqlite3.connect(source.as_uri()+'?mode=ro',uri=True,timeout=15)
        dst=sqlite3.connect(work/filename)
        try:
            old.backup(dst)
            if dst.execute('PRAGMA quick_check').fetchone()[0]!='ok':
                raise RuntimeError('Database backup integrity check failed')
        finally:
            dst.close()
            old.close()
    archive=work/'documents.zip'
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as out:
        for database in work.glob('*.sqlite'):
            out.write(database,'data/'+database.name)
        marker=data/'template-library.initialized'
        if marker.is_file(): out.write(marker,'data/'+marker.name)
        for path in (root/'worker/vendor/core').glob('*.docm'):
            out.write(path,'legacy/'+path.name)
    with archive.open('rb') as source:
        while chunk:=source.read(1024*1024):
            sys.stdout.buffer.write(chunk)
PY
python3 - "$backup/documents.zip" <<'PY'
from zipfile import ZipFile
import sys
with ZipFile(sys.argv[1]) as archive:
    if archive.testzip() or 'data/jobs.sqlite' not in archive.namelist() or len([n for n in archive.namelist() if n.startswith('legacy/') and n.endswith('.docm')])!=6:
        raise SystemExit('TEMPLATE_BACKUP_INCOMPLETE')
PY
printf 'BACKUP=%s\n' "$backup"
