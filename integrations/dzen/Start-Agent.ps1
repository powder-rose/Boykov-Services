[CmdletBinding()]
param([ValidateSet('configure','login','run','public-author')][string]$Mode='run',[switch]$Headless,[string]$PublicAuthorUrl)
$ErrorActionPreference = 'Stop'
$python = Join-Path $env:LOCALAPPDATA 'BoykovServicesDzen\venv\Scripts\python.exe'
if (!(Test-Path -LiteralPath $python)) { throw 'Run Install-Agent.ps1 first.' }
$arguments = @((Join-Path $PSScriptRoot 'agent.py'), $Mode)
if ($Headless -and $Mode -eq 'run') { $arguments += '--headless' }
if ($PublicAuthorUrl -and $Mode -eq 'public-author') { $arguments += @('--public-author-url',$PublicAuthorUrl) }
& $python @arguments
exit $LASTEXITCODE
