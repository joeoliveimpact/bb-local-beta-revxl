// Local Claude Engine (Beta) — all beta-only logic lives here.
//
// Loaded into background.js via importScripts (shared global scope), so it calls
// backendPost / backendPostTimed / STORAGE_KEYS directly. background.js keeps only
// documented patch points (see extension-beta/BETA-DIFF.md); everything else is here.
//
// Flow when the engine is 'local':
//   generateReply → generateReplyLocal
//     1. POST /generate/prompt  → backend assembles {system, userMessage} (no LLM)
//     2. connectNative(host)    → Chrome spawns the helper → claude -p on the Max plan
//        (host streams {type:'progress'} heartbeats — keepalive + hang detection)
//     3. parse the model JSON (+1 repair retry) → adaptRichReplyToPanel (shared)
//     4. POST /generate/local-complete (fire-and-forget) → telemetry + memory
//        (also fired with status:'failed' on any local failure, so the backend can
//         tell an honest failure from the anti-exfil tripwire's stuck rows)

/* global backendPost, backendPostTimed, chrome */

const NATIVE_HOST_NAME = 'com.bookingbandit.localengine';
// Mirrors local-engine/contract.mjs + the backend's LOCAL_ENGINE_CONTRACT_VERSION.
// Bump together; ledgered in extension-beta/BETA-DIFF.md and enforced by
// local-engine/scripts/check-contract-sync.mjs. Major mismatch = host refuses.
const LOCAL_ENGINE_CONTRACT_VERSION = '1.1.0';
const ENGINE_STORAGE_KEY = 'local_engine';   // chrome.storage.local: 'cloud' | 'local'
// Host-side kill timer (mirrors contract DEFAULTS.timeoutMs — sync-checked). The
// client watchdog is DERIVED so the host's own timeout always wins first.
const LOCAL_HOST_TIMEOUT_MS = 90000;
const LOCAL_CLIENT_WATCHDOG_MS = LOCAL_HOST_TIMEOUT_MS + 30000;
// Host heartbeats arrive ~12s apart (contract 1.1); 30s of silence after the first
// one means the host process died mid-run — fail fast instead of riding the watchdog.
const HEARTBEAT_GAP_MS = 30000;
// Backend prompt-assembly is a fast DB+template call; don't let a hung network
// pin the Generate button for minutes.
const LOCAL_BACKEND_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------
// Engine toggle (default 'cloud')
// ---------------------------------------------------------------------

async function getEngine() {
  const { [ENGINE_STORAGE_KEY]: v } = await chrome.storage.local.get(ENGINE_STORAGE_KEY);
  return v === 'local' ? 'local' : 'cloud';
}
async function setEngine(engine) {
  const val = engine === 'local' ? 'local' : 'cloud';
  await chrome.storage.local.set({ [ENGINE_STORAGE_KEY]: val });
  return val;
}
// ACTION_HANDLERS wrappers (panel ↔ background).
async function getEngineState() { return { engine: await getEngine() }; }
async function setEngineState(data) { return { engine: await setEngine(data && data.engine) }; }

// ---------------------------------------------------------------------
// Shared rich-reply → panel-markdown adapter (extracted from generateReply so the
// cloud path and the local path build the exact same markdown). Consumes the cloud
// /generate RESPONSE shape (top-level camelCase: bridgeScore, ifTheyRespond; the
// alternatives array keeps snake_case bridge_score, same as the cloud endpoint).
// ---------------------------------------------------------------------

