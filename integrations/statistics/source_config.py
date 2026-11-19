"""Read only the source paths needed by the native statistics installer."""
import pathlib
import re
import shlex


def read_env(file, names):
    result = {}
    for line in pathlib.Path(file).read_text().splitlines():
        match = re.match(r'\s*(?:export\s+)?([A-Z_0-9]+)\s*=\s*(.*)$', line)
        if not match or match[1] not in names:
            continue
        values = shlex.split(match[2], comments=True, posix=True)
        if len(values) != 1:
            if not values:
                result[match[1]] = ''
                continue
            raise ValueError('NATIVE_SOURCE_CONFIGURATION_INVALID')
        result[match[1]] = values[0]
    return result


def security_paths(cwd, live, visits_override='', leads_override=''):
    cwd = pathlib.Path(cwd)
    env_file = pathlib.Path(live.get('SERVER_ENV_FILE') or '.env.server')
    if not env_file.is_absolute():
        env_file = cwd / env_file
    values = read_env(env_file, {'PASSPORT_PROJECT_ROOT', 'VISITS_FILE', 'LEADS_FILE'})
    values.update(live)  # Match dotenv: process-level variables take precedence.
    root = pathlib.Path(values.get('PASSPORT_PROJECT_ROOT', '').strip() or cwd)
    if not root.is_absolute():
        root = cwd / root
    visits = pathlib.Path(visits_override or values.get('VISITS_FILE') or 'data/visits.jsonl')
    leads = pathlib.Path(leads_override or values.get('LEADS_FILE') or 'data/leads.jsonl')
    if not visits.is_absolute():
        visits = root / visits
    if not leads.is_absolute():
        leads = root / leads
    return visits.resolve(), leads.resolve()
