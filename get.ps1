# One-line installer (Windows PowerShell or PowerShell 7):
#   irm https://raw.githubusercontent.com/ospab/wusbfff/main/get.ps1 | iex
# Downloads the latest release (or the main branch if there is no release yet), installs the native host
# for the current user and leaves wusbfff.xpi in %LOCALAPPDATA%\wusbfff. No admin rights needed.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repo = 'ospab/wusbfff'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('wusbfff-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $tmp | Out-Null

try {
    $zipUrl = $null
    try {
        $rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'wusbfff-installer' }
        $zipUrl = ($rel.assets | Where-Object { $_.name -like '*-windows.zip' } | Select-Object -First 1).browser_download_url
    } catch { }
    if (-not $zipUrl) { $zipUrl = "https://github.com/$repo/archive/refs/heads/main.zip" }

    Write-Host "Downloading $zipUrl"
    $zip = Join-Path $tmp 'pkg.zip'
    Invoke-WebRequest $zipUrl -OutFile $zip -UseBasicParsing
    $src = Join-Path $tmp 'src'
    Expand-Archive $zip -DestinationPath $src -Force
    if (-not (Test-Path (Join-Path $src 'install.ps1'))) {
        $src = (Get-ChildItem $src -Directory | Select-Object -First 1).FullName  # GitHub archives have one wrapper folder
    }

    # No prebuilt xpi (main-branch download): zip the extension folder, with forward-slash entry names.
    $xpi = Join-Path $src 'wusbfff.xpi'
    if (-not (Test-Path $xpi)) {
        Add-Type -AssemblyName System.IO.Compression
        $ext = Join-Path $src 'extension'
        $fs = [IO.File]::Open($xpi, 'Create')
        $archive = New-Object IO.Compression.ZipArchive($fs, 'Create')
        Get-ChildItem $ext -Recurse -File | ForEach-Object {
            $entry = $archive.CreateEntry($_.FullName.Substring($ext.Length + 1).Replace('\', '/'), 'Optimal')
            $in = [IO.File]::OpenRead($_.FullName); $out = $entry.Open()
            $in.CopyTo($out); $out.Dispose(); $in.Dispose()
        }
        $archive.Dispose(); $fs.Dispose()
    }

    if ($env:WUSBFFF_DRY_RUN) {
        Write-Host "Dry run: package ready in $src (xpi: $(Test-Path $xpi)), install skipped."
    } else {
        & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File (Join-Path $src 'install.ps1')
        if ($LASTEXITCODE -ne 0) { throw 'install.ps1 failed.' }
    }
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
