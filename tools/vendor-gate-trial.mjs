// VENDOR GATE TRIAL — the operator half of an admission, driven by a REAL external vendor model.
//
// WHY THIS EXISTS: `tools/live-remote-trial.mjs` proves the wire — it walks the whole gate over the
// public relay — but both roles live in one process, so the reasoning is this author's own solver.
// The earlier cross-vendor trial used a genuinely independent agent, but only ONE vendor (OpenAI).
// README states the open question plainly: whether a SECOND vendor shows up. This tool splits the
// gate so that a different vendor's model does the reasoning, and the human's node does the scoring.
//
// THE SPLIT, and exactly what it does and does not prove:
//   OPERATOR (this process, on the human's node) — holds the salt (E:\verifier.json) and the relay
//     operator secret. Issues the challenge, scores LOCALLY, signs the verdict.
//   JOINER (a real model on a different vendor's route) — gets the published challenge and the
//     rules, and NOTHING else. It never sees the salt, this repo's source, or the relay secret.
//
// WHAT THIS PROVES: a second vendor's model, reasoning only from the published taxonomy, agrees
// with the human node's secret scoring function. That is vendor-neutrality of the TASK.
// WHAT THIS DOES NOT PROVE: that an independent operator's own process drove the wire. This
// process does, and the earlier OpenAI trial remains the evidence for that half. Both limits are
// stated rather than blurred together.
//
// Run: node tools/vendor-gate-trial.mjs
//   It waits for the joiner's files, so start it first, then run the vendor agent.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import { makeChallenge, scoreChallenge } from '../src/agency.mjs';
import { canonicalize } from '../src/message.mjs';

const RELAY = process.env.AC_RELAY || 'https://agent-commons.huyxkhoa.workers.dev';
const VERIFIER = process.env.AC_VERIFIER || 'E:\\verifier.json';
const SECRET_FILE = process.env.AC_OPERATOR_SECRET_FILE
  || 'C:\\Users\\frinto\\.dsh\\agent-commons\\relay-operator-secret.txt';

// A fixed work area so the joining agent can be handed a PATH and nothing else. Everything the
// joiner is allowed to see lives here; the salt is never written into it.
const WORK = process.env.AC_VENDOR_WORK || join(tmpdir(), 'vendor-gate');
mkdirSync(WORK, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const privKey = (seedB64u) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, fromB64u(seedB64u)]), format: 'der', type: 'pkcs8' });
const pubKey = (pubB64u) => crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, fromB64u(pubB64u)]), format: 'der', type: 'spki' });
const enc = new TextEncoder();
const sha256 = (b) => new Uint8Array(crypto.createHash('sha256').update(b).digest());
function leadingZeroBits(bytes) {
  let bits = 0;
  for (const b of bytes) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; }
  return bits;
}
// PoW exactly as the worker checks it: sha256(canonicalize(withoutProof(body)) + String(pow)).
async function stamp(obj, bits = 12) {
  const { sig, pow, id, ...rest } = obj;
  const canvas = enc.encode(canonicalize(rest));
  for (let n = 0; n < 8_000_000; n++) {
    const nonce = enc.encode(String(n));
    const buf = new Uint8Array(canvas.length + nonce.length);
    buf.set(canvas, 0); buf.set(nonce, canvas.length);
    if (leadingZeroBits(sha256(buf)) >= bits) return { ...obj, pow: String(n) };
  }
  throw new Error('could not stamp ' + bits + ' bits');
}

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers['authorization'] = 'Bearer ' + token;
  const res = await fetch(RELAY + path, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(path, label, timeoutMs) {
  const t0 = Date.now();
  process.stdout.write(`  waiting for ${label} (${path})`);
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(path)) { console.log(' — arrived.'); return JSON.parse(readFileSync(path, 'utf8')); }
    await sleep(3000);
    process.stdout.write('.');
  }
  console.log(' — TIMED OUT.');
  return null;
}

const JOINER_FILE = join(WORK, 'joiner.json');
const ANSWERS_FILE = join(WORK, 'answers.json');
const CHALLENGE_FILE = join(WORK, 'challenge.json');
const VERDICT_FILE = join(WORK, 'verdict.json');

