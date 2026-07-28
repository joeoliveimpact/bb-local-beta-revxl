// Local Claude Engine — native-messaging host.
//
// Chrome spawns this once per draft (stateless — no daemon, no port), hands it one
// framed message on stdin, and reads one framed reply on stdout. It runs the
// coach's own Claude Code (`claude -p`) on their Max subscription, so no API key is
// ever used and nothing is billed to the house.
//
// Native messaging framing: [uint32 LE length][utf8 JSON] in both directions.
//   ext  -> host: { system, userMessage, model?, effort?, timeoutMs?, contractVersion?,
//                   wantsHeartbeat? }                       (generate)
//                 { type:'ping', deep?, contractVersion? }  (self-test, 1.1)
//   host -> ext:  { ok:true, resultText, meta } | { ok:false, error, detail }
//                 { type:'progress', stage, elapsedMs }     (non-terminal, only when
//                                                            wantsHeartbeat — 1.1)
//
// Hard guarantees:
//   - subscription auth only: API-key / alt-provider env vars are stripped from the
//     child so `claude` can never silently bill a key (D6 guardrail).
//   - the KB system prompt is written to a 0600 temp file in a non-synced dir and
//     deleted in every exit path (including SIGTERM/uncaught + port teardown; a
//     startup sweep catches anything a hard kill still leaked).
//   - the prompt / DM bodies are NEVER logged — the diagnostic log (logs/host.log)
//     records stages, lengths, hashes, exit codes, and claude's own stderr snippet
//     only.

import { spawn } from 'node:child_process';
import {
  mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, appendFileSync,
  statSync, renameSync, readdirSync
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import process from 'node:process';
import {
  CONTRACT_VERSION, HELPER_VERSION, DEFAULTS, DISALLOWED_TOOLS, HOST_ERRORS, majorOf
} from '../contract.mjs';

const IS_WIN = process.platform === 'win32';
// Native messaging frames from the browser are small (a prompt tops out well under
// 1 MB); anything bigger is a corrupt header — refuse before buffering it.
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const HEARTBEAT_MS = 12000;

// --- Paths ----------------------------------------------------------------------

// Never OneDrive-synced: LOCALAPPDATA on Windows, Application Support on Mac.
function installDir() {
  if (IS_WIN) return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'BookingBandit');
  return join(homedir(), 'Library', 'Application Support', 'BookingBandit');
}
function engineWorkdir() { return join(installDir(), 'workdir'); }
function logDir() { return join(installDir(), 'logs'); }

// --- Diagnostic log (privacy-safe: stages/lengths/hashes/errors, never bodies) ---

const LOG_MAX_BYTES = 512 * 1024;

function log(stage, fields = {}) {
  try {
    mkdirSync(logDir(), { recursive: true });
    const file = join(logDir(), 'host.log');
    try {
      if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) {
        renameSync(file, join(logDir(), 'host.log.1')); // replaces the old .1
      }
    } catch { /* rotation is best-effort */ }
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, stage, ...fields }) + '\n');
  } catch { /* logging must never break the host */ }
}

function sha256(s) {
  try { return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16); }
  catch { return null; }
}

// --- Exit hygiene ----------------------------------------------------------------
// One live request at a time (stateless host), so module-level cleanup state is safe.

let currentSysFile = null;
let currentChild = null;

function cleanup() {
  if (currentSysFile) { try { rmSync(currentSysFile, { force: true }); } catch { /* best-effort */ } currentSysFile = null; }
  if (currentChild) { try { currentChild.kill('SIGKILL'); } catch { /* already dead */ } currentChild = null; }
}

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => { log('fatal', { reason: sig }); cleanup(); process.exit(0); });
}
process.on('uncaughtException', e => { log('fatal', { reason: 'uncaughtException', detail: String(e && e.message || e).slice(0, 300) }); cleanup(); process.exit(1); });
process.on('unhandledRejection', e => { log('fatal', { reason: 'unhandledRejection', detail: String(e && e.message || e).slice(0, 300) }); cleanup(); process.exit(1); });

// A hard kill (browser/OS) can still leak a temp prompt file — sweep stale ones on
// every start so nothing outlives its request by more than a few minutes.
function sweepWorkdir() {
  try {
    const dir = engineWorkdir();
    if (!existsSync(dir)) return;
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const f of readdirSync(dir)) {
      if (!/^sys-.*\.txt$/.test(f)) continue;
      try { if (statSync(join(dir, f)).mtimeMs < cutoff) rmSync(join(dir, f), { force: true }); } catch { /* skip */ }
    }
  } catch { /* best-effort */ }
}

