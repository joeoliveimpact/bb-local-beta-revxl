# Booking Bandit — Local Claude Engine (Beta)

Private test bundle. This runs Booking Bandit's DM drafts on **your own Claude Max
subscription**, right on your computer — no API key, nothing billed per draft.

Works on **Windows** and **macOS**, **Chrome only**.

---

## Before you start (required)

You must already have:
1. **Claude Code installed and signed into a Claude Max account.** (Confirm: open a
   terminal, run `claude --version` — it should print a version, and `claude` should be
   signed in.) The local engine drafts using *this* login.
2. **Google Chrome.**

If you have those, setup below is just a couple of clicks — no commands to type.

**Don't have Claude Code yet, or not sure?** Open this folder in Claude Desktop and type
`/bb-setup`. It checks what's missing, installs it, and walks you through the rest of
this page one step at a time.

---

## Step 1 — Install the helper (double-click)

**Windows:** double-click **`Install Booking Bandit (Windows).cmd`**
- If Windows shows a blue "Windows protected your PC" box → click **More info** → **Run anyway**.
- A window opens, runs by itself, and ends with **`SMOKE PASS`**. Press a key to close.

**macOS:** double-click **`Install Booking Bandit (Mac).command`**
- The first time, macOS may say *"cannot verify developer."* Fix: **right-click** the file
  → **Open** → **Open**. (You only do this once.)
- A Terminal window opens, runs by itself, and ends with **`SMOKE PASS`**. Press a key to close.

That's the only setup step. No typing.

---

## Step 2 — Add the extension to Chrome

1. Open Chrome → go to `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked** → choose the **`extension-beta`** folder in this bundle
4. The extension ID should read `eoaibojoneilhiagjmmhbbgehnmloelj`

## Step 3 — Turn it on

1. **Fully quit Chrome and reopen it.** Windows: close every Chrome window. macOS: **Cmd-Q**.
   (A normal window-close is not enough — Chrome only picks up the helper after a full restart.)
2. Open the **Booking Bandit (Beta)** side panel → gear (Settings) → **Key** tab → **Test local engine**.
3. Green = done. Try a real **Generate** on a DM thread.

---

## If something doesn't work

Send Joe a screenshot of the installer window, and (if the panel shows a red error card)
click its **Copy diagnostics** button and send that.

**Most common fix:** you didn't *fully* quit Chrome after installing. Quit it completely,
reopen, and hit **Test local engine** again.

---

## Updating

When Joe ships a fix, re-download this bundle, double-click the installer again, then fully
quit + reopen Chrome. The extension itself you can just **Reload** on `chrome://extensions`.

---

<details>
<summary>Advanced: install from a terminal instead of double-clicking</summary>

**Windows (PowerShell):**
```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
& ".\local-engine\install\install-windows.ps1" -ExtensionId eoaibojoneilhiagjmmhbbgehnmloelj -Browser all
```

**macOS (Terminal):**
```bash
bash "./local-engine/install/install-mac.sh"
```

Diagnose a broken install:
- Windows: `& ".\local-engine\install\doctor-windows.ps1" -Ping`
- macOS: `bash "./local-engine/install/doctor-mac.sh" --ping`
</details>
