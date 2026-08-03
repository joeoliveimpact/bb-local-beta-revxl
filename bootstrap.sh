#!/usr/bin/env bash
# Booking Bandit - one-command bootstrap (macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/joeoliveimpact/bb-local-beta-revxl/main/bootstrap.sh | bash
#
# Takes a bare Mac to a working local engine with no terminal knowledge and NO admin
# password. Installs everything into ~/.booking-bandit and ~/BookingBandit, both owned
# by the user - nothing touches /usr/local, so this also works on a managed laptop.
#
# Order matters: node -> claude CLI -> bundle -> helper installer (it hard-fails
# without both node and claude on PATH) -> interactive Claude login last.
#
# Piped-stdin note: `curl | bash` makes stdin the pipe, not the keyboard, so any
# interactive step must read from /dev/tty explicitly. That is why the login step
# redirects; without it `claude` reads EOF and dies instantly.

set -euo pipefail

REPO="joeoliveimpact/bb-local-beta-revxl"
BB_HOME="$HOME/.booking-bandit"
NODE_DIR="$BB_HOME/node"
BUNDLE_DIR="$HOME/BookingBandit"
MIN_NODE_MAJOR=18

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die()  { printf '\n\033[31mSTOPPED: %s\033[0m\n\n' "$*" >&2; exit 1; }

printf '\n============================================================\n'
printf '  Booking Bandit - setup\n'
printf '============================================================\n'
info "This installs everything into your own home folder."
info "It will NOT ask for your computer password."

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS. On Windows use 'Install Booking Bandit (Windows).cmd' from the bundle."

# --- 1. Node -----------------------------------------------------------------
# Prefer a usable system node; otherwise install a private copy. We never upgrade
# or touch a system node - if theirs is too old we just shadow it with ours.
say "Step 1 of 5 - checking for Node"

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

NODE_BIN=""
if command -v node >/dev/null 2>&1 && [ "$(node_major node)" -ge "$MIN_NODE_MAJOR" ]; then
  NODE_BIN="$(command -v node)"
  info "found $("$NODE_BIN" -v) - using it"
elif [ -x "$NODE_DIR/bin/node" ] && [ "$(node_major "$NODE_DIR/bin/node")" -ge "$MIN_NODE_MAJOR" ]; then
  NODE_BIN="$NODE_DIR/bin/node"
  info "already installed by a previous run - reusing it"
else
  info "not found - installing a private copy (no password needed)"

  case "$(uname -m)" in
    arm64) ARCH="darwin-arm64" ;;
    x86_64) ARCH="darwin-x64" ;;
    *) die "Unrecognized Mac processor '$(uname -m)'. Send Joe a screenshot." ;;
  esac

  # Resolve the current LTS from the official index. Parsed with grep/sed because
  # jq is not on a stock Mac. One object per line, first entry whose lts is a
  # name rather than false is the newest LTS (index.json is newest-first).
  info "looking up the current stable version..."
  LTS_VERSION="$(
    curl -fsSL --max-time 30 https://nodejs.org/dist/index.json \
      | sed 's/},{/}\n{/g' \
      | grep -m1 '"lts":"' \
      | sed -n 's/.*"version":"\(v[0-9.]*\)".*/\1/p'
  )" || true
  [ -n "$LTS_VERSION" ] || die "Could not reach nodejs.org. Check the internet connection and re-run."
  info "installing Node $LTS_VERSION ($ARCH)"

  TARBALL="node-${LTS_VERSION}-${ARCH}.tar.gz"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL --max-time 300 -o "$TMP/node.tar.gz" \
    "https://nodejs.org/dist/${LTS_VERSION}/${TARBALL}" \
    || die "Node download failed. Re-run and it will pick up where it left off."

  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xzf "$TMP/node.tar.gz" -C "$NODE_DIR" --strip-components=1
  NODE_BIN="$NODE_DIR/bin/node"
  [ -x "$NODE_BIN" ] || die "Node did not unpack correctly. Send Joe a screenshot."
  info "installed $("$NODE_BIN" -v)"
fi

# Put our bin dir first so npm, npx and claude all resolve to this install for the
# rest of the script AND for the helper installer's `command -v` lookups.
export PATH="$(cd "$(dirname "$NODE_BIN")" && pwd):$PATH"

# --- 2. Claude Code CLI ------------------------------------------------------
say "Step 2 of 5 - installing Claude Code"

if command -v claude >/dev/null 2>&1; then
  info "already installed ($(claude --version 2>/dev/null || echo 'version unknown'))"
else
  info "this takes a minute or two, lots of text is normal..."
  npm install -g @anthropic-ai/claude-code --no-audit --no-fund --silent \
    || die "Claude Code install failed. Scroll up for the reason and send Joe a screenshot."
  command -v claude >/dev/null 2>&1 || die "Claude Code installed but did not appear on PATH. Send Joe a screenshot."
  info "installed $(claude --version 2>/dev/null || echo '')"