// --- Native-messaging framing ---------------------------------------------------

function readMessage() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let need = null;
    process.stdin.on('data', d => {
      chunks.push(d);
      total += d.length;
      const buf = Buffer.concat(chunks, total);
      if (need === null && buf.length >= 4) {
        need = buf.readUInt32LE(0);
        if (need > MAX_FRAME_BYTES) { reject(new Error('frame_too_large')); return; }
      }
      if (need !== null && buf.length >= 4 + need) {
        const body = buf.subarray(4, 4 + need).toString('utf8');
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('bad_frame')); }
      }
    });
    process.stdin.on('end', () => { if (need === null) reject(new Error('no_message')); });
    process.stdin.on('error', reject);
  });
}

function writeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

// --- claude resolution ----------------------------------------------------------

// Node on Windows refuses to spawn a .cmd/.bat with shell:false (EINVAL), and
// shell:true would collapse the empty `--setting-sources ''` arg — so we need a
// real .exe. The npm-global `claude` shim wraps a bundled native launcher at
// <shim-dir>\node_modules\@anthropic-ai\claude-code\bin\claude.exe; resolve to it.
function spawnableExe(p) {
  if (!IS_WIN) return p;
  if (/\.exe$/i.test(p)) return p;
  const bundled = join(dirname(p), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  return existsSync(bundled) ? bundled : null;
}

// Prefer the installer-resolved cache; else an env override; else probe PATH. Every
// source is spawnability-validated (a cached .cmd — e.g. written by an old installer
// or gone stale after a claude move — self-heals to a re-resolved .exe instead of
// guaranteeing a spawn EINVAL).
function resolveClaudeDetailed() {
  const cfg = join(engineWorkdir(), 'claude-path.txt');
  let cacheRaw = null;
  if (existsSync(cfg)) {
    cacheRaw = readFileSync(cfg, 'utf8').trim();
    if (cacheRaw && existsSync(cacheRaw)) {
      const exe = spawnableExe(cacheRaw);
      if (exe && existsSync(exe)) {
        if (exe !== cacheRaw) { // heal the cache in place (e.g. .cmd -> bundled .exe)
          try { writeFileSync(cfg, exe, { encoding: 'utf8' }); } catch { /* best-effort */ }
          return { path: exe, source: 'cache-healed', cacheRaw };
        }
        return { path: exe, source: 'cache', cacheRaw };
      }
    }
  }
  if (process.env.BB_CLAUDE_BIN && existsSync(process.env.BB_CLAUDE_BIN)) {
    const exe = spawnableExe(process.env.BB_CLAUDE_BIN);
    if (exe && existsSync(exe)) return { path: exe, source: 'env', cacheRaw };
  }

  const names = IS_WIN ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  const dirs = (process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        const exe = spawnableExe(candidate);
        if (exe) {
          // Persist so the next run (and the doctor) sees the healed resolution.
          try { mkdirSync(engineWorkdir(), { recursive: true }); writeFileSync(cfg, exe, { encoding: 'utf8' }); } catch { /* best-effort */ }
          return { path: exe, source: 'path', cacheRaw };
        }
      }
    }
  }
  return { path: null, source: 'none', cacheRaw };
}

// Force subscription auth: strip anything that would make claude use an API key or
// an alternate provider.
function cleanEnv() {
  const e = { ...process.env };
  for (const k of [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'CLAUDE_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_BEARER_TOKEN_BEDROCK'
  ]) delete e[k];
  return e;
}

// --- claude envelope parsing ----------------------------------------------------

// The CLI's --output-format json SHOULD be clean JSON on stdout, but we don't
// control what future versions print around it (update banners, notices). Mirror
// the extension's tolerant extractJson: exact parse first, then brace-slice.
function parseEnvelope(stdout) {
  const t = String(stdout || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* try brace-slice */ }
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(t.slice(s, e + 1)); } catch { /* give up */ }
  }
  return null;
}

// --- child runner ----------------------------------------------------------------

// Spawn claude, collect stdout/stderr, SIGKILL past timeoutMs. Never rejects.
function collectChild(claudeBin, args, input, timeoutMs) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(claudeBin, args, { cwd: engineWorkdir(), env: cleanEnv(), shell: false, windowsHide: true });
    } catch (e) { // spawn can throw SYNCHRONOUSLY (EINVAL on a .cmd, ENOENT on a bad path)
      resolve({ spawnError: String((e && e.message) || e) });
      return;
    }
    currentChild = child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = out => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      currentChild = null;
      resolve(out);
    };
    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.on('error', e => finish({ spawnError: String((e && e.message) || e) }));
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.stdin.on('error', () => { /* claude closed stdin early; close handler decides outcome */ });
    child.stdin.write(input);
    child.stdin.end();
    child.on('close', code => { if (!timedOut) finish({ code, stdout, stderr }); });
  });
}

