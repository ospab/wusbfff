# SPDX-License-Identifier: AGPL-3.0-only
# Installs the wusbfff native host for the current user (no admin needed).
# Files go to %LOCALAPPDATA%\wusbfff, so this folder can be moved or deleted afterwards.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dest = Join-Path $env:LOCALAPPDATA 'wusbfff'
$hostDir = Join-Path $dest 'host'
$venv = Join-Path $dest 'venv'

New-Item -ItemType Directory -Force $hostDir | Out-Null
Copy-Item (Join-Path $root 'host\host.py'), (Join-Path $root 'host\requirements.txt') -Destination $hostDir -Force

# A real CPython 3 (not the Microsoft Store stub, not MSYS2/MinGW): the py launcher, else python.exe.
function Get-PythonCommand {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        & py -3 -c 'import sys' 2>$null
        if ($LASTEXITCODE -eq 0) { return @('py', '-3') }
    }
    $p = Get-Command python -ErrorAction SilentlyContinue
    if ($p -and $p.Source -notmatch 'WindowsApps') {
        & $p.Source -c 'import sys, sysconfig; sys.exit(1 if "mingw" in sysconfig.get_platform() else 0)' 2>$null
        if ($LASTEXITCODE -eq 0) { return @($p.Source) }
    }
    return $null
}

if (-not (Test-Path (Join-Path $venv 'Scripts\python.exe'))) {
    $pyCmd = Get-PythonCommand
    if (-not $pyCmd -and (Get-Command winget -ErrorAction SilentlyContinue)) {
        $answer = Read-Host 'Python 3 is required but was not found. Install it now with winget (current user, no admin)? [Y/n]'
        if ($answer -eq '' -or $answer -match '^[Yy]') {
            winget install --id Python.Python.3.12 -e --scope user --silent --accept-package-agreements --accept-source-agreements
            $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
            $pyCmd = Get-PythonCommand
        }
    }
    if (-not $pyCmd) { throw 'Python 3 is required. Install it from https://www.python.org/downloads/ and run this installer again.' }
    & $pyCmd[0] @($pyCmd | Select-Object -Skip 1) -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create a Python venv.' }
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
    allowed_extensions = @('wusbfff@wusbfff.ospab.org')
} | ConvertTo-Json
Set-Content -Path $manifest -Encoding ascii -Value $json

$key = 'HKCU:\Software\Mozilla\NativeMessagingHosts\wusbfff'
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value $manifest

Write-Host "Native host installed: $dest"

# Driver check: Meta Quest (2833) and Android (18D1) devices need a WinUSB-based driver to be usable.
$devs = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VID_(2833|18D1)&' })
if ($devs.Count -gt 0) {
    $winusb = @($devs | Where-Object {
        (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_Service' -ErrorAction SilentlyContinue).Data -eq 'WINUSB'
    })
    if ($winusb.Count -gt 0) {
        Write-Host 'Driver check: a Quest/Android device with a WinUSB driver is connected. Good.'
    } else {
        Write-Host 'Driver check: a Quest/Android device is connected but has no WinUSB driver.' -ForegroundColor Yellow
        Write-Host '  Install the Meta Quest ADB driver (https://developer.oculus.com/downloads/package/oculus-adb-drivers/)'
        Write-Host '  or the Google USB driver (https://developer.android.com/studio/run/win-usb), then reconnect the device.'
    }
} else {
    Write-Host 'Driver check: no Quest/Android device connected right now (connect it and see README.md if a site cannot open it).'
}
Write-Host 'If a site reports "Access denied": run "adb kill-server" and close Meta Quest Link (or stop the OVRService service).'

# Keep a copy of the add-on next to the host for sideloading (the source folder may be temporary).
$xpi = Get-ChildItem $root -Filter '*.xpi' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($xpi) {
    Copy-Item $xpi.FullName (Join-Path $dest 'wusbfff.xpi') -Force
    Write-Host "Sideload copy of the add-on: $(Join-Path $dest 'wusbfff.xpi') (unsigned builds need Firefox Developer Edition/Nightly)."
}
Write-Host 'Done. Go back to Firefox, open the wusbfff toolbar popup and press "Check again".'