function adaptRichReplyToPanel(result) {
  const parts = [
    '**SUGGESTED REPLY:**',
    result.reply
  ];
  if (result.stage) parts.push('', `**CONVERSATION STAGE:** ${result.stage}${result.phase ? ` (Phase ${result.phase})` : ''}`);
  if (result.situation) parts.push('', '**CURRENT SITUATION:**', result.situation);
  parts.push('', '**STRATEGIC RATIONALE:**', result.reasoning || '(none given)');
  const scoreLine = [`**CONFIDENCE:** ${result.confidence ?? 'n/a'}`];
  if (typeof result.bridgeScore === 'number') scoreLine.push(`**BRIDGE SCORE:** ${result.bridgeScore}/27`);
  parts.push('', scoreLine.join('   '));
  if (!result.stage && result.phase) parts.push('', `**PHASE:** ${result.phase}`);
  (result.alternatives || []).forEach((alt, i) => {
    if (!alt?.text) return;
    const score = typeof alt.bridge_score === 'number' ? ` (Bridge: ${alt.bridge_score}/27)` : '';
    parts.push('', `**ALTERNATIVE ${i + 1}${alt.angle ? ` ... ${alt.angle.toUpperCase()}` : ''}:**${score}`, alt.text);
  });
  const itr = result.ifTheyRespond;
  if (itr && (itr.minimal || itr.question || itr.detailed || itr.objection)) {
    parts.push('', '**IF THEY RESPOND WITH:**');
    if (itr.minimal) parts.push(`**Minimal:** ${itr.minimal}`);
    if (itr.question) parts.push(`**A question:** ${itr.question}`);
    if (itr.detailed) parts.push(`**Detail/engaged:** ${itr.detailed}`);
    if (itr.objection) parts.push(`**An objection:** ${itr.objection}`);
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------
// Native-messaging transport
// ---------------------------------------------------------------------

// Resolves to the host's framed TERMINAL reply: {ok:true, resultText, meta} |
// {ok:false, error, detail}. Never rejects — connection failures map to a
// {ok:false} envelope the caller maps to an error card.
// Non-terminal {type:'progress'} frames (contract 1.1, only when the request sets
// wantsHeartbeat) are treated as keepalive: they reset the heartbeat-gap timer and
// keep the MV3 service worker's port active during the 30-90s claude run. Frames
// with an unknown `type` are ignored (forward compat).
function runLocalEngine(message, opts = {}) {
  const watchdogMs = opts.watchdogMs || LOCAL_CLIENT_WATCHDOG_MS;
  return new Promise(resolve => {
    let port;
    try { port = chrome.runtime.connectNative(NATIVE_HOST_NAME); }
    catch (e) {
      console.error('[local-engine] connectNative threw:', e);
      resolve({ ok: false, error: 'spawn_failed', detail: String(e && e.message || e) });
      return;
    }

    let settled = false;
    let hbTimer = null;
    const finish = v => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (hbTimer) clearTimeout(hbTimer);
      try { port.disconnect(); } catch { /* already gone */ }
      resolve(v);
    };
    const watchdog = setTimeout(() => finish({ ok: false, error: 'timeout', detail: `no response from local host in ${watchdogMs}ms` }), watchdogMs);

    port.onMessage.addListener(msg => {
      if (msg && msg.type === 'progress') {
        // Heartbeat: host is alive and claude is running. Re-arm the gap timer —
        // silence after this means the host died mid-run.
        console.debug('[local-engine] progress', msg.stage, msg.elapsedMs);
        if (hbTimer) clearTimeout(hbTimer);
        hbTimer = setTimeout(() => finish({ ok: false, error: 'timeout', detail: `host stopped responding (no heartbeat for ${HEARTBEAT_GAP_MS}ms)` }), HEARTBEAT_GAP_MS);
        return;
      }
      if (msg && msg.type && msg.ok === undefined) return; // unknown non-terminal frame: ignore
      console.info('[local-engine] terminal frame:', msg && msg.ok ? 'ok' : `error=${msg && msg.error}`);
      finish(msg);
    });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      // The verbatim lastError is the single most diagnostic string in the chain
      // ("Specified native messaging host not found" = registry/stale-cache issue).
      console.error('[local-engine] port disconnected. lastError:', err ? err.message : '(none)');
      finish({ ok: false, error: 'spawn_failed', detail: err ? err.message : 'host disconnected before replying' });
    });

    try { port.postMessage(message); }
    catch (e) {
      console.error('[local-engine] postMessage threw:', e);
      finish({ ok: false, error: 'spawn_failed', detail: String(e && e.message || e) });
    }
  });
}

