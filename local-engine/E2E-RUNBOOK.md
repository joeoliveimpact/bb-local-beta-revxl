# Local Claude Engine (Beta) — first on-machine e2e runbook

Goal: generate one DM draft on **your own machine** via Claude Code, proven by a
`provider:'local_claude'` usage row and zero house cost. Prod users see no change.

Pinned beta extension ID: **`eoaibojoneilhiagjmmhbbgehnmloelj`**

Prereqs on this machine: Node ≥ 18, Claude Code installed **and signed in** on your Max plan, **a Chromium browser** (Chrome or **Comet** — Comet reads a different native-messaging registry path, handled by `-Browser comet`).

---

## 1. Apply migration 015 (Supabase dashboard → SQL editor)

```sql
alter table public.profiles
  add column if not exists local_engine_allowed boolean not null default false;

alter table public.usage_events drop constraint usage_events_status_check;
alter table public.usage_events add constraint usage_events_status_check
  check (status in ('success', 'failed', 'refunded', 'prompt_issued'));
```

(Or apply `supabase/migrations/015_local_engine_flag.sql` via the Supabase MCP once it reconnects.)

## 2. Grant your own account the flag

```sql
update public.profiles set local_engine_allowed = true
where email = 'joe@engineforimpact.com';   -- the account you'll demo with (admin + setup_complete)
```

The demo account must have completed business setup (`setup_complete=true` + `client_settings`), or `/generate/prompt` returns 403 `setup_incomplete`.

## 3. Backend: deploy the flag-gated routes (Claude, on your OK)

Everything is inert until the env flag flips, so this is safe to ship anytime:

1. Commit + push `backend-api/` + `supabase/migrations/015` + `local-engine/` + `extension-beta/` to `origin/main`.
2. Deploy via the git-pull path (`scripts/deploy-backend.sh` through WSL) — VPS pulls `origin/main`.
3. On the VPS `.env`:
   - `LOCAL_ENGINE_BETA_ENABLED=true`
   - **append** the beta origin to `ALLOWED_ORIGINS` (never replace): `,chrome-extension://eoaibojoneilhiagjmmhbbgehnmloelj`
   - `pm2 restart booking-bandit-backend`

Verify: `curl https://revxl-vps.tailc17742.ts.net/health` → `{"ok":true}`.

## 4. Supabase Auth → URL Configuration → Redirect URLs

**Add** (leave prod's in place):
```
https://eoaibojoneilhiagjmmhbbgehnmloelj.chromiumapp.org/
```

## 5. Install the native host (PowerShell, this machine)

```powershell
cd "…\production-build\local-engine"
powershell -ExecutionPolicy Bypass -File install\install-windows.ps1 -ExtensionId eoaibojoneilhiagjmmhbbgehnmloelj
```
The default (`-Browser all`) registers every known Chromium hive (Chrome + Comet + Edge + Chromium) — registering an unused one is harmless. The installer pins the absolute node path into the launcher, hard-fails on a non-spawnable claude, and ends by **pinging the installed host end-to-end** — a green "SMOKE PASS (ping)" is the real done signal. Then FULLY quit and reopen the browser (check the tray / Task Manager — a surviving background process keeps the stale host list; this is THE classic Comet failure).

## 6. Load the beta extension (Comet)

1. `comet://extensions` (or `chrome://extensions`) → enable **Developer mode**.
2. **Load unpacked** → select `production-build/extension-beta/`.
3. Confirm the loaded ID is **`eoaibojoneilhiagjmmhbbgehnmloelj`** (proves the pinned key). It installs *beside* prod, not over it.

## 7. Run it

1. Open the side panel, sign in (Google), let the profile load.
2. Gear → **Settings → Key** tab → **Draft engine** → click **Local (Claude)**. (The toggle only appears because your account has `local_engine_allowed`.)
3. On an Instagram/Messenger DM (or paste a thread), hit **Generate**. Expect a draft in ~25-45s (opus, high effort).

## 8. Prove locality

In Supabase (SQL editor), after one local generate:

```sql
select provider, model, status, cost_usd, latency_ms, created_at
from public.usage_events
where user_id = (select id from public.profiles where email = 'joe@engineforimpact.com')
order by created_at desc limit 3;
```

Pass = a row with `provider='local_claude'`, `status='success'`, `cost_usd=0`, and **no** OpenRouter cost row for that generate. That row is the Definition of Done.

---

## Diagnostics (1.1)

Work top-down; each layer proves the one below it.

1. **In-panel self-test** — Settings → Key → **Test local engine** (ping through the real
   browser→host chain) or **Deep test** (adds a tiny real `claude -p` run: spawn + auth +
   envelope). Green = the whole chain works; red = the card says which stage broke.
2. **Doctor (this is the "bb-doctor" the error cards mention)** —
   `powershell -ExecutionPolicy Bypass -File install\doctor-windows.ps1 -Ping`
   Read-only PASS/FAIL on node, claude resolution, installed files, manifest, every
   browser hive, plus a framed ping through the INSTALLED launcher. Detects running
   browsers and offers (never forces) the full-kill.
3. **Host log** — `%LOCALAPPDATA%\BookingBandit\logs\host.log` (JSONL, size-capped,
   never contains prompt/DM bodies). **The one-line discriminator: did a failed
   attempt add a line here?** No new line = the browser never spawned the host
   (registration / stale host-list cache). A line with an errorCode = the failure is
   inside the host/claude and the code names it.
4. **Standalone smoke (no browser)** — `node scripts/smoke-host.mjs --ping` (host alone),
   `--deep` (tiny real claude run), `--generate` (real haiku draft), and
   `--ping --host "%LOCALAPPDATA%\BookingBandit\booking-bandit-host.bat"` (the exact
   installed chain Chrome spawns).

## If it fails

- Error card "browser can't find the helper" → the browser's cached host list is stale
  or registration is missing. Re-run the installer, then **FULLY quit the browser**
  (`Stop-Process -Name comet -Force` — tray/background processes survive normal
  restarts and keep the stale cache; this cost hours on 07-15) and reopen. Confirm
  with the Test button.
- Toast "not signed in" → run `claude` in a terminal and sign in.
- "malformed" → the model broke JSON twice; retry, or flip to Cloud.
- Toggle missing → your account's `local_engine_allowed` isn't `true` (step 2), or `/me` hasn't refreshed (reopen the panel).
- "beta is paused server-side" → `LOCAL_ENGINE_BETA_ENABLED` isn't `true` on the VPS.
- "not enabled for this account" / setup message → flag or business setup (steps 1-2).
- Slow / never returns → run the doctor; check `host.log` for the timeout entry.

Kill switch: set `local_engine_allowed=false` (per coach) or `LOCAL_ENGINE_BETA_ENABLED=false`
(everyone) → `/generate/prompt` starts failing and the panel shows a clear "beta is
paused / not enabled" error card on every Local attempt. **The engine preference stays
Local** — the coach switches to Cloud manually in Settings → Key (deliberate: no silent
engine flips). Local failures also write a `status='failed'` + `error_code` row to
`usage_events` (same requestId), so field failure rates are visible server-side.
