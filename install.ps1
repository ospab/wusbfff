# Installs the wusbfff native host for the current user (no admin needed).
# Files go to %LOCALAPPDATA%\wusbfff, so this folder can be moved or deleted afterwards.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dest = Join-Path $env:LOCALAPPDATA 'wusbfff'
$hostDir = Join-Path $dest 'host'
$venv = Join-Path $dest 'venv'

New-Item -ItemType Directory -Force $hostDir | Out-Null
Copy-Item (Join-Path $root 'host\host.py'), (Join-Path $root 'host\requirements.txt') -Destination $hostDir -Force

if (-not (Test-Path (Join-Path $venv 'Scripts\python.exe'))) {
    if (Get-Command py -ErrorAction SilentlyContinue) { & py -3 -m venv $venv }
    else { & python -m venv $venv }
    if ($LASTEXITCODE -ne 0) { throw 'Could not create a Python venv. Install Python 3 from python.org (with the py launcher).' }
}
$python = Join-Path $venv 'Scripts\python.exe'
& $python -m pip install --quiet --disable-pip-version-check -r (Join-Path $hostDir 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'pip install failed.' }

$bat = Join-Path $dest 'wusbfff.bat'
Set-Content -Path $bat -Encoding ascii -Value "@echo off`r`n`"$python`" -u `"$(Join-Path $hostDir 'host.py')`""

$manifest = Join-Path $dest 'wusbfff.json'
$json = [ordered]@{
    name = 'wusbfff'
    description = 'wusbfff: WebUSB for Firefox native host'
    path = $bat
    type = 'stdio'
    allowed_extensions = @('wusbfff@local')
} | ConvertTo-Json
Set-Content -Path $manifest -Encoding ascii -Value $json

$key = 'HKCU:\Software\Mozilla\NativeMessagingHosts\wusbfff'
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value $manifest

Write-Host "Native host installed: $dest"
$xpi = Get-ChildItem $root -Filter '*.xpi' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($xpi) {
    # Keep a copy next to the host: the source folder may be temporary (one-line installer).
    Copy-Item $xpi.FullName (Join-Path $dest 'wusbfff.xpi') -Force
    Write-Host "Next: open $(Join-Path $dest 'wusbfff.xpi') in Firefox (or drag it onto a Firefox window)."
    Write-Host 'Release Firefox only installs SIGNED add-ons. See README.md ("Keeping it installed").'
} else {
    Write-Host 'Next: Firefox -> about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> extension\manifest.json'
}
