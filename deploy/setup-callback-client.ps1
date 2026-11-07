$ErrorActionPreference = 'Stop'
$clientRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../web/data/callback-client'))
$expected = '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343'
$url = 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.7/cloudflared-windows-amd64.exe'
New-Item -ItemType Directory -Path $clientRoot -Force | Out-Null
$callbackIdentity=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls $clientRoot /inheritance:r /grant:r "${callbackIdentity}:(OI)(CI)F" /Q | Out-Null
if($LASTEXITCODE -ne 0){throw 'Cannot protect callback client directory.'}
$exe=Join-Path $clientRoot 'cloudflared.exe'
if(-not(Test-Path -LiteralPath $exe)){
    $candidate=Join-Path $clientRoot 'cloudflared.exe.download'
    Invoke-WebRequest $url -OutFile $candidate
    if((Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected){throw 'Downloaded client checksum mismatch; not installed.'}
    Move-Item -LiteralPath $candidate -Destination $exe
}
if((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected){throw 'Official client checksum mismatch; not executed.'}
Write-Output 'Official Cloudflare client verified. No tunnel started by this installer.'