// Classify a failed run into a contract error code + safe detail.
function classifyFailure(run, env0) {
  if (run.spawnError) return { error: HOST_ERRORS.SPAWN_FAILED, detail: run.spawnError };
  if (run.timedOut) return { error: HOST_ERRORS.TIMEOUT, detail: `exceeded timeout` };
  const status = env0 ? env0.api_error_status : undefined;
  const stderr = run.stderr || '';
  if (status === 401 || (run.code !== 0 && /log ?in|unauthor|authenticat|invalid api key/i.test(stderr))) {
    return { error: HOST_ERRORS.NOT_LOGGED_IN, detail: 'claude is not logged in' };
  }
  if (status === 429 || /rate.?limit|usage limit|429/i.test(stderr)) {
    return { error: HOST_ERRORS.RATE_LIMITED, detail: 'Max plan rate limit reached' };
  }
  if (!env0) {
    return { error: HOST_ERRORS.BAD_ENVELOPE, detail: (stderr || run.stdout || '').slice(0, 300) || `exit ${run.code}` };
  }
  return { error: HOST_ERRORS.BAD_ENVELOPE, detail: `exit ${run.code}, status ${status ?? '?'}` };
}

// --- ping (self-test, contract 1.1) ----------------------------------------------

async function handlePing(msg) {
  const resolved = resolveClaudeDetailed();
  const reply = {
    ok: true,
    pong: true,
    helperVersion: HELPER_VERSION,
    contractVersion: CONTRACT_VERSION,
    node: process.version,
    os: process.platform,
    claudePath: resolved.path,
    resolvedFrom: resolved.source,
    spawnable: Boolean(resolved.path)
  };
  if (msg.deep === true && resolved.path) {
    // Tiny real run — proves spawn + auth + envelope end-to-end on the cheap tier.
    const args = [
      '-p', '--output-format', 'json',
      '--input-format', 'text',
      '--model', 'haiku',
      '--effort', 'low',
      '--max-turns', '1',
      '--setting-sources', '',
      '--strict-mcp-config',
      '--disallowed-tools', DISALLOWED_TOOLS
    ];
    const run = await collectChild(resolved.path, args, 'Reply with exactly: pong', 30000);
    const env0 = parseEnvelope(run.stdout);
    if (!run.spawnError && !run.timedOut && env0 && !env0.is_error && run.code === 0 && typeof env0.result === 'string' && env0.result.trim()) {
      reply.deep = { ran: true, class: 'ok' };
    } else {
      const fail = classifyFailure(run, env0);
      reply.deep = { ran: true, class: fail.error, detail: String(fail.detail || '').slice(0, 300) };
    }
  }
  log('respond', { kind: 'ping', deep: msg.deep === true, spawnable: reply.spawnable, deepClass: reply.deep?.class });
  writeMessage(reply);
  process.exit(0);
}

// --- Main -----------------------------------------------------------------------

