// The console's trust-shape validator must accept what the REAL producer emits.
//
// Why this file exists, separate from console-trust-integrity.test.mjs: that test builds its
// "valid" permit by hand. A hand-made fixture proves the validator rejects nonsense; it does NOT
// prove the validator accepts a bundle written by src/permit.mjs. A validator stricter than the
// producer would declare every legitimate trust file corrupt — fail-closed, but the console would
// be unusable and the error would look like tampering. This test closes that gap by constructing
// the bundle with the real `issuePermit` + `exportTrustBundle`, running the console's own
// `readTrustStatus`/`readTrust` over it, and then demanding that the validated bytes still yield
// the authority the issuer intended through the real `resolveTrust`. Mutants of that same real
// bundle must be rejected.
//
// Frozen run artifact for round 55: .tmp/trust-real-bundle-probe.mjs (20 passed / 0 failed, exit 0).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateIdentity } from '../src/identity.mjs';
import { issuePermit, exportTrustBundle, resolveTrust } from '../src/permit.mjs';
import { isAgentId } from '../src/admission.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(join(HERE, '..', 'console', 'app.mjs'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}
const statusSrc = extractFn(APP, 'readTrustStatus');
const readSrc = extractFn(APP, 'readTrust');

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}

// The console's own dependencies are injected: the REAL isAgentId, a silent console.
function readersFor(text, exists = true) {
  const factory = new Function('existsSync', 'readFileSync', 'isAgentId', 'console', 'TRUST_FILE',
    `${statusSrc}\n${readSrc}\nreturn { readTrustStatus, readTrust };`);
  return factory(() => exists, () => text, isAgentId, { warn() {} }, 'trust.json');
}

check('extracted both readers from the shipped console source', Boolean(statusSrc && readSrc));

// --- the real producer -------------------------------------------------------
const root = generateIdentity();
const member = generateIdentity();
const outsider = generateIdentity();
const grant = issuePermit(root, { type: 'grant', grantee: member.agentId, level: 'poster', seq: 1 });
const revoke = issuePermit(root, { type: 'revoke', target: outsider.agentId, seq: 2 });
const bundle = exportTrustBundle({ permits: [grant, revoke], roots: [root.agentId] });

// Printed so a failure can be diagnosed from the chain log alone.
console.log(`  producer emitted keys: ${Object.keys(grant).sort().join(',')} (grant)`);
console.log(`  bundle shape: kind=${bundle.kind} v=${bundle.v} roots=${bundle.roots.length} permits=${bundle.permits.length}`);

const status = readersFor(JSON.stringify(bundle)).readTrustStatus();
check('a REAL bundle from the real producer is accepted as valid',
  status.ok && status.state === 'valid' && status.counts.roots === 1 && status.counts.permits === 2,
  JSON.stringify(status));

let consumed = null;
try { consumed = readersFor(JSON.stringify(bundle)).readTrust(); } catch (err) { consumed = err.code; }
check('the real bundle is consumable, not just describable',
  consumed && !(typeof consumed === 'string') && consumed.permits.length === 2);

// The end of the chain that matters: validated bytes -> actual authority.
const resolved = consumed && typeof consumed === 'object' ? resolveTrust(consumed.permits, consumed.roots) : null;
check('validated trust yields the authority the issuer intended (member = poster)',
  Boolean(resolved) && resolved.levels.get(member.agentId) === 'poster',
  resolved ? JSON.stringify([...resolved.levels]) : 'not resolved');
check('a revoke in the same bundle is honoured (outsider has no level)',
  Boolean(resolved) && !resolved.levels.has(outsider.agentId));

// --- mutants of the REAL bundle must be rejected -----------------------------
const mutate = (fn) => { const copy = JSON.parse(JSON.stringify(bundle)); fn(copy); return readersFor(JSON.stringify(copy)).readTrustStatus(); };
const mutants = [
  ['invented level in a real grant', (c) => { c.permits[0].level = 'root'; }],
  ['seq zeroed below the producer minimum', (c) => { c.permits[0].seq = 0; }],
  ['non-integer seq', (c) => { c.permits[0].seq = 1.5; }],
  ['signature removed', (c) => { delete c.permits[0].sig; }],
  ['signature blanked', (c) => { c.permits[0].sig = ''; }],
  ['issuer replaced with a non-identity', (c) => { c.permits[0].issuer = 'root'; }],
  ['grantee equal to issuer', (c) => { c.permits[0].grantee = c.permits[0].issuer; }],
  ['revoke given a grantee instead of a target', (c) => { delete c.permits[1].target; c.permits[1].grantee = member.agentId; }],
  ['permit version bumped', (c) => { c.permits[0].v = 2; }],
  ['roots degenerated to a bare identity string', (c) => { c.roots = root.agentId; }],
  ['permits degenerated to an object map', (c) => { c.permits = { 0: c.permits[0] }; }],
  ['permit list carrying null', (c) => { c.permits.push(null); }],
  ['issuedAt removed', (c) => { delete c.permits[0].issuedAt; }],
  ['notAfter set to a string', (c) => { c.permits[0].notAfter = 'never'; }],
];
for (const [name, fn] of mutants) {
  const m = mutate(fn);
  check(`rejects: ${name}`, !m.ok && m.state === 'integrity-failure' && m.reason === 'invalid_shape', JSON.stringify(m));
}

// `notAfter: null` is what issuePermit actually writes for a permit that never expires; a
// validator that rejected null would reject every ordinary permit.
check('the producer really does emit notAfter: null on an ordinary permit', grant.notAfter === null);

console.log(`console-trust-real-bundle: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