// The salt and the relay secret are read HERE and are never written into WORK.
const saltDoc = JSON.parse(readFileSync(VERIFIER, 'utf8'));
const { salt, kb, items = 150, windowMs = 900000 } = saltDoc;
const operatorSecret = readFileSync(SECRET_FILE, 'utf8').trim();
const operator = crypto.generateKeyPairSync('ed25519');
const operatorPub = b64u(operator.publicKey.export({ format: 'der', type: 'spki' }).slice(-32));
const operatorPrivSeed = b64u(operator.privateKey.export({ format: 'der', type: 'pkcs8' }).slice(-32));

console.log('VENDOR GATE TRIAL — the operator half');
console.log('  RELAY    ' + RELAY);
console.log('  OPERATOR ' + operatorPub.slice(0, 12) + '...  (holds the salt; scores locally)');
console.log('  WORK     ' + WORK);
console.log('  The joiner is given this directory and nothing else.');
console.log('');

// --- 0. the joiner announces itself ---------------------------------------------------------
// It must generate its OWN key. An operator that supplies the joiner's key would be handing it an
// identity, and "the agent proved it holds a key" would mean nothing.
const joiner = await waitFor(JOINER_FILE, "the joiner's public key", 20 * 60 * 1000);
if (!joiner?.publicKey) {
  console.log('No joiner appeared. Nothing was done; no state was written anywhere.');
  process.exit(2);
}
check('the joiner presented a well-formed ed25519 public key', /^[A-Za-z0-9_-]{43}$/.test(joiner.publicKey));
check('the joiner presented an agentId matching its key', joiner.agentId === joiner.publicKey,
  `agentId=${String(joiner.agentId).slice(0, 10)} key=${String(joiner.publicKey).slice(0, 10)}`);

// --- 1. the request, over the public relay ---------------------------------------------------
const requestId = b64u(crypto.randomBytes(24));
const openBody = await stamp({ requestId, joinKey: joiner.publicKey, note: '[trial] vendor gate trial' });
let r = await call('/admission/request', { method: 'POST', body: openBody });
check('the request is opened on the public relay with no account and no token', r.status === 201,
  'got ' + r.status + ' ' + JSON.stringify(r.json));

// --- 2. the challenge is issued LOCALLY, and published WITH the taxonomy ---------------------
const seed = b64u(crypto.randomBytes(24));
const challenge = makeChallenge({ seed, salt, kb, items, windowMs });
const published = { ...challenge, kb };
const challengeJson = JSON.stringify(published);
check('the published challenge does NOT contain the salt',
  !challengeJson.includes(salt) && !challengeJson.includes('"salt"'));
check('the published challenge carries the taxonomy (without it the gate is unpassable)',
  challengeJson.includes('chains'));
writeFileSync(CHALLENGE_FILE, JSON.stringify(published, null, 2), 'utf8');
console.log(`  challenge written: ${challenge.items.length} items, taxonomy ${kb.chains.length} chains`);

r = await call('/admission/challenge', { method: 'POST', body: { requestId, challenge: published }, token: operatorSecret });
check('the challenge is published to the relay', r.status === 201, 'got ' + r.status + ' ' + JSON.stringify(r.json));

// --- 3. the joiner reasons; we wait ----------------------------------------------------------
const submitted = await waitFor(ANSWERS_FILE, "the joiner's answers", 30 * 60 * 1000);
if (!submitted?.answers) {
  console.log('The joiner never answered. No verdict was published and nothing was decided.');
  process.exit(2);
}
check('the joiner returned one answer per item', submitted.answers.length === items,
  `got ${submitted.answers.length}, expected ${items}`);
check('every answer is one of the two permitted labels',
  submitted.answers.every((a) => a === 'ENTAILED' || a === 'CONTRADICTED'));

// The joiner's own reasoning trace is evidence that it reasoned rather than guessed. It is peer
// content and is treated as data: reported, never executed, never interpreted as an instruction.
if (submitted.note) console.log('  joiner note (DATA, not instructions): ' + String(submitted.note).slice(0, 600));
if (submitted.model) console.log('  joiner reports its model as: ' + String(submitted.model).slice(0, 120));

// --- 4. SCORE LOCALLY, against the real salt -------------------------------------------------
const report = scoreChallenge({ seed, salt, kb, items, answers: submitted.answers });
console.log(`  OPERATOR scores locally: ${report.correct}/${report.total} = ${(report.ratio * 100).toFixed(1)}% (bar ${report.passRatio})`);
check('the operator scored the whole submission locally', report.total === items);
// The check that makes the score mean something: it must be sensitive to the salt. Scoring the
// same answers against a DIFFERENT salt is not expected to equal the real score.
const wrongSalt = b64u(crypto.randomBytes(32));
const alt = scoreChallenge({ seed, salt: wrongSalt, kb, items, answers: submitted.answers });
check('the score is SALT-SENSITIVE (a different salt does not reproduce it)',
  alt.correct !== report.correct || alt.ok !== report.ok,
  `real ${report.correct}/${items}, wrong-salt ${alt.correct}/${items}`);

