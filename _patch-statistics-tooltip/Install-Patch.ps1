[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
try {
    $root = (Get-Location).Path
    $manifest = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
    if ($manifest.name -ne 'boykov-services') { throw 'Run this installer in the Boykov Services project root.' }
    if (!(Test-Path -LiteralPath (Join-Path $root 'src/pages/Statistics.tsx'))) { throw 'The statistics module is missing.' }
    $patch = Join-Path $PSScriptRoot 'statistics-tooltip.patch'
    $preference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & git apply --reverse --check -- $patch 2>$null
        $alreadyInstalled = ($LASTEXITCODE -eq 0)
    } finally { $ErrorActionPreference = $preference }
    if (!$alreadyInstalled) {
        & git apply --check -- $patch
        if ($LASTEXITCODE -ne 0) { throw 'The patch does not match this version (expected 465969f or compatible). No files were changed. Keep local work and send the error output.' }
        $backupBase = (& git rev-parse --git-path boykov-patch-backups).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Cannot locate Git backup directory.' }
        $backup = Join-Path $backupBase ('statistics-tooltip-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
        New-Item -ItemType Directory -Path $backup -Force | Out-Null
        foreach ($relative in (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'FILES.txt'))) {
            $source = Join-Path $root $relative
            if (Test-Path -LiteralPath $source) {
                $destination = Join-Path $backup $relative
                New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
                Copy-Item -LiteralPath $source -Destination $destination
            }
        }
        & git apply -- $patch
        if ($LASTEXITCODE -ne 0) { throw 'Could not apply the patch.' }
        Write-Host ('PATCH_BACKUP=' + $backup)
        Write-Host 'STATISTICS_TOOLTIP_PATCH=INSTALLED'
    } else { Write-Host 'STATISTICS_TOOLTIP_PATCH=ALREADY_INSTALLED' }
    if (!(Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24 and run npm ci and npm run check. The patch is installed.' }
    if (!(Test-Path -LiteralPath (Join-Path $root 'node_modules'))) {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. The patch is installed; retry after fixing dependencies.' }
    }
    & npm.cmd run check
    if ($LASTEXITCODE -ne 0) { throw 'Checks failed. Fix them before committing the patch.' }
    Write-Host 'PATCH_CHECK=OK'
    Write-Host 'Next: commit, push and deploy the Boykov Services app. See README.md.'
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
exit 0