// host error code → friendly, actionable message. Every command referenced here
// EXISTS (installer + doctor live in production-build/local-engine/install/).
function localEngineError(host) {
  const detail = String(host && host.detail || '');
  const notInstalled = /not found|no such native|not installed|forbidden|specified native/i.test(detail);
  const map = {
    not_logged_in: 'Claude Code isn\'t signed in on this machine. Open a terminal, run "claude", sign in, then try again ... or switch to Cloud.',
    rate_limited: 'Your Claude Max plan hit its rate limit. Wait a bit, or switch to Cloud for this one.',
    claude_not_found: 'Claude Code wasn\'t found on this machine. Install Claude Code, then re-run the helper installer (install-windows.ps1) ... or switch to Cloud.',
    timeout: 'The local draft took too long and was stopped. Try again, or switch to Cloud.',
    spawn_failed: notInstalled
      ? 'The browser can\'t find the Booking Bandit helper. Re-run the helper installer (install-windows.ps1), then FULLY quit this browser (check the tray / Task Manager ... closing the window isn\'t enough) and reopen it. Then use Settings → Key → "Test local engine" to confirm.'
      : 'The local helper couldn\'t start. Run the doctor script (doctor-windows.ps1) to see why, or switch to Cloud.',
    bad_envelope: 'The local draft came back malformed. Try again, or switch to Cloud.',
    bad_request: 'The local helper rejected the request. Run the doctor script (doctor-windows.ps1), or switch to Cloud.',
    unsupported_contract: 'Your local helper is out of date. Re-run the helper installer (install-windows.ps1), or switch to Cloud.'
  };
  const e = new Error(map[host && host.error] || `Local engine error: ${(host && host.error) || 'unknown'}. Switch to Cloud?`);
  e.localEngine = true;
  e.engineError = (host && host.error) || 'unknown';
  e.engineDetail = detail;
  return e;
}

// ---------------------------------------------------------------------
// Self-test (contract 1.1 ping) — exercises the REAL connectNative chain.
// ---------------------------------------------------------------------

// ACTION_HANDLERS entry. data: { deep?: boolean }. Returns a structured result the
// panel renders green/red; never throws.
async function selfTestLocalEngine(data) {
  const deep = Boolean(data && data.deep);
  const started = Date.now();
  const host = await runLocalEngine(
    { type: 'ping', deep, contractVersion: LOCAL_ENGINE_CONTRACT_VERSION },
    { watchdogMs: deep ? 45000 : 10000 }
  );
  const ms = Date.now() - started;
  if (host && host.pong) {
    const deepOk = !deep || (host.deep && host.deep.class === 'ok');
    return {
      ok: Boolean(host.spawnable && deepOk),
      ms,
      helperVersion: host.helperVersion,
      contractVersion: host.contractVersion,
      claudePath: host.claudePath,
      resolvedFrom: host.resolvedFrom,
      spawnable: host.spawnable,
      deep: host.deep || null
    };
  }
  // A 1.0 host answers a ping with bad_request — that's "helper out of date".
  const friendly = (host && host.error === 'bad_request')
    ? 'The installed helper is out of date (pre-1.1). Re-run the helper installer (install-windows.ps1).'
    : localEngineError(host).message;
  return { ok: false, ms, error: (host && host.error) || 'unknown', detail: String(host && host.detail || ''), friendly };
}

// ---------------------------------------------------------------------
// Failure telemetry — transition the tripwire row → 'failed' (fire-and-forget).
// ---------------------------------------------------------------------

// Only called when /generate/prompt succeeded (a prompt_issued row exists). Never
// blocks or rethrows; the DM bodies ride only because the schema requires the
// conversation (same content already sent to /generate/prompt seconds earlier).
function reportLocalFailure(prompt, data, conversation, errorCode, startedAt) {
  try {
    if (!prompt || !prompt.requestId) return;
    backendPostTimed('/generate/local-complete', {
      requestId: prompt.requestId,
      platform: data.platform,
      conversation,
      threadId: data.threadId || undefined,
      status: 'failed',
      errorCode: String(errorCode || 'unknown').slice(0, 40),
      meta: {
        exitClass: String(errorCode || 'unknown').slice(0, 40),
        durationMs: Date.now() - startedAt,
        extVersion: chrome.runtime.getManifest().version
      }
    }, LOCAL_BACKEND_TIMEOUT_MS).catch(() => { /* telemetry never surfaces */ });
  } catch { /* never let telemetry throw into the generate path */ }
}

// ---------------------------------------------------------------------
// Model-output JSON parsing (tolerant + one repair round-trip)
// ---------------------------------------------------------------------

function extractJson(text) {
  if (typeof text !== 'string') return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* try brace-slice */ }
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(t.slice(s, e + 1)); } catch { /* give up */ }
  }
  return null;
}

// ---------------------------------------------------------------------
// Local generate
// ---------------------------------------------------------------------

