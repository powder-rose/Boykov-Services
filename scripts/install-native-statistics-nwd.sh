#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
private="${HOME}/.nwd-production/boykov-leads"
php_bin=/usr/local/bin/php7.3
[[ -f "$private/config.php" && -x "$php_bin" ]] || { echo NWD_EXISTING_CONNECTION_OR_PHP_NOT_FOUND; exit 1; }
version=$(mktemp -d "$private/statistics-code-XXXXXXXX")
chmod 700 "$version"
cp integrations/statistics/nwd.php integrations/statistics/run-nwd.php "$version/"
chmod 600 "$version/nwd.php" "$version/run-nwd.php"
"$php_bin" "$version/run-nwd.php" "$private/config.php"
printf 'NWD_STATISTICS_CRON_COMMAND=%s %s %s >>%s/statistics.log 2>&1\n' "$php_bin" "$version/run-nwd.php" "$private/config.php" "$private"
printf 'NWD_STATISTICS_CRON_INTERVAL=* * * * *\nNWD_STATISTICS_CONNECTION=OK\n'
