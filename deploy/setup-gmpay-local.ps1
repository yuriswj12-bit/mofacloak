# Windows x64: download the official pinned release, verify SHA256, configure loopback.
$ErrorActionPreference = 'Stop'
$gatewayRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../web/data/gmpay-local'))
$binaryDir = Join-Path $gatewayRoot 'bin'
$version = '2.0.0'
$asset = "epusdt-$version-windows-amd64.zip"
$releaseRoot = "https://github.com/GMWalletApp/epusdt/releases/download/v$version"
if (-not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'This setup supports Windows x64 only.' }
if (Test-Path -LiteralPath (Join-Path $gatewayRoot 'installation.json')) { Write-Output 'GM Pay already installed; no configuration overwritten.'; exit 0 }
New-Item -ItemType Directory -Path $gatewayRoot -Force | Out-Null
$gatewayIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls $gatewayRoot /inheritance:r /grant:r "${gatewayIdentity}:(OI)(CI)F" /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot protect local gateway directory.' }
$zip = Join-Path $gatewayRoot $asset
$checksums = Join-Path $gatewayRoot 'SHA256SUMS'
Invoke-WebRequest "$releaseRoot/SHA256SUMS" -OutFile $checksums
$line = Get-Content -LiteralPath $checksums | Where-Object { $_ -match "\s+\*?$([regex]::Escape($asset))$" }
if (@($line).Count -ne 1) { throw 'No unique official checksum found.' }
$expected = ($line -split '\s+')[0].ToLowerInvariant()
if ($expected -notmatch '^[a-f0-9]{64}$') { throw 'Invalid official checksum.' }
Invoke-WebRequest "$releaseRoot/$asset" -OutFile $zip
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Checksum mismatch. Nothing executed.' }
if (Test-Path -LiteralPath $binaryDir) { throw 'Binary directory already exists; inspect it rather than overwrite.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipHandle = [IO.Compression.ZipFile]::OpenRead($zip)
try {
    foreach ($entry in $zipHandle.Entries) {
        $entryTarget = [IO.Path]::GetFullPath((Join-Path $binaryDir $entry.FullName))
        if (-not $entryTarget.StartsWith($binaryDir + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe archive entry.' }
    }
} finally { $zipHandle.Dispose() }
Expand-Archive -LiteralPath $zip -DestinationPath $binaryDir
$executables = @(Get-ChildItem -LiteralPath $binaryDir -Filter epusdt.exe -Recurse -File)
if ($executables.Count -ne 1) { throw 'Expected exactly one epusdt.exe.' }
$configFile = Join-Path $gatewayRoot '.env'
if (Test-Path -LiteralPath $configFile) { throw 'Gateway config already exists. Nothing overwritten.' }
# Skipping the stock installer is intentional: v2.0.0's first-run installer binds :8000.
# The official bootstrap generates a genuine admin account and API key from this config.
$configText = @'
app_name=Magic Cloak Local Payment
app_uri=http://127.0.0.1:8000
log_level=info
http_access_log=false
sql_debug=false
http_listen=127.0.0.1:8000
static_path=/static
runtime_root_path=./runtime
log_save_path=./logs
log_max_size=16
log_max_age=7
max_backups=3
db_type=sqlite
sqlite_database_filename=./epusdt.db
sqlite_table_prefix=
runtime_sqlite_filename=epusdt-runtime.db
queue_concurrency=10
queue_poll_interval_ms=1000
callback_retry_base_seconds=5
order_expiration_time=10
order_notice_max_retry=5
api_rate_url=
install=false
'@
[IO.File]::WriteAllText($configFile, $configText, [Text.UTF8Encoding]::new($false))
$installation = @{version=$version;zipSha256=$expected;executable=$executables[0].FullName;executableSha256=(Get-FileHash -LiteralPath $executables[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
[IO.File]::WriteAllText((Join-Path $gatewayRoot 'installation.json'), ($installation | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Output "Verified official GM Pay $version and prepared loopback config. No wallet or transaction created."
