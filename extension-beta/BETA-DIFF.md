# extension-beta — divergence ledger & isolation contract

**What this is:** the BETA fork of the Booking Bandit extension, for the Local Claude Engine beta
(reply drafts generated on the client's own machine via `claude -p` on their Max plan). Forked from
`../extension/` on 2026-07-09, byte-identical at fork. Plan: `~/.claude/plans/eager-sauteeing-matsumoto.md`.

## Isolation contract (do not violate)

- **Prod line = `../extension/` (git) + `../../REVSetter PRO v1.2 - Build-in-progress/` (the working copy Joe loads).
  This project NEVER edits either.** All beta work happens in `extension-beta/` only.
- **Beta = this ONE folder.** No working-copy twin, no third hand-synced copy. Joe loads `extension-beta/`
  unpacked directly.
- **Backend:** prod routes untouched; every beta route is flag-gated (`LOCAL_ENGINE_BETA_ENABLED` + per-user
  `local_engine_allowed`). Deploy rsyncs `backend-api/` only → this folder never reaches the VPS.
- **Different pinned extension ID** (Phase 3 `manifest.json` `key`) → beta installs BESIDE prod in Chrome,
  never overwrites it.
- **Pre-commit guardrail:** before any beta commit, `git status` must show changes ONLY under
  `extension-beta/`, `backend-api/`, `local-engine/`, `supabase/migrations/` — NEVER under `extension/`.

## Divergence from `../extension/` (keep this list exhaustive so prod hotfixes port cleanly)

At fork: **zero diff** (byte-identical). Fill in as Phase 3 lands:

| File | Change | Phase |
|---|---|---|
| `manifest.json` | pin `key` (stable ID), rename "Booking Bandit (Beta)", add `nativeMessaging` permission | 3 |
| `background.js` | (1) add `'local-engine.js'` to importScripts; (2) extract markdown adapter → `adaptRichReplyToPanel()`; (3) engine guard in generateReply; (4) `getEngine`/`setEngine` + ACTION_HANDLERS entry | 3 |
| `sidepanel.js` | Engine toggle in Settings→Key tab (only when `local_engine_allowed`); "Switch to Cloud" on error toasts | 3 |
| `local-engine.js` | NEW — all local-engine logic (prompt fetch → native messaging → parse → adapt → telemetry) | 3 |

**Rule of thumb:** all beta *logic* lives in the NEW `local-engine.js`. The three existing files get only
minimal, documented patch points (above) — so a prod fix to `background.js`/`sidepanel.js` re-applies here
by hand against a short, known list.

## Landed — Phase 3 (2026-07-13)

**Pinned identity**
- Extension ID (stable, from the pinned `key`): **`eoaibojoneilhiagjmmhbbgehnmloelj`**
- Private keypair: `C:\Users\joeol\bb-secrets\bb-beta-extension-key.pem` (+ `bb-beta-pub.der`). **Never committed.** Only needed to re-pack a `.crx`; unpacked loads use the manifest `key` (public) alone.
- Native host name: `com.bookingbandit.localengine` (matches `local-engine/contract.mjs` + the installer's `-ExtensionId`).
- Contract version: **`1.0.0`** — must match across `local-engine.js` (`LOCAL_ENGINE_CONTRACT_VERSION`), `local-engine/contract.mjs` (`CONTRACT_VERSION`), and the backend (`routes/generate.ts` `LOCAL_ENGINE_CONTRACT_VERSION`). Bump all three together.

**`manifest.json`** — added `key`; name → "Booking Bandit (Beta)"; added `"nativeMessaging"` permission.

**`background.js`** — 4 patch points, each tagged `// BETA patch point N/4`:
1. `importScripts('local-engine.js')` (top).
2. `generateReply`: engine guard `if (await getEngine() === 'local') return generateReplyLocal(data, conversation)`.
3. `generateReply`: inline markdown rebuild replaced by `adaptRichReplyToPanel(result)` (extracted to `local-engine.js`; cloud path uses it too).
4. `ACTION_HANDLERS`: added `getEngineState`, `setEngineState`.

**`sidepanel.js`** — `DEFAULT_PROFILE.local_engine_allowed`; `this.engine` state; `renderEngineToggle()` injected atop the Key tab (gated on `profile.local_engine_allowed`); `loadEngineState()` on drawer open; `handleSetEngine()`; two-button wiring. All tagged `// BETA`.

**`local-engine.js`** — NEW. Engine toggle storage, native-messaging transport (`connectNative`), tolerant model-JSON parse (+1 repair retry), host-error → friendly-toast map (always offers Cloud), `adaptRichReplyToPanel`, `generateReplyLocal`.

**Verified:** `node --check` clean on all three JS files; manifest JSON valid; native host smoke-tested (framed request → real `claude` draft → framed reply). Prod `extension/` untouched (see git guardrail).

## Landed — reliability pass, contract 1.1.0 (2026-07-18)

Belt-and-suspenders hardening after "worked once on 07-15, never since" (plan:
`~/.claude/plans/plan-how-we-can-polymorphic-reddy.md`). Contract **1.0.0 → 1.1.0**
(additive: `ping` self-test, `progress` heartbeat frames gated on `wantsHeartbeat`).
Sync across the three copies now enforced by `local-engine/scripts/check-contract-sync.mjs`
— **run it before any beta commit** (alongside the git-scope guardrail above).

**`local-engine.js`** (all beta logic, rewritten in place):
- Version 1.1.0; `LOCAL_CLIENT_WATCHDOG_MS` now DERIVED from `LOCAL_HOST_TIMEOUT_MS`.
- Heartbeats: sends `wantsHeartbeat:true`; `progress` frames = MV3 keepalive + a
  30s heartbeat-gap watchdog ("host stopped responding" fails fast). Unknown frame
  types ignored.
- Console breadcrumbs at connect/terminal/disconnect (logs `chrome.runtime.lastError`
  VERBATIM — the key diagnostic, previously discarded).
- `localEngineError` also sets `e.engineDetail`; every failure path is tagged
  (`localEngine`, `engineError`).
- Failure telemetry: `reportLocalFailure()` fire-and-forgets `status:'failed'` +
  `errorCode` to `/generate/local-complete` on every post-prompt failure.
- `/generate/prompt` gate errors (404/403) map to specific "beta paused / not
  enabled / finish setup" messages; engine preference deliberately stays `local`.
- Self-test: `selfTestLocalEngine` ACTION_HANDLER (ping / deep through the REAL chain).
- Toast copy now references commands that exist (installer + doctor), not bb-* stubs.
- Backend calls use `backendPostTimed` (30s abort) — a hung backend can't pin Generate.

**`background.js`** — patch-point extensions (all tagged `// BETA`):
- Dispatcher catch: spreads `engineError`/`engineDetail` (mirrors the paywall spread).
- `backendFetch`: optional `timeoutMs` + AbortController (cloud callsites unchanged);
  new `backendPostTimed` helper.
- ACTION_HANDLERS: added `selfTestLocalEngine` (patch point 4).

**`sidepanel.js`** (tagged `// BETA`):
- Local-engine failures render a persistent error card (friendly line + collapsible
  technical detail + Copy diagnostics), replacing the vanish-in-3s toast.
- Engine block: **Test local engine** + **Deep test** buttons + green/red result card
  (`handleEngineSelfTest`); copy no longer references `bb-setup`.

**Outside this folder (same pass):** host `local-engine/host/main.mjs` rewritten
(JSONL diagnostic log at `%LOCALAPPDATA%\BookingBandit\logs\`, exit/teardown hygiene
+ temp sweep, ping handler, cache spawnability self-heal, tolerant envelope parse,
16 MB frame cap, heartbeats); installer hard-fails + pins node into the generated
launcher + registers ALL hives + verifies with a framed ping; NEW
`install/doctor-windows.ps1` (the real bb-doctor), `scripts/smoke-host.mjs`,
`scripts/check-contract-sync.mjs`; `host-manifest.template.json` DELETED (unused —
the installer generates the manifest); backend `/generate/local-complete` accepts
`status:'failed'`+`errorCode` and marks the tripwire row failed (no memory restore).
