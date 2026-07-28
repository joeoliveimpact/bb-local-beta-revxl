# Booking Bandit — Local Claude Engine (Beta) host

The native-messaging helper that lets the beta extension generate DM drafts on the
coach's **own machine** via their Claude Code / Max subscription. Zero per-reply
cost to the house; no API key ever used.

## How it works

```
extension-beta  ──(POST /generate/prompt)──▶  backend assembles {system, userMessage}
      │                                         (KB stays server-side; NO LLM call)
      ▼
chrome.runtime.connectNative('com.bookingbandit.localengine')
      │  Chrome spawns this host, one message per draft (stateless — no daemon)
      ▼
host/main.mjs ──▶ claude.exe -p --model opus --effort high ... (their Max plan)
      │  parses the {type:result,...} envelope, maps errors
      ▼
{ ok:true, resultText, meta }  ──▶  panel renders  ──▶  POST /generate/local-complete
```

- **Subscription auth only.** The host strips `ANTHROPIC_API_KEY` and every
  alt-provider var from the child env, so `claude` can never silently bill a key.
- **Contamination-proof.** `--setting-sources '' --strict-mcp-config
  --disallowed-tools ...` neutralize the coach's own `CLAUDE.md` / skills / MCP.
- **No secrets on disk.** The system prompt is written to a `0600` temp file in a
  non-synced dir (`%LOCALAPPDATA%\BookingBandit\workdir`) and deleted in every exit
  path. Prompt and DM bodies are never logged.

## Files

| File | Role |
|---|---|
| `contract.mjs` | Shared contract constants (version, defaults, error codes). Mirrored in `extension-beta/local-engine.js` and the backend; sync enforced by `scripts/check-contract-sync.mjs`. |
| `host/main.mjs` | The Node host — reads one framed message, runs `claude -p`, returns one framed reply. Also: `ping` self-test, `progress` heartbeats, JSONL diagnostic log (`%LOCALAPPDATA%\BookingBandit\logs\`), claude-path self-heal. |
| `booking-bandit-host.bat` | Launcher TEMPLATE — the installer GENERATES the installed copy with the absolute node path pinned. |
| `install/install-windows.ps1` | Copies files → `%LOCALAPPDATA%\BookingBandit`, pins node into the launcher, hard-validates the bundled `claude.exe`, writes the manifest, registers every browser hive (readback-verified), then pings the installed host end-to-end. |
| `install/doctor-windows.ps1` | Read-only diagnosis of the whole chain (the "bb-doctor" the error cards reference). `-Ping` adds a framed ping through the installed launcher. |
| `scripts/smoke-host.mjs` | Standalone host smoke: `--ping` / `--deep` / `--generate`, `--host <bat>` for the installed chain. |
| `scripts/check-contract-sync.mjs` | Asserts the 3 hand-mirrored contract copies agree. Run before any beta commit. |

## Install (Windows)

Requires: Node ≥ 18 and Claude Code installed **and signed in** (Max plan).

```powershell
# from the local-engine folder, with the pinned beta extension ID:
powershell -ExecutionPolicy Bypass -File install\install-windows.ps1 -ExtensionId <PINNED_BETA_ID>
```

Ends with a framed ping through the installed launcher — green `SMOKE PASS (ping)` is
the real done signal. Then FULLY quit and reopen the browser so it re-reads the
registry (Comet: check the tray / Task Manager — a surviving background process keeps
the stale host list).

### claude resolution note

Node on Windows can't spawn a `.cmd` shim with `shell:false` (and `shell:true`
collapses the empty `--setting-sources ''` arg), so the installer + host resolve the
npm shim to its bundled native launcher:
`…\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`. A native-installer
`claude.exe` on PATH is used directly.

## Contract

**ext → host:** `{ system, userMessage, model?, effort?, timeoutMs?, contractVersion? }`
**host → ext:** `{ ok:true, resultText, meta:{ durationMs, helperVersion, contractVersion, claudeVersion } }`
or `{ ok:false, error, detail }` where `error` ∈ `not_logged_in | rate_limited |
claude_not_found | timeout | spawn_failed | bad_envelope | bad_request |
unsupported_contract`.

Major-version mismatch on `contractVersion` → `unsupported_contract` (never runs).

## Status

- **Windows: built + smoke-tested** (framed request → real `claude` draft → framed
  reply, verified on Joe's box).
- **Mac (`install-mac.command`): deferred to the coach-cohort phase** — Joe's own
  demo is Windows. Mac needs login-shell PATH resolution for GUI-spawned Chrome.
