// Standalone smoke test for the native-messaging host — no browser involved.
// Frames a request exactly like Chrome does ([uint32 LE length][utf8 JSON]),
// spawns the host, prints the framed reply, exits 0 (pass) / 1 (fail).
//
//   node scripts/smoke-host.mjs --ping                 # repo host, no claude run
//   node scripts/smoke-host.mjs --deep                 # repo host + tiny real claude run
//   node scripts/smoke-host.mjs --generate             # repo host + real haiku draft
//   node scripts/smoke-host.mjs --ping --host "%LOCALAPPDATA%\BookingBandit\booking-bandit-host.bat"
//                                                      # the EXACT installed chain Chrome spawns
//
// Used by install-windows.ps1 as its end-of-install verification and by
// doctor-windows.ps1 -Ping.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const has = f => args.includes(f);
const argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const CONTRACT_VERSION = '1.1.0';
const hostOverride = argOf('--host');
const repoHost = join(dirname(fileURLToPath(import.meta.url)), '..', 'host', 'main.mjs');

let msg;
let timeoutMs;
if (has('--generate')) {
  // Real end-to-end draft on the cheap tier (spawn + auth + envelope + result).
  msg = {
    system: 'Reply ONLY with a single JSON object: {"reply": "<one short friendly greeting>"} — no prose, no code fences.',
    userMessage: 'Greet me.',
    model: 'haiku',
    effort: 'low',
    timeoutMs: 60000,
    wantsHeartbeat: true,
    contractVersion: CONTRACT_VERSION
  };
  timeoutMs = 90000;
} else {
  msg = { type: 'ping', deep: has('--deep'), contractVersion: CONTRACT_VERSION };
  timeoutMs = has('--deep') ? 60000 : 15000;
}

// Spawn the host the way the browser would: the installed launcher (Win: the .bat
// via cmd.exe; macOS/Linux: the executable .sh directly), or the repo main.mjs via
// node when no --host override is given.
const child = hostOverride
  ? (process.platform === 'win32'
      ? spawn('cmd.exe', ['/c', hostOverride], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
      : spawn(hostOverride, [], { stdio: ['pipe', 'pipe', 'inherit'] }))
  : spawn(process.execPath, [repoHost], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });

const body = Buffer.from(JSON.stringify(msg), 'utf8');
const header = Buffer.alloc(4);
header.writeUInt32LE(body.length, 0);
child.stdin.write(Buffer.concat([header, body]));

let out = Buffer.alloc(0);
let done = false;
const frames = [];

const finish = code => { if (!done) { done = true; try { child.kill(); } catch { /* gone */ } process.exit(code); } };
const killer = setTimeout(() => { console.error(`SMOKE FAIL: no terminal reply in ${timeoutMs}ms`); finish(1); }, timeoutMs);

child.stdout.on('data', d => {
  out = Buffer.concat([out, d]);
  // Drain every complete frame (progress heartbeats arrive before the terminal one).
  while (out.length >= 4) {
    const need = out.readUInt32LE(0);
    if (out.length < 4 + need) break;
    const frame = JSON.parse(out.subarray(4, 4 + need).toString('utf8'));
    out = out.subarray(4 + need);
    frames.push(frame);
    if (frame.type === 'progress') { console.log(`  … progress ${frame.stage} ${frame.elapsedMs}ms`); continue; }
    clearTimeout(killer);
    console.log(JSON.stringify(frame, null, 2));
    if (msg.type === 'ping') {
      const pass = frame.pong === true && frame.spawnable === true && (!msg.deep || frame.deep?.class === 'ok');
      console.log(pass ? 'SMOKE PASS (ping)' : 'SMOKE FAIL (ping)');
      finish(pass ? 0 : 1);
    } else {
      const pass = frame.ok === true && typeof frame.resultText === 'string' && frame.resultText.length > 0;
      console.log(pass ? 'SMOKE PASS (generate)' : `SMOKE FAIL (generate): ${frame.error || 'no result'}`);
      finish(pass ? 0 : 1);
    }
  }
});
child.on('error', e => { console.error('SMOKE FAIL: spawn error:', e.message); finish(1); });
child.on('close', code => { if (!done) { console.error(`SMOKE FAIL: host exited (${code}) with no terminal frame`); finish(1); } });
