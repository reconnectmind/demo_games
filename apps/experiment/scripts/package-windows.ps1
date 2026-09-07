param(
  [string]$Version = "0.1.0",
  [string]$RuntimeUrl = "https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/1424552f-1033-46d3-a1ea-26c879f4262b/Microsoft.WebView2.FixedVersionRuntime.151.0.4129.93.x64.cab"
)

$ErrorActionPreference = "Stop"
$App = Split-Path -Parent $PSScriptRoot
$Root = (Resolve-Path (Join-Path $App "../..")).Path
$Build = Join-Path $App "build"
$Stage = Join-Path $Build "windows-x64/Reconnect Experiment"
$Archive = Join-Path $Build "Reconnect-Experiment-$Version-windows-x64.zip"
$TempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$Cab = Join-Path $TempRoot "Microsoft.WebView2.FixedVersionRuntime.151.0.4129.93.x64.cab"
$Extract = Join-Path $TempRoot "webview2-fixed"

Remove-Item (Split-Path -Parent $Stage) -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $Archive -Force -ErrorAction SilentlyContinue
Remove-Item $Extract -Recurse -Force -ErrorAction SilentlyContinue
New-Item $Stage -ItemType Directory -Force | Out-Null
New-Item (Join-Path $Stage "protocols") -ItemType Directory -Force | Out-Null
New-Item (Join-Path $Stage "data") -ItemType Directory -Force | Out-Null
New-Item $Extract -ItemType Directory -Force | Out-Null

$Executable = @(
  (Join-Path $App "src-tauri/target/x86_64-pc-windows-msvc/release/reconnect-experiment.exe"),
  (Join-Path $App "src-tauri/target/release/reconnect-experiment.exe")
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (!$Executable) {
  throw "Windows release executable not found under src-tauri/target"
}
Copy-Item $Executable (Join-Path $Stage "Reconnect Experiment.exe")
Copy-Item (Join-Path $Root "packages/protocol/examples/reconnect-pilot.json") (Join-Path $Stage "protocols/reconnect-pilot.json")
Copy-Item (Join-Path $App "README.txt") (Join-Path $Stage "README.txt")

if (!(Test-Path $Cab)) {
  Invoke-WebRequest -Uri $RuntimeUrl -OutFile $Cab
}
& expand.exe $Cab -F:* $Extract | Out-Null
$RuntimeExe = Get-ChildItem $Extract -Recurse -Filter "msedgewebview2.exe" | Select-Object -First 1
if (!$RuntimeExe) {
  throw "Fixed WebView2 archive does not contain msedgewebview2.exe"
}
$RuntimeRoot = Split-Path -Parent $RuntimeExe.FullName
Copy-Item $RuntimeRoot (Join-Path $Stage "webview2") -Recurse
(Get-FileHash $Cab -Algorithm SHA256).Hash | Set-Content (Join-Path $Stage "WEBVIEW2-SHA256.txt")

& (Join-Path $Stage "Reconnect Experiment.exe") --self-test
if ($LASTEXITCODE -ne 0) {
  throw "Packaged self-test failed with exit code $LASTEXITCODE"
}
$SmokeManifest = Get-ChildItem (Join-Path $Stage "data/packaged-smoke") -Recurse -Filter "session.json" | Select-Object -First 1
if (!$SmokeManifest) {
  throw "Packaged self-test did not create session.json"
}
$Manifest = Get-Content $SmokeManifest.FullName -Raw | ConvertFrom-Json
if ($Manifest.status -ne "completed" -or $Manifest.markers -ne 1) {
  throw "Packaged self-test manifest is incomplete"
}
Remove-Item (Join-Path $Stage "data/packaged-smoke") -Recurse -Force

Compress-Archive -Path $Stage -DestinationPath $Archive -CompressionLevel Optimal
Write-Output $Archive
