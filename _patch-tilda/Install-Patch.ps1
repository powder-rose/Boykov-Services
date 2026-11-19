[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
try {
    $root = (Get-Location).Path
    $manifestPath = Join-Path $root 'package.json'
    if (!(Test-Path -LiteralPath $manifestPath)) { throw 'Run this script in the Boykov Services project root.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.name -ne 'boykov-services') { throw 'This is not the Boykov Services project.' }
    & git rev-parse --show-toplevel | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Git repository is required.' }
    $patch = Join-Path $PSScriptRoot 'boykovgroup-tilda.patch'
    if (!(Test-Path -LiteralPath $patch)) { throw 'The patch file is missing.' }
    $preference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & git apply --reverse --check -- $patch 2>$null
        $alreadyInstalled = ($LASTEXITCODE -eq 0)
    } finally {
        $ErrorActionPreference = $preference
    }
    if ($alreadyInstalled) {
        Write-Host 'PATCH_ALREADY_INSTALLED'
        exit 0
    }
    & git apply --check -- $patch
    if ($LASTEXITCODE -ne 0) { throw 'Patch does not match local files. No files were changed.' }
    $backupBase = (& git rev-parse --git-path boykov-patch-backups).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot locate patch backup directory.' }
    $backup = Join-Path $backupBase ('tilda-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    $paths = @(
        'docs/LEADS.md', 'docs/TILDA.md', 'scripts/deploy-tilda.sh',
        'server/app.js', 'server/modules/leads/index.js', 'server/modules/leads/tilda.js',
        'src/pages/Leads.tsx', 'src/pages/Leads.css', 'tests/leads-tilda.test.js'
    )
    foreach ($relative in $paths) {
        $source = Join-Path $root $relative
        if (Test-Path -LiteralPath $source) {
            $destination = Join-Path $backup $relative
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath $source -Destination $destination
        }
    }
    & git apply -- $patch
    if ($LASTEXITCODE -ne 0) { throw 'Patch could not be applied.' }
    Write-Host ('PATCH_BACKUP=' + $backup)
    Write-Host 'PATCH_INSTALLED'
    if (!(Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24, then run npm ci and npm run check. The patch is installed.' }
    if (!(Test-Path -LiteralPath (Join-Path $root 'node_modules'))) {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. The patch is installed; run it again after fixing dependencies.' }
    }
    & npm.cmd run check
    if ($LASTEXITCODE -ne 0) { throw 'Checks failed. Do not deploy until npm run check passes.' }
    Write-Host 'PATCH_CHECK=OK'
    Write-Host 'Commit and push the nine patch files, then follow docs/TILDA.md.'
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
exit 0
