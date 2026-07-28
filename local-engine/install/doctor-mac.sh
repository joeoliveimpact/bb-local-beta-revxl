#!/bin/bash
# Booking Bandit local-engine doctor (macOS). Read-only: diagnoses the installed
# native-messaging chain and (with --ping) spawns the installed launcher exactly like
# Chrome does. Run this FIRST on any local-engine complaint on a Mac.
#
#   bash "<repo>/production-build/local-engine/install/doctor-mac.sh" [--ping] [EXTENSION_ID]

HOST_NAME="com.bookingbandit.localengine"
DO_PING=0
EXT_ID="eoaibojoneilhiagjmmhbbgehnmloelj"
for a in "$@"; do
  case "$a" in
    --ping) DO_PING=1 ;;
    *) EXT_ID="$a" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$(dirname "$SCRIPT_DIR")"
INSTALL_DIR="$HOME/Library/Application Support/BookingBandit"
WORK_DIR="$INSTALL_DIR/workdir"
LAUNCHER="$INSTALL_DIR/booking-bandit-host.sh"
MANIFEST_PATH="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$HOST_NAME.json"

FAILED=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILED=$((FAILED+1)); }

echo "Booking Bandit local-engine doctor (macOS)"
echo ""

# node
NODE_BIN="$(command -v node || true)"
if [ -n "$NODE_BIN" ]; then pass "node on PATH ($NODE_BIN)"; else fail "node on PATH ... install Node >=18"; fi
if [ -n "$NODE_BIN" ]; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR:-0}" -ge 18 ]; then pass "node version >= 18 ($(node -v 2>/dev/null))"; else fail "node version >= 18 (found $(node -v 2>/dev/null))"; fi
fi

# claude
if command -v claude >/dev/null 2>&1; then pass "claude on PATH ($(command -v claude))"; else fail "claude on PATH ... install Claude Code and sign in"; fi
if [ -f "$WORK_DIR/claude-path.txt" ]; then
  CP="$(cat "$WORK_DIR/claude-path.txt")"
  if [ -x "$CP" ] || [ -f "$CP" ]; then pass "cached claude path exists ($CP)"; else fail "cached claude path missing ($CP) ... re-run install-mac.sh"; fi
else
  fail "claude-path.txt exists ... re-run install-mac.sh"
fi

# installed files
for f in "$INSTALL_DIR/booking-bandit-host.sh" "$INSTALL_DIR/host/main.mjs" "$INSTALL_DIR/contract.mjs" "$MANIFEST_PATH"; do
  if [ -f "$f" ]; then pass "installed: $f"; else fail "installed: $f ... re-run install-mac.sh"; fi
done

# launcher executable
if [ -x "$LAUNCHER" ]; then pass "launcher is executable"; else fail "launcher not executable (chmod 755) ... re-run install-mac.sh"; fi

# manifest content
if [ -f "$MANIFEST_PATH" ]; then
  if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$MANIFEST_PATH" >/dev/null 2>&1; then
    pass "manifest parses"
    MPATH="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).path)' "$MANIFEST_PATH" 2>/dev/null)"
    if [ "$MPATH" = "$LAUNCHER" ] && [ -f "$MPATH" ]; then pass "manifest path points at the launcher"; else fail "manifest path mismatch ($MPATH)"; fi
    if node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit((m.allowed_origins||[]).includes("chrome-extension://"+process.argv[2]+"/")?0:1)' "$MANIFEST_PATH" "$EXT_ID"; then
      pass "manifest allows extension $EXT_ID"
    else
      fail "manifest does NOT allow extension $EXT_ID ... re-run install-mac.sh with the right ID"
    fi
  else
    fail "manifest parses ... file is corrupt, re-run install-mac.sh"
  fi
fi

# optional live ping through the installed launcher
if [ "$DO_PING" -eq 1 ] && [ -x "$LAUNCHER" ] && [ -n "$NODE_BIN" ]; then
  echo ""
  echo "Pinging the installed host..."
  if "$NODE_BIN" "$SRC_DIR/scripts/smoke-host.mjs" --ping --host "$LAUNCHER"; then pass "installed-host ping"; else fail "installed-host ping"; fi
fi

# Chrome running note
if pgrep -x "Google Chrome" >/dev/null 2>&1; then
  echo ""
  echo "NOTE: Google Chrome is running. If the helper was (re)installed while it was open, it will NOT"
  echo "      see the manifest until a FULL quit (Cmd-Q), then reopen."
fi

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "ALL CHECKS PASSED. If the panel still fails, fully quit + reopen Chrome, then use the in-panel 'Test local engine' button."
  exit 0
else
  echo "$FAILED CHECK(S) FAILED - fix the FAIL lines above (usually: re-run install/install-mac.sh)."
  exit 1
fi
