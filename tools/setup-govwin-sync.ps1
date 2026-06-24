<#
  One-time setup for the GovWin -> Atlas scheduled sync.
  - Installs the text-extraction deps OUTSIDE OneDrive (so OneDrive can't
    de-hydrate them and break PDF parsing).
  - Registers a Windows scheduled task that runs Mondays & Thursdays.
  Run from an ordinary (non-admin) PowerShell:  ./tools/setup-govwin-sync.ps1
#>
$ErrorActionPreference = 'Stop'

$deps = Join-Path $env:LOCALAPPDATA 'atlas-govwin-sync'
if (-not (Test-Path $deps)) { New-Item -ItemType Directory -Force $deps | Out-Null }
Push-Location $deps
if (-not (Test-Path (Join-Path $deps 'package.json'))) { npm init -y | Out-Null }
Write-Host "Installing extractors into $deps ..."
npm install pdf-parse@1.1.1 mammoth jszip xlsx | Out-Null
Pop-Location

$repo = Split-Path -Parent $PSScriptRoot      # tools\ -> repo root
$cmd  = Join-Path $repo 'tools\govwin-sync.cmd'
if (-not (Test-Path $cmd)) { throw "Runner not found: $cmd" }

$action  = New-ScheduledTaskAction -Execute $cmd
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Thursday -At 7am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName 'Atlas GovWin Sync' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Sync the local Govwin folder (index.csv + RFP/RFI docs) into Atlas. Mon & Thu.' -Force | Out-Null

Write-Host ''
Write-Host 'Done. Scheduled task "Atlas GovWin Sync" runs Mon & Thu at 7:00 AM.'
Write-Host 'Test it now with:  Start-ScheduledTask -TaskName "Atlas GovWin Sync"'
Write-Host 'Log:               %LOCALAPPDATA%\atlas-govwin-sync\sync.log'
