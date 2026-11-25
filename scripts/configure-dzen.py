"""Interactive configuration; only the three Dzen-specific values are written."""
import argparse
import getpass
import os
import re
import secrets
from pathlib import Path
from datetime import datetime, timezone
import shutil

ROOT = Path(__file__).resolve().parents[1]
KEYS = ('DZEN_AGENT_TOKEN', 'DZEN_YANDEX_FOLDER_ID', 'DZEN_YANDEX_API_KEY')


def read_values(path, keys):
    found = {}
    if path and path.is_file():
        for line in path.read_text(encoding='utf-8-sig').splitlines():
            key, sep, value = line.partition('=')
            if sep and key.strip() in keys:
                found[key.strip()] = value.strip().strip('"\'')
    return found


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--legacy-env', type=Path, help='Optional local path to recovered Zenbot env (YC_FOLDER_ID and YC_API_KEY only)')
    args = parser.parse_args()
    if not (ROOT / 'server/modules/dzen/index.js').is_file():
        raise SystemExit('DZEN_SOURCE_MISSING')
    path = ROOT / '.env.dzen'
    old = read_values(path, KEYS)
    if args.legacy_env and not args.legacy_env.is_file():
        raise SystemExit('LEGACY_ENV_NOT_FOUND')
    legacy = read_values(args.legacy_env, ('YC_FOLDER_ID','YC_API_KEY'))
    folder = legacy.get('YC_FOLDER_ID') or input('Yandex Cloud folder ID (Enter — сохранить текущий / оставить пустым): ').strip() or old.get(KEYS[1], '')
    key = legacy.get('YC_API_KEY') or getpass.getpass('YandexGPT API key (ввод скрыт; Enter — сохранить текущий / оставить пустым): ').strip() or old.get(KEYS[2], '')
    token = old.get(KEYS[0]) or secrets.token_hex(32)
    if len(token) < 32:
        raise SystemExit('EXISTING_AGENT_TOKEN_INVALID: исправьте существующий ключ вручную, не публикуйте его')
    if not all(re.fullmatch(r'[A-Za-z0-9_.-]*', value) for value in (token, folder, key)) or bool(folder) != bool(key):
        raise SystemExit('DZEN_CONFIG_INVALID: задайте оба ключа YandexGPT или оставьте оба пустыми; файл не изменён')
    if path.exists():
        # Private backup in an ignored data folder; no secret enters Git.
        directory = ROOT / 'data' / 'dzen-config-backups'
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if os.name != 'nt': directory.chmod(0o700)
        backup = directory / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S') + '-' + secrets.token_hex(4) + '.env')
        shutil.copyfile(path, backup)
        if os.name != 'nt': backup.chmod(0o600)
    temp = ROOT / ('.env.dzen.tmp-' + secrets.token_hex(4))
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as file:
        for name, value in zip(KEYS, (token, folder, key)):
            file.write(f'{name}={value}\n')
    os.replace(temp, path)
    print('DZEN_CONFIG=OK')
    print('DZEN_AI_CONFIGURED=' + ('YES' if key else 'NO'))
    print('Ключ агента для локальной настройки (не отправляйте в чат):')
    print(token)


if __name__ == '__main__':
    main()
