# Builds dist\wusbfff-<version>.xpi and dist\wusbfff-<version>-windows.zip (xpi + host + installer + tester).
#   .\package.ps1          unsigned build
#   .\package.ps1 -Sign    also signs the xpi on addons.mozilla.org (unlisted, free);
#                          needs WEB_EXT_API_KEY and WEB_EXT_API_SECRET (AMO > Tools > Manage API Keys)
param([switch]$Sign)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$ext = Join-Path $root 'extension'
$ver = (Get-Content (Join-Path $ext 'manifest.json') -Raw | ConvertFrom-Json).version
$dist = Join-Path $root 'dist'
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory $dist | Out-Null
Add-Type -AssemblyName System.IO.Compression

# entries: ordered map of zip entry name (forward slashes) -> source file
function New-Zip([string]$path, $entries) {
    $fs = [IO.File]::Open($path, 'Create')
    $zip = New-Object IO.Compression.ZipArchive($fs, 'Create')
    foreach ($name in $entries.Keys) {
        $entry = $zip.CreateEntry($name, 'Optimal')
        $in = [IO.File]::OpenRead($entries[$name])
        $out = $entry.Open()
        $in.CopyTo($out)
        $out.Dispose(); $in.Dispose()
    }
    $zip.Dispose(); $fs.Dispose()
}

$files = [ordered]@{}
Get-ChildItem $ext -Recurse -File | Sort-Object FullName | ForEach-Object {
    $files[$_.FullName.Substring($ext.Length + 1).Replace('\', '/')] = $_.FullName
}
$xpi = Join-Path $dist "wusbfff-$ver.xpi"
New-Zip $xpi $files
Write-Host "Built $xpi"

if ($Sign) {
    if (-not $env:WEB_EXT_API_KEY -or -not $env:WEB_EXT_API_SECRET) { throw 'Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET first.' }
    npx --yes web-ext sign --source-dir $ext --artifacts-dir (Join-Path $dist 'signed') --channel unlisted `
        --api-key $env:WEB_EXT_API_KEY --api-secret $env:WEB_EXT_API_SECRET
    if ($LASTEXITCODE -ne 0) { throw 'web-ext sign failed.' }
    $signed = Get-ChildItem (Join-Path $dist 'signed') -Filter '*.xpi' | Select-Object -First 1
    if (-not $signed) { throw 'No signed xpi was produced.' }
    $xpi = $signed.FullName
    Write-Host "Signed: $xpi"
}

$bundle = [ordered]@{
    'wusbfff.xpi'           = $xpi
    'host/host.py'          = Join-Path $root 'host\host.py'
    'host/requirements.txt' = Join-Path $root 'host\requirements.txt'
    'install.ps1'           = Join-Path $root 'install.ps1'
    'uninstall.ps1'         = Join-Path $root 'uninstall.ps1'
    'README.md'             = Join-Path $root 'README.md'
    'tester/index.html'     = Join-Path $root 'tester\index.html'
}
$zipPath = Join-Path $dist "wusbfff-$ver-windows.zip"
New-Zip $zipPath $bundle
Write-Host "Built $zipPath"
