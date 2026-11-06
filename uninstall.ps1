Remove-Item -Path 'HKCU:\Software\Mozilla\NativeMessagingHosts\wusbfff' -ErrorAction SilentlyContinue
$dest = Join-Path $env:LOCALAPPDATA 'wusbfff'
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
Write-Host 'wusbfff native host removed. Remove the add-on from about:addons if you no longer need it.'
