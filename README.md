# Booking Bandit — Local Claude Engine (Beta)

Private test bundle. This runs Booking Bandit's DM drafts on **your own Claude Max
subscription**, right on your computer — no API key, nothing billed to you per draft.

Two pieces:
- **`extension-beta/`** — the Chrome extension (Beta build).
- **`local-engine/`** — a small helper that lets the extension talk to Claude Code on your machine.

Works on **Windows** and **macOS**, **Chrome only**.

---

## Before you start (required)

1. **Claude Code installed and signed in.**
   - Install: https://claude.com/claude-code
   - Open a terminal, run `claude`, and sign in with a **Claude Max** account. The
     local engine uses *this* login to draft — if it's not signed in, drafts fail.
   - Confirm it works: `claude --version` should print a version.
2. **Node.js 18 or newer.** Check with `node --version`. If missing: https://nodejs.org
3. This folder (the whole `bb-local-beta-revxl` download) saved somewhere you can find it.

---

## Install — Windows

1. Open **PowerShell** (Start menu → type "powershell" → Enter).
2. Paste this, replacing the path if you saved the folder elsewhere:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass -Force
   & "<path-to-folder>\local-engine\install\install-windows.ps1" -ExtensionId eoaibojoneilhiagjmmhbbgehnmloelj -Browser all
   ```
3. You should see registry lines end with `[verified]` and finish with **`SMOKE PASS (ping)`**.

## Install — macOS

1. Open **Terminal** (Cmd-Space → type "terminal" → Enter).
2. Paste this, replacing the path if you saved the folder elsewhere:
   ```bash
   bash "<path-to-folder>/local-engine/install/install-mac.sh"
   ```
3. You should see it finish with **`SMOKE PASS (ping)`**.

---

## Load the extension (both OSes)

1. Open Chrome → go to `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the **`extension-beta`** folder from this download
4. Confirm the extension ID reads `eoaibojoneilhiagjmmhbbgehnmloelj`

## Turn it on and test

1. **Fully quit Chrome** and reopen it (Windows: close every window / `Stop-Process -Name chrome -Force`; macOS: **Cmd-Q**). A normal window-close is *not* enough — Chrome only re-reads the helper after a full restart.
2. Open the **Booking Bandit (Beta)** side panel → gear (Settings) → **Key** tab → **Test local engine**.
3. Green = you're set. Do one **Deep test**, then try a real **Generate** on a DM thread.

---

## If it doesn't work

Run the doctor and send Joe the full output.

- **Windows:** `& "<path>\local-engine\install\doctor-windows.ps1" -Ping`
- **macOS:** `bash "<path>/local-engine/install/doctor-mac.sh" --ping`

The doctor checks every link in the chain and tells you which one is broken. If the
error card in the panel has a **Copy diagnostics** button, send that too.

**Most common fix:** you didn't *fully* quit Chrome after installing. Quit it
completely (menu bar / Task Manager), reopen, test again.

---

## Updating

When Joe ships a fix, re-download this folder (or `git pull`), re-run the installer
for your OS, then fully quit + reopen Chrome. The extension you can just **Reload**
on `chrome://extensions`.
