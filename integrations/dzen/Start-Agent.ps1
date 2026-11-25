[CmdletBinding()]
param([ValidateSet('configure','login','run')][string]$Mode='run',[switch]$Headless)
$ErrorActionPreference = 'Stop'
$python = Join-Path $env:LOCALAPPDATA 'BoykovServicesDzen\venv\Scripts\python.exe'
if (!(Test-Path -LiteralPath $python)) { throw 'Run Install-Agent.ps1 first.' }
$arguments = @((Join-Path $PSScriptRoot 'agent.py'), $Mode)
if ($Headless -and $Mode -eq 'run') { $arguments += '--headless' }
& $python @arguments
exit $LASTEXITCODE
