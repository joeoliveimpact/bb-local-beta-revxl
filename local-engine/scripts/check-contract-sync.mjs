// Contract sync guard — asserts the three hand-mirrored copies of the local-engine
// contract agree. Run before any beta commit (documented in extension-beta/BETA-DIFF.md):
//   node local-engine/scripts/check-contract-sync.mjs      (from production-build/)
// Exit 0 = in sync; exit 1 = drift (printed).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { CONTRACT_VERSION, DEFAULTS, HOST_ERRORS } from '../contract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ext = readFileSync(join(root, 'extension-beta', 'local-engine.js'), 'utf8');
const backend = readFileSync(join(root, 'backend-api', 'src', 'routes', 'generate.ts'), 'utf8');

const problems = [];

// 1. Version mirrored in the extension + backend.
const extVer = ext.match(/LOCAL_ENGINE_CONTRACT_VERSION\s*=\s*'([^']+)'/)?.[1];
if (extVer !== CONTRACT_VERSION) problems.push(`extension local-engine.js version ${extVer} != contract ${CONTRACT_VERSION}`);
const beVer = backend.match(/LOCAL_ENGINE_CONTRACT_VERSION\s*=\s*'([^']+)'/)?.[1];
if (beVer !== CONTRACT_VERSION) problems.push(`backend generate.ts version ${beVer} != contract ${CONTRACT_VERSION}`);

// 2. Host timeout the extension sends must match the contract default (the client
//    watchdog is derived from it — see local-engine.js).
const extTimeout = ext.match(/LOCAL_HOST_TIMEOUT_MS\s*=\s*(\d+)/)?.[1];
if (Number(extTimeout) !== DEFAULTS.timeoutMs) problems.push(`extension LOCAL_HOST_TIMEOUT_MS ${extTimeout} != contract DEFAULTS.timeoutMs ${DEFAULTS.timeoutMs}`);

// 3. Every host error code has a friendly message in the extension map.
for (const code of Object.values(HOST_ERRORS)) {
  if (!new RegExp(`^\\s*${code}:`, 'm').test(ext)) problems.push(`extension error map missing '${code}'`);
}

if (problems.length) {
  console.error('CONTRACT DRIFT:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`contract in sync (${CONTRACT_VERSION})`);