async function generateReplyLocal(data, conversation) {
  const startedAt = Date.now();

  // 1. Backend assembles the prompt (KB stays server-side; NO LLM call here).
  //    Timed fetch: a hung backend must not pin the Generate button (fragile #5).
  //    Gate errors (kill switches) map to specific, actionable messages — the
  //    engine preference deliberately STAYS 'local' (no silent fallback).
  let prompt;
  try {
    prompt = await backendPostTimed('/generate/prompt', {
      platform: data.platform,
      conversation,
      userNotes: data.userNotes || undefined,
      threadId: data.threadId || undefined
    }, LOCAL_BACKEND_TIMEOUT_MS);
  } catch (err) {
    const gateMap = {
      not_found: 'The Local engine beta is paused server-side right now. Switch to Cloud in Settings → Key to keep drafting.',
      local_engine_not_allowed: 'Local engine isn\'t enabled for this account. Switch to Cloud in Settings → Key (or ask about beta access).',
      setup_incomplete: 'Finish your business setup first (Settings → Profile), then try the Local engine again.'
    };
    const friendly = gateMap[err && err.message];
    if (friendly) {
      console.error('[local-engine] /generate/prompt gated:', err.message);
      const e = new Error(friendly);
      e.localEngine = true;
      e.engineError = 'beta_gate';
      e.engineDetail = String(err.message || '');
      throw e;
    }
    throw err; // auth/paywall/network errors keep their existing handling
  }

  // 2. Run it on the user's own machine (heartbeats on — contract 1.1).
  const host = await runLocalEngine({
    system: prompt.system,
    userMessage: prompt.userMessage,
    timeoutMs: LOCAL_HOST_TIMEOUT_MS,
    wantsHeartbeat: true,
    contractVersion: LOCAL_ENGINE_CONTRACT_VERSION
  });
  if (!host.ok) {
    reportLocalFailure(prompt, data, conversation, host.error, startedAt);
    throw localEngineError(host);
  }

  // 3. Parse the model JSON; one repair round-trip if it came back messy.
  let raw = extractJson(host.resultText);
  if (!raw || typeof raw.reply !== 'string') {
    console.warn('[local-engine] model JSON malformed; running one repair round-trip');
    const repair = await runLocalEngine({
      system: 'You are a JSON reformatter. Output ONLY a single valid JSON object and nothing else — no prose, no code fences.',
      userMessage: 'Reformat the following into one valid JSON object with the same keys and values:\n\n' + String(host.resultText || ''),
      timeoutMs: 60000,
      wantsHeartbeat: true,
      contractVersion: LOCAL_ENGINE_CONTRACT_VERSION
    }, { watchdogMs: 60000 + 30000 });
    if (repair.ok) raw = extractJson(repair.resultText);
  }
  if (!raw || typeof raw.reply !== 'string') {
    reportLocalFailure(prompt, data, conversation, 'malformed_output', startedAt);
    const e = new Error('The local draft came back malformed. Try again, or switch to Cloud.');
    e.localEngine = true;
    e.engineError = 'malformed_output';
    e.engineDetail = 'model JSON unparseable after one repair attempt';
    throw e;
  }

  // Normalize the raw model JSON to the cloud /generate RESPONSE shape the adapter
  // expects (snake_case bridge_score/if_they_respond → camelCase top level).
  const result = {
    reply: raw.reply,
    confidence: raw.confidence ?? null,
    reasoning: raw.reasoning ?? null,
    phase: raw.phase ?? null,
    stage: raw.stage ?? null,
    situation: raw.situation ?? null,
    bridgeScore: typeof raw.bridge_score === 'number' ? raw.bridge_score : null,
    alternatives: Array.isArray(raw.alternatives) ? raw.alternatives : [],
    ifTheyRespond: raw.if_they_respond ?? null
  };
  const reply = adaptRichReplyToPanel(result);

  // 4. Fire-and-forget: transition the tripwire row → success + restore memory.
  let os = 'unknown';
  try { os = (await chrome.runtime.getPlatformInfo()).os; } catch { /* best-effort */ }
  backendPostTimed('/generate/local-complete', {
    requestId: prompt.requestId,
    platform: data.platform,
    conversation,
    threadId: data.threadId || undefined,
    draft: result.reply,
    phase: typeof result.phase === 'number' ? result.phase : undefined,
    meta: {
      ...(host.meta || {}),
      os,
      extVersion: chrome.runtime.getManifest().version
    }
  }, LOCAL_BACKEND_TIMEOUT_MS).catch(() => { /* telemetry never blocks a rendered draft */ });

  // Local engine is comped/unlimited — no credit meter to move.
  return {
    reply,
    credits: null,
    alternatives: result.alternatives,
    stage: result.stage,
    bridgeScore: result.bridgeScore
  };
}
