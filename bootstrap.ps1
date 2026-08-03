# Booking Bandit - one-command bootstrap (Windows).
#
#   irm https://raw.githubusercontent.com/joeoliveimpact/bb-local-beta-revxl/main/bootstrap.ps1 | iex
#
# Takes a bare Windows PC to a working local engine with no terminal knowledge and NO
# admin rights. Everything lands under the user profile - nothing goes to Program Files,
# so this also works on a managed work laptop.
#
# Windows 5.1 notes: no ternary, no &&, no ?? - this must run on stock PowerShell.
# ASCII only; PS 5.1 tokenization breaks on typographic dashes.
#
# Unlike the Mac script there is no stdin problem: `iex` runs in the live console, so
# the interactive Claude login reads the real keyboard.

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # Invoke-WebRequest is ~10x slower with it on
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo       = 'joeoliveimpact/bb-local-beta-revxl'
$ExtId      = 'eoaibojoneilhiagjmmhbbgehnmloelj'
$BBHome     = Join-Path $env:USERPROFILE '.booking-bandit'
$NodeDir    = Join-Path $BBHome 'node'
$BundleDir  = Join-Path $env:USERPROFILE 'BookingBandit'
$MinNodeMaj = 18

function Say  { param($m) Write-Host ""; Write-Host $m -ForegroundColor White }
function Info { param($m) Write-Host "   $m" }
function Die  { param($m) Write-Host ""; Write-Host "STOPPED: $m" -ForegroundColor Red; Write-Host ""; exit 1 }

Write-Host ""
Write-Host "============================================================"
Write-Host "  Booking Bandit - setup"
Write-Host "============================================================"
Info "This installs everything into your own user folder."
Info "It will NOT ask for an administrator password."

# --- 1. Node -----------------------------------------------------------------
# Prefer a usable system node. A too-old one is shadowed, never upgraded.
Say "Step 1 of 5 - checking for Node"

function Get-NodeMajor {
  param($exe)
  # Use --version, NOT `node -p 'expr with "quotes"'`. PS 5.1 mangles embedded double
  # quotes when passing an argument to a native exe, so node receives broken JS, exits
  # 1, and prints nothing - which read as "no node installed" and reinstalled it on a
  # machine that already had it. Parse the plain version string in PowerShell instead.
  try {
    $v = & $exe --version 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $v) { return 0 }
    return [int]((("$v").Trim() -replace '^v','') -split '\.')[0]
  } catch { return 0 }
}

$NodeBin = $null
$sysNode = Get-Command node -ErrorAction SilentlyContinue
$privNode = Join-Path $NodeDir 'node.exe'

if ($sysNode -and (Get-NodeMajor $sysNode.Source) -ge $MinNodeMaj) {
  $NodeBin = $sysNode.Source
  Info "found $(& $NodeBin -v) - using it"
} elseif ((Test-Path $privNode) -and (Get-NodeMajor $privNode) -ge $MinNodeMaj) {
  $NodeBin = $privNode
  Info "already installed by a previous run - reusing it"
} else {
  Info "not found - installing a private copy (no admin rights needed)"

  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'win-arm64' } else { $arch = 'win-x64' }

  Info "looking up the current stable version..."
  try {
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30 -UseBasicParsing
  } catch {
    Die "Could not reach nodejs.org. Check the internet connection and re-run."
  }
  # lts is either the boolean false or a codename string. The string ones are LTS.
  $lts = $index | Where-Object { $_.lts -is [string] } | Select-Object -First 1
  if (-not $lts) { Die "Could not work out the current Node version. Send Joe a screenshot." }
  $ver = $lts.version
  Info "installing Node $ver ($arch)"

  $tmp = Join-Path $env:TEMP ("bb-node-" + [System.Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'node.zip'
  try {
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$ver/node-$ver-$arch.zip" -OutFile $zip -TimeoutSec 300 -UseBasicParsing
  } catch {
    Die "Node download failed. Re-run and it will pick up where it left off."
  }

  if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  # The zip contains one top-level folder (node-vX.Y.Z-win-x64). Flatten it.
  $inner = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $NodeDir) | Out-Null
  Move-Item -Path $inner.FullName -Destination $NodeDir
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

  $NodeBin = Join-Path $NodeDir 'node.exe'
  if (-not (Test-Path $NodeBin)) { Die "Node did not unpack correctly. Send Joe a screenshot." }
  Info "installed $(& $NodeBin -v)"
}

