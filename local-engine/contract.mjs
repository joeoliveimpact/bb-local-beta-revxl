// Local Claude Engine — the single source of truth for the ext <-> host contract.
// Mirrored in extension-beta/local-engine.js and referenced by the backend
// (LOCAL_ENGINE_CONTRACT_VERSION in routes/generate.ts). Any breaking change bumps
// the MAJOR and is ledgered in extension-beta/BETA-DIFF.md. The panel and host do a
// major-version handshake — a mismatch is surfaced, never silently run.

// 1.1.0 (additive, minor — old 1.0 peers keep working via the major handshake):
//   - request may be { type:'ping', deep?, contractVersion } → host replies
//     { ok:true, pong:true, helperVersion, contractVersion, node, os, claudePath,
//       resolved, spawnable, deep? } without spawning a generate.
//   - generate requests may set wantsHeartbeat:true → host emits non-terminal
//     { type:'progress', stage, elapsedMs } frames (~12s apart) until the terminal
//     frame (which always carries an `ok` key). Unknown `type` frames are ignored
//     by both sides.
export const CONTRACT_VERSION = '1.1.0';
export const HELPER_VERSION = '1.1.0';

// Native-messaging host id. Must match the registry key / manifest filename and
// the string the extension passes to chrome.runtime.connectNative().
export const NATIVE_HOST_NAME = 'com.bookingbandit.localengine';

// Fixed generation config (the validated winner: opus + high effort — voice-match
// is the product; the curveball bake-off backed opus-high 5-0). model/effort are
// overridable per-request so the panel can degrade (e.g. cloud fallback) later.
export const DEFAULTS = Object.freeze({
  model: 'opus',
  effort: 'high',
  // opus-high runs 24-42s; 90s gives real headroom before the hard kill.
  timeoutMs: 90000
});

// Read-only tool lockdown — the draft is a pure text generation; no filesystem,
// no web, no subagents. Combined with --setting-sources '' this also neutralizes
// a contaminated dev box (CLAUDE.md / ~50 MCPs) — proven in the 0.5a spike.
export const DISALLOWED_TOOLS = 'Bash,Edit,Write,Read,WebSearch,WebFetch,Glob,Grep,Task';

// host -> ext error codes (the panel maps these to friendly toasts).
export const HOST_ERRORS = Object.freeze({
  NOT_LOGGED_IN: 'not_logged_in',
  RATE_LIMITED: 'rate_limited',
  CLAUDE_NOT_FOUND: 'claude_not_found',
  TIMEOUT: 'timeout',
  SPAWN_FAILED: 'spawn_failed',
  BAD_ENVELOPE: 'bad_envelope',
  BAD_REQUEST: 'bad_request',
  UNSUPPORTED_CONTRACT: 'unsupported_contract'
});

export function majorOf(v) {
  return String(v || '').split('.')[0];
}