async function main() {
  sweepWorkdir();
  log('start', { helperVersion: HELPER_VERSION, node: process.version });

  let msg;
  try { msg = await readMessage(); }
  catch (e) {
    const why = String(e && e.message || e);
    log('respond', { ok: false, errorCode: HOST_ERRORS.BAD_REQUEST, detail: why });
    writeMessage({ ok: false, error: HOST_ERRORS.BAD_REQUEST, detail: `could not read request frame (${why})` });
    process.exit(0); return;
  }

  if (msg.contractVersion && majorOf(msg.contractVersion) !== majorOf(CONTRACT_VERSION)) {
    log('respond', { ok: false, errorCode: HOST_ERRORS.UNSUPPORTED_CONTRACT, extVersion: msg.contractVersion });
    writeMessage({ ok: false, error: HOST_ERRORS.UNSUPPORTED_CONTRACT, detail: `host ${CONTRACT_VERSION}, extension ${msg.contractVersion}` });
    process.exit(0); return;
  }

  if (msg.type === 'ping') { await handlePing(msg); return; }

  const system = typeof msg.system === 'string' ? msg.system : '';
  const userMessage = typeof msg.userMessage === 'string' ? msg.userMessage : '';
  if (!system || !userMessage) {
    log('respond', { ok: false, errorCode: HOST_ERRORS.BAD_REQUEST, detail: 'missing system or userMessage' });
    writeMessage({ ok: false, error: HOST_ERRORS.BAD_REQUEST, detail: 'missing system or userMessage' });
    process.exit(0); return;
  }
  const model = (typeof msg.model === 'string' && msg.model) ? msg.model : DEFAULTS.model;
  const effort = (typeof msg.effort === 'string' && msg.effort) ? msg.effort : DEFAULTS.effort;
  const timeoutMs = Number.isFinite(msg.timeoutMs) ? Math.min(Math.max(msg.timeoutMs, 5000), 180000) : DEFAULTS.timeoutMs;

  const resolved = resolveClaudeDetailed();
  log('resolve', { source: resolved.source, healed: resolved.source === 'cache-healed' });
  if (!resolved.path) {
    log('respond', { ok: false, errorCode: HOST_ERRORS.CLAUDE_NOT_FOUND });
    writeMessage({ ok: false, error: HOST_ERRORS.CLAUDE_NOT_FOUND, detail: 'claude executable not found on PATH' });
    process.exit(0); return;
  }

  const workdir = engineWorkdir();
  mkdirSync(workdir, { recursive: true });
  const sysFile = join(workdir, `sys-${randomUUID()}.txt`);
  writeFileSync(sysFile, system, { encoding: 'utf8', mode: 0o600 });
  currentSysFile = sysFile;

  // If the browser tears the port down mid-run (panel closed, SW killed, browser
  // quit), stdin ends — kill the claude child and clean up instead of orphaning it.
  process.stdin.on('end', () => {
    if (currentChild || currentSysFile) {
      log('fatal', { reason: 'port_closed_mid_run' });
      cleanup();
      process.exit(0);
    }
  });

  // Validated flag set. Empty `--setting-sources ''` (a distinct argv element under
  // shell:false) kills client CLAUDE.md/skills/hooks/MCP contamination.
  const args = [
    '-p', '--output-format', 'json',
    '--system-prompt-file', sysFile,
    '--input-format', 'text',
    '--model', model,
    '--effort', effort,
    '--max-turns', '1',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--disallowed-tools', DISALLOWED_TOOLS
  ];

  const started = Date.now();
  log('spawn', {
    model, effort, timeoutMs,
    sysLen: system.length, sysSha: sha256(system),
    userLen: userMessage.length, userSha: sha256(userMessage),
    wantsHeartbeat: msg.wantsHeartbeat === true
  });

  // Non-terminal progress frames: keep the MV3 service worker's port active during
  // the 30-90s run, prove host liveness to the panel, and let it show elapsed time.
  // Old extensions never set wantsHeartbeat and never see these.
  let heartbeat = null;
  if (msg.wantsHeartbeat === true) {
    heartbeat = setInterval(() => {
      try { writeMessage({ type: 'progress', stage: 'claude_running', elapsedMs: Date.now() - started }); }
      catch { /* stdout gone; stdin-end handler will clean up */ }
    }, HEARTBEAT_MS);
  }

  const respond = obj => {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    try { rmSync(sysFile, { force: true }); } catch { /* best-effort cleanup */ }
    currentSysFile = null;
    log('respond', {
      ok: obj.ok === true,
      errorCode: obj.ok ? undefined : obj.error,
      detail: obj.ok ? undefined : String(obj.detail || '').slice(0, 300),
      durationMs: Date.now() - started
    });
    writeMessage(obj);
    process.exit(0);
  };

  const run = await collectChild(resolved.path, args, userMessage, timeoutMs);
  const env0 = parseEnvelope(run.stdout);
  log('close', {
    exitCode: run.code, timedOut: run.timedOut === true, spawnError: run.spawnError ? run.spawnError.slice(0, 200) : undefined,
    stdoutLen: (run.stdout || '').length, stderrLen: (run.stderr || '').length, parsed: Boolean(env0)
  });

  const isError = run.spawnError || run.timedOut || (env0 && env0.is_error) || run.code !== 0 || !env0;
  if (isError) {
    const fail = classifyFailure(run, env0);
    if (fail.error === HOST_ERRORS.TIMEOUT) fail.detail = `exceeded ${timeoutMs}ms`;
    respond({ ok: false, error: fail.error, detail: fail.detail });
    return;
  }

  const resultText = typeof env0.result === 'string' ? env0.result : '';
  if (!resultText) { respond({ ok: false, error: HOST_ERRORS.BAD_ENVELOPE, detail: 'empty result' }); return; }

  respond({
    ok: true,
    resultText,
    meta: {
      durationMs: Date.now() - started,
      helperVersion: HELPER_VERSION,
      contractVersion: CONTRACT_VERSION,
      claudeVersion: (env0 && env0.model) || null
    }
  });
}

main();