# Put our node dir first so npm and claude resolve here for the rest of this run AND
# for the helper installer's Get-Command lookups.
$env:Path = (Split-Path -Parent $NodeBin) + ";" + $env:Path

# --- 2. Claude Code CLI ------------------------------------------------------
Say "Step 2 of 5 - installing Claude Code"

if (Get-Command claude -ErrorAction SilentlyContinue) {
  Info "already installed"
} else {
  Info "this takes a minute or two, lots of text is normal..."
  & npm install -g '@anthropic-ai/claude-code' --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Die "Claude Code install failed. Scroll up for the reason and send Joe a screenshot." }
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Die "Claude Code installed but did not appear on PATH. Send Joe a screenshot."
  }
  Info "installed"
}

# --- 3. Bundle ---------------------------------------------------------------
Say "Step 3 of 5 - downloading Booking Bandit"

$tmp2 = Join-Path $env:TEMP ("bb-bundle-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp2 | Out-Null
$bzip = Join-Path $tmp2 'bb.zip'
try {
  Invoke-WebRequest -Uri "https://codeload.github.com/$Repo/zip/refs/heads/main" -OutFile $bzip -TimeoutSec 300 -UseBasicParsing
} catch {
  Die "Could not download the Booking Bandit bundle. Check the internet connection."
}

if (Test-Path $BundleDir) { Remove-Item -Recurse -Force $BundleDir }
Expand-Archive -Path $bzip -DestinationPath $tmp2 -Force
$binner = Get-ChildItem -Path $tmp2 -Directory | Select-Object -First 1
Move-Item -Path $binner.FullName -Destination $BundleDir
Remove-Item -Recurse -Force $tmp2 -ErrorAction SilentlyContinue

if (-not (Test-Path (Join-Path $BundleDir 'extension-beta'))) {
  Die "The bundle unpacked but looks wrong. Send Joe a screenshot."
}
Info "saved to $BundleDir"

# --- 4. Helper ---------------------------------------------------------------
# Runs BEFORE login on purpose: the installer's end-of-install ping only proves the
# host is spawnable, which does not require an authenticated claude.
Say "Step 4 of 5 - installing the helper"

& (Join-Path $BundleDir 'local-engine\install\install-windows.ps1') -ExtensionId $ExtId -Browser all
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) {
  Die "Helper install failed. Scroll up - the last few lines say why - and send Joe a screenshot."
}

# --- 5. Login ----------------------------------------------------------------
Say "Step 5 of 5 - signing in to Claude"

Write-Host ""
Write-Host "   >> THE COACH DOES THIS PART, NOT THE ASSISTANT. <<" -ForegroundColor Yellow
Write-Host ""
Write-Host "   A sign-in link is about to appear below."
Write-Host "   Send that link to the coach. They open it, sign in with THEIR"
Write-Host "   Claude account, and send back the code it gives them."
Write-Host "   Paste that code here."
Write-Host ""
Write-Host "   The coach never types a password on this computer."
Write-Host ""

& claude

# --- Done --------------------------------------------------------------------
Write-Host ""
Write-Host "============================================================"
Write-Host "  Almost done - two things left, both in Chrome"
Write-Host "============================================================"
Write-Host ""
Write-Host "  1. Open Chrome and go to:   chrome://extensions"
Write-Host "     Turn on 'Developer mode' (top-right), click 'Load unpacked',"
Write-Host "     and choose this folder:"
Write-Host ""
Write-Host "         $BundleDir\extension-beta"
Write-Host ""
Write-Host "  2. Close EVERY Chrome window, then reopen it. Chrome only picks"
Write-Host "     up the helper on a fresh start."
Write-Host ""
Write-Host "  Then: open the Booking Bandit (Beta) side panel, sign in with the"
Write-Host "  COACH'S Google account (not your own), and click"
Write-Host "  Settings > Key > 'Test local engine'. Green means done."
Write-Host ""