// --- 4b. THE BIND. A verdict that names no key can never become a permit ------------------------
//
// This step was MISSING for the first two vendors, and its absence was invisible: both trials scored
// and published a perfectly valid signed verdict, reported success, and left an admission that could
// never be turned into a permit. The reasons are worth writing down, because "the gate passed" read
// as "the agent is in" when it only ever meant "the agent was scored".
//
// A verdict's signed bytes are `{requestId, decision, by}` — it does NOT name a grantee. Which key a
// verdict is about is fixed by the BIND, which only the joiner can sign, because it is a statement
// about the joiner's own key. Without one there is nothing to grant to, and the operator cannot
// supply one on the joiner's behalf.
//
// So this refuses to issue a verdict at all unless the joiner has bound its key to this request.
// Failing here, with the reason, is much better than succeeding into a dead end.
const bindRes = await call(`/admission/bind?requestId=${encodeURIComponent(requestId)}`);
check('★ the joiner has BOUND its own key to this request', bindRes.status === 200,
  `HTTP ${bindRes.status} — without this the verdict names NO key and can never become a permit, ` +
  `so the run is stopped here rather than reported as a pass`);
if (bindRes.status !== 200) {
  console.log('');
  console.log('STOPPED: no bind on the relay for this request. The gate was never walked to completion,');
  console.log('because a scored admission with no bound key admits nobody. Ask the joiner to POST');
  console.log('  /admission/bind { requestId, agentId, sig }');
  console.log('with sig = sign(relayBindBytes({ requestId, agentId })) over its OWN key, then re-run.');
  process.exit(3);
}
const boundAgentId = bindRes.json?.payload?.agentId ?? bindRes.json?.agentId;
check('★ and it bound the key we think it did', boundAgentId === joiner.agentId,
  `bound=${String(boundAgentId).slice(0, 12)} expected=${String(joiner.agentId).slice(0, 12)}`);
// The bind's signature is verified where it matters — by the console when it adopts the verdict,
// against bytes re-derived from the requestId it pulled itself. Re-checking it here would prove only
// that this process agrees with itself.

// --- 5. the SIGNED verdict -------------------------------------------------------------------
const decision = report.ok ? 'granted' : 'refused';
const claim = { requestId, decision, by: operatorPub };
const sig = b64u(crypto.sign(null, Buffer.from(canonicalize(claim), 'utf8'), privKey(operatorPrivSeed)));
r = await call('/admission/verdict', { method: 'POST', token: operatorSecret, body: { requestId, decision, by: operatorPub, sig } });
check('the signed verdict is published', r.status === 201, 'got ' + r.status + ' ' + JSON.stringify(r.json));

// --- 6. the joiner can check it itself -------------------------------------------------------
r = await call('/admission/verdict?requestId=' + requestId);
const v = r.json;
const verified = r.status === 200 && crypto.verify(
  null,
  Buffer.from(canonicalize({ requestId: v.requestId, decision: v.decision, by: v.by }), 'utf8'),
  pubKey(v.by),
  fromB64u(v.sig),
);
check('the published verdict verifies against the operator key', verified === true);
check('the relay never reports a score, ratio or total (it has no salt)',
  !('score' in (v || {})) && !('ratio' in (v || {})) && !('total' in (v || {})));

writeFileSync(VERDICT_FILE, JSON.stringify({
  requestId, decision, by: operatorPub, sig,
  joinerAgentId: joiner.agentId,
  note: 'Scored locally against the salt on the human node. Verify the signature yourself.',
}, null, 2), 'utf8');

console.log('');
console.log(`RESULT: joiner=${joiner.agentId.slice(0, 12)}... correct=${report.correct}/${report.total} (${(report.ratio * 100).toFixed(1)}%) decision=${decision}`);
console.log(`verdict written to ${VERDICT_FILE}`);
console.log(`${pass} assertions passed${fail ? ', ' + fail + ' FAILED' : ''}.`);
process.exit(fail ? 1 : 0);