fi

# --- 3. Bundle ---------------------------------------------------------------
say "Step 3 of 5 - downloading Booking Bandit"

TMP2="$(mktemp -d)"
curl -fsSL --max-time 300 -o "$TMP2/bb.tar.gz" \
  "https://codeload.github.com/${REPO}/tar.gz/refs/heads/main" \
  || die "Could not download the Booking Bandit bundle. Check the internet connection."

rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR"
tar -xzf "$TMP2/bb.tar.gz" -C "$BUNDLE_DIR" --strip-components=1
rm -rf "$TMP2"
[ -d "$BUNDLE_DIR/extension-beta" ] || die "The bundle unpacked but looks wrong. Send Joe a screenshot."
info "saved to $BUNDLE_DIR"

# --- 4. Helper ---------------------------------------------------------------
# Runs BEFORE login on purpose: its end-of-install ping only proves the host can be
# spawned, which does not require an authenticated claude.
say "Step 4 of 5 - installing the helper"

bash "$BUNDLE_DIR/local-engine/install/install-mac.sh" \
  || die "Helper install failed. Scroll up - the last few lines say why - and send Joe a screenshot."

# --- 5. Login ----------------------------------------------------------------
say "Step 5 of 5 - signing in to Claude"

# `claude auth login` and NOT bare `claude`: bare claude starts a full interactive
# session, which on a fresh machine means a login AND a "do you trust this folder"
# prompt, then leaves a non-technical user sitting in a REPL they have to work out how
# to exit. auth login does the one thing and returns.
auth_status() { claude auth status --json 2>/dev/null || true; }

STATUS="$(auth_status)"
if printf '%s' "$STATUS" | grep -q '"loggedIn"[[:space:]]*:[[:space:]]*true'; then
  WHO="$(printf '%s' "$STATUS" | sed -n 's/.*"email"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  info "already signed in as $WHO - nothing to do"
elif [ ! -e /dev/tty ]; then
  info "Could not open an interactive prompt from this pipe."
  info "Open a NEW Terminal window and run:  claude auth login"
else
  printf '\n'
  printf '   >> THE COACH DOES THIS PART, NOT THE ASSISTANT. <<\n\n'
  printf "   Sign in with the COACH'S Claude account, not your own.\n"
  printf '   The drafts only sound like the coach because they run on\n'
  printf "   the coach's Claude.\n\n"

  # stdin is the curl pipe, so every interactive read needs a real keyboard.
  printf "   Coach's Claude email (press Enter to skip): "
  read -r COACH_EMAIL < /dev/tty || COACH_EMAIL=""

  if [ -n "$COACH_EMAIL" ]; then
    claude auth login --email "$COACH_EMAIL" < /dev/tty || true
  else
    claude auth login < /dev/tty || true
  fi

  # Never claim success on an exit code alone - ask the CLI who it thinks it is.
  STATUS="$(auth_status)"
  if printf '%s' "$STATUS" | grep -q '"loggedIn"[[:space:]]*:[[:space:]]*true'; then
    WHO="$(printf '%s' "$STATUS" | sed -n 's/.*"email"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    PLAN="$(printf '%s' "$STATUS" | sed -n 's/.*"subscriptionType"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    info "signed in as $WHO ($PLAN)"
    if [ -n "$COACH_EMAIL" ] && [ -n "$WHO" ] && [ "$WHO" != "$COACH_EMAIL" ]; then
      printf '\n   WARNING: signed in as %s, but you entered %s.\n' "$WHO" "$COACH_EMAIL"
      printf '   If that is not the coach account, run:  claude auth logout\n'
      printf '   then re-run this installer.\n'
    fi
  else
    die "Sign-in did not complete. Open a new Terminal and run:  claude auth login"
  fi
fi

# --- Done --------------------------------------------------------------------
printf '\n============================================================\n'
printf '  Almost done - two things left, both in Chrome\n'
printf '============================================================\n\n'
printf '  1. Open Chrome and go to:   chrome://extensions\n'
printf '     Turn on "Developer mode" (top-right), click "Load unpacked",\n'
printf '     and choose this folder:\n\n'
printf '         %s/extension-beta\n\n' "$BUNDLE_DIR"
printf '  2. Quit Chrome COMPLETELY with Cmd-Q. Closing the window is not\n'
printf '     enough - check the dock, there should be no dot under Chrome.\n'
printf '     Then reopen it.\n\n'
printf "  Then: open the Booking Bandit (Beta) side panel, sign in with the\n"
printf "  COACH'S Google account (not your own), and click\n"
printf "  Settings > Key > \"Test local engine\". Green means done.\n\n"
