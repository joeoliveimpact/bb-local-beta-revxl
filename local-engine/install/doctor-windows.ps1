# Booking Bandit Local Claude Engine - doctor. Read-only diagnosis of the full
# native-messaging chain (this is the "bb-doctor" the extension's error messages
# reference). Run from anywhere:
#
#   powershell -ExecutionPolicy Bypass -File install\doctor-windows.ps1
#   ... -Ping          also does a framed ping through the INSTALLED host
#   ... -Browser chrome  limit the registry check to one browser
#
# Prints PASS/FAIL per check + a summary. Never changes anything (the one
# exception: it OFFERS a full browser kill on Y/N when a stale-cache risk exists).

param(
  [ValidateSet('all', 'chrome', 'comet', 'edge', 'chromium')]
  [string]$Browser = 'all',
  [string]$ExtensionId = 'eoaibojoneilhiagjmmhbbgehnmloelj',
  [switch]$Ping
)

$HostName = 'com.bookingbandit.localengine'
$InstallDir = Join-Path $env:LOCALAPPDATA 'BookingBandit'
$SrcDir = Split-Path -Parent $PSScriptRoot   # ...\local-engine
$script:fails = 0

function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { Write-Host ("  PASS  {0}" -f $name) -ForegroundColor Green }
  else { $script:fails++; Write-Host ("  FAIL  {0}{1}" -f $name, $(if ($detail) { " ... $detail" } else { '' })) -ForegroundColor Red }
}

Write-Host "Booking Bandit local-engine doctor" -ForegroundColor Cyan
Write-Host ""

# --- 1. Node ---
$node = Get-Command node -ErrorAction SilentlyContinue
Check "node on PATH" ($null -ne $node) "install Node >= 18"
if ($node) {
  $nodeVer = (& node --version) -replace '^v', ''
  Check "node version >= 18 ($nodeVer)" ([int]($nodeVer.Split('.')[0]) -ge 18)
}

# --- 2. claude resolution (mirrors the host's resolveClaude) ---
$cacheFile = Join-Path $InstallDir 'workdir\claude-path.txt'
if (Test-Path $cacheFile) {
  $cached = (Get-Content $cacheFile -Raw).Trim()
  Check "claude-path.txt exists" $true
  Check "cached claude path exists ($cached)" (Test-Path $cached)
  Check "cached claude path is a spawnable .exe" ($cached -like '*.exe') "a .cmd here can't be spawned; re-run install-windows.ps1"
} else {
  Check "claude-path.txt exists" $false "re-run install-windows.ps1"
}
$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
Check "claude on PATH" ($null -ne $claudeCmd) "install Claude Code + sign in"
if ($claudeCmd -and $claudeCmd.Source -notlike '*.exe') {
  $bundled = Join-Path (Split-Path -Parent $claudeCmd.Source) 'node_modules\@anthropic-ai\claude-code\bin\claude.exe'
  Check "bundled claude.exe beside the shim" (Test-Path $bundled) "reinstall Claude Code (npm i -g @anthropic-ai/claude-code)"
}

# --- 3. Installed files ---
foreach ($f in @('booking-bandit-host.bat', 'host\main.mjs', 'contract.mjs', "$HostName.json")) {
  Check "installed: $f" (Test-Path (Join-Path $InstallDir $f)) "re-run install-windows.ps1"
}

# --- 4. Manifest ---
$manifestPath = Join-Path $InstallDir "$HostName.json"
if (Test-Path $manifestPath) {
  try {
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    Check "manifest parses" $true
    Check "manifest path points at an existing launcher" (Test-Path $manifest.path)
    Check "manifest allows extension $ExtensionId" ($manifest.allowed_origins -contains "chrome-extension://$ExtensionId/") "wrong -ExtensionId at install time"
  } catch { Check "manifest parses" $false $_.Exception.Message }
}

# --- 5. Registry, per browser hive ---
$hiveMap = @{
  chrome   = @('Google\Chrome')
  comet    = @('Perplexity\Comet', 'Comet')
  edge     = @('Microsoft\Edge')
  chromium = @('Chromium')
}
$roots = if ($Browser -eq 'all') { $hiveMap.Values | ForEach-Object { $_ } } else { $hiveMap[$Browser] }
foreach ($root in $roots) {
  $key = "HKCU:\Software\$root\NativeMessagingHosts\$HostName"
  if (Test-Path $key) {
    $val = (Get-ItemProperty $key).'(default)'
    Check "registry [$root] -> manifest exists" (Test-Path $val) "points at '$val'"
  } else {
    Check "registry [$root] registered" $false "re-run install-windows.ps1 (-Browser all)"
  }
}

# --- 6. Optional: framed ping through the INSTALLED host (the exact Chrome chain) ---
if ($Ping) {
  Write-Host ""
  Write-Host "Pinging the installed host..." -ForegroundColor Cyan
  & node (Join-Path $SrcDir 'scripts\smoke-host.mjs') --ping --host (Join-Path $InstallDir 'booking-bandit-host.bat')
  Check "installed-host ping" ($LASTEXITCODE -eq 0)
}

# --- 7. Stale-cache risk: running Chromium browsers only re-read the native-host
# registry on a TRUE full start (Comet especially keeps a tray/background process
# alive across "restarts"). Offer - never force - the kill. ---
Write-Host ""
foreach ($proc in @('comet', 'chrome', 'msedge')) {
  $running = Get-Process -Name $proc -ErrorAction SilentlyContinue
  if ($running) {
    Write-Host "NOTE: '$proc' is running ($(@($running).Count) process(es)). If the helper was (re)installed while it was open, it will NOT see the registration until a FULL quit." -ForegroundColor Yellow
    Write-Host "      Full-kill command:  Stop-Process -Name $proc -Force" -ForegroundColor Yellow
    # Read-Host throws under -NonInteractive (scripts/CI) - treat that as "No".
    $ans = 'n'
    try { $ans = Read-Host "      Kill all '$proc' processes now? (y/N)" } catch { $ans = 'n' }
    if ($ans -match '^[Yy]') { Stop-Process -Name $proc -Force -Confirm:$false; Write-Host "      Killed. Reopen the browser, then use Settings -> Key -> 'Test local engine'." -ForegroundColor Green }
  }
}

Write-Host ""
if ($script:fails -eq 0) { Write-Host "ALL CHECKS PASSED. If the panel still fails, fully quit + reopen the browser, then use the in-panel 'Test local engine' button." -ForegroundColor Green }
else { Write-Host "$($script:fails) CHECK(S) FAILED - fix the FAIL lines above (usually: re-run install\install-windows.ps1 -ExtensionId $ExtensionId -Browser all)." -ForegroundColor Red }
exit $(if ($script:fails -eq 0) { 0 } else { 1 })
