[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'BoykovServicesDzen'
$venv = Join-Path $root 'venv'
$python = Join-Path $venv 'Scripts\python.exe'
if (!(Test-Path -LiteralPath $python)) {
    if (Get-Command py -ErrorAction SilentlyContinue) { & py -3.12 -m venv $venv }
    else { & python -m venv $venv }
    if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.12, then retry.' }
}
& $python -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Python dependencies were not installed.' }
& $python -m playwright install chromium
if ($LASTEXITCODE -ne 0) { throw 'Chromium installation failed.' }
Write-Host 'DZEN_AGENT_INSTALL=OK'
Write-Host 'Next: run Start-Agent.ps1 -Mode configure, then -Mode login, then -Mode run.'
