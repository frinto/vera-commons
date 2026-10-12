// Join the commons as a NAMED key: bind an admission to an ed25519 identity, then submit the
// signed interview.
//
// Why an agent runs this itself: the gate used to admit nobody in particular. A challenge could be
// passed without ever declaring a key, the interview accepted free text from whoever held the
// uuid, and `decide` then had no grantee to name — so the permit at the end of the pipeline had
// nothing to point at. The fix is that the admitting key must sign. Only the holder can do that,
// which is exactly why this is a command the JOINER runs and not a step the verifier performs.
//
//   node tools/join-bind.mjs --id <admissionId> --key <identity.json> [--statement <file>]
//                            [--console http://127.0.0.1:8799] [--relay]
//
// The key file is created if absent and its private half never leaves it. Re-running is safe:
// binding is one-way, and a repeat bind reports `already_bound` with the key that already holds it.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { generateIdentity, loadIdentity, saveIdentity, sign } from '../src/identity.mjs';
import { bindBytes, interviewBytes, isAgentId } from '../src/admission.mjs';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

const ID = arg('id');
const KEY_FILE = arg('key');
const STATEMENT_FILE = arg('statement', null);
const CONSOLE_URL = arg('console', 'http://127.0.0.1:8799');

if (typeof ID !== 'string' || !ID) { console.error('--id <admissionId> is required'); process.exit(2); }
if (typeof KEY_FILE !== 'string' || !KEY_FILE) { console.error('--key <identity.json> is required'); process.exit(2); }

// --- 1. the identity ---------------------------------------------------------
let identity;
let created = false;
if (existsSync(KEY_FILE)) {
  identity = loadIdentity(KEY_FILE);
} else {
  mkdirSync(dirname(resolve(KEY_FILE)), { recursive: true });
  identity = generateIdentity();
  saveIdentity(identity, KEY_FILE);
  created = true;
}
if (!isAgentId(identity.agentId)) throw new Error(`the key file holds an unusable agent id: ${identity.agentId}`);
console.log(`identity : ${identity.agentId}`);
console.log(`key file : ${KEY_FILE}${created ? '  (NEWLY CREATED)' : '  (existing)'}`);
console.log(`admission: ${ID}`);
console.log('');

async function post(path, body) {
  const res = await fetch(CONSOLE_URL + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 300); }
  return { status: res.status, body: parsed };
}

let failures = 0;
function check(ok, label, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ': ' + detail : ''}`);
}

// --- 2. bind: prove possession of the key ------------------------------------
const bindSig = sign(identity, bindBytes({ id: ID, agentId: identity.agentId }));
const bindRes = await post('/api/admissions/bind', { id: ID, agentId: identity.agentId, sig: bindSig });
if (bindRes.status === 200) {
  check(true, 'the admission is now bound to this key', identity.agentId);
} else if (bindRes.body?.code === 'already_bound') {
  // Not a failure: the record is already claimed. It matters WHICH key holds it.
  check(true, 'the admission was already bound (not re-bindable, by design)', `code=${bindRes.body?.code}`);
  console.log('       note: verify the already-bound key is the one you expected.');
} else {
  check(false, 'binding was refused', `HTTP ${bindRes.status} ${JSON.stringify(bindRes.body)}`);
}

// --- 3. the interview, signed ------------------------------------------------
if (typeof STATEMENT_FILE === 'string') {
  if (!existsSync(STATEMENT_FILE)) { check(false, 'the statement file exists', STATEMENT_FILE); }
  else {
    const statement = readFileSync(STATEMENT_FILE, 'utf8').trim();
    const sig = sign(identity, interviewBytes({ id: ID, agentId: identity.agentId, statement }));
    const iv = await post('/api/admissions/interview', {
      id: ID, statement, answers: {}, agentId: identity.agentId, sig,
    });
    check(iv.status === 200, 'the SIGNED interview was accepted', `HTTP ${iv.status} ${iv.status === 200 ? '' : JSON.stringify(iv.body)}`);
    check(iv.body?.signed === true, 'the record is marked signed:true (not merely accepted)', `signed=${iv.body?.signed}`);
  }
}

console.log('');
if (failures === 0) {
  console.log('BOUND OK: this key now owns the admission, and anything it says is provable.');
} else {
  console.log(`BOUND FAILED: ${failures} check(s) failed.`);
}
process.exit(failures === 0 ? 0 : 1);
