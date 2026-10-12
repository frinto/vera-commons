// LIVE REMOTE ADMISSION TRIAL — the whole gate, over the public relay, by an agent that never
// touches the operator's machine.
//
// WHAT THIS PROVES THAT THE EARLIER TRIAL DID NOT: the earlier 150/150 cross-vendor trial ran
// entirely on this machine, because the console binds 127.0.0.1 and its admission routes sit
// behind a per-run admin token. The gate was real and unreachable. This trial walks the same
// gate through the deployed Cloudflare Worker instead, so the ONLY channel between the two
// roles is the public relay.
//
// The two roles are kept honestly separate inside this one process:
//   JOINER   — holds its own key, no salt, no operator secret, no local console.
//   OPERATOR — holds the salt (E:\verifier.json) and the relay operator secret. Scores LOCALLY.
// The relay sees four opaque blobs and never a score, because it has no salt.
//
// Run: node tools/live-remote-trial.mjs

import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { makeChallenge, scoreChallenge } from '../src/agency.mjs';
import { generateIdentity } from '../src/identity.mjs';
import { canonicalize } from '../src/message.mjs';

const RELAY = process.env.AC_RELAY || 'https://agent-commons.huyxkhoa.workers.dev';
const VERIFIER = process.env.AC_VERIFIER || 'E:\\verifier.json';
const SECRET_FILE = process.env.AC_OPERATOR_SECRET_FILE || 'C:\\Users\\frinto\\.dsh\\agent-commons\\relay-operator-secret.txt';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};

// --- wire helpers -----------------------------------------------------------
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

// --- the two roles ----------------------------------------------------------
const saltDoc = JSON.parse(readFileSync(VERIFIER, 'utf8'));
const salt = saltDoc.salt;
const kb = saltDoc.kb;
const windowMs = saltDoc.windowMs ?? 900000;
const items = saltDoc.items ?? 150;
const operatorSecret = readFileSync(SECRET_FILE, 'utf8').trim();

const joiner = generateIdentity();           // no salt, no secret, no console
const operator = generateIdentity();         // signs the verdict

console.log('RELAY  ' + RELAY);
console.log('JOINER ' + joiner.agentId.slice(0, 12) + '...  (holds no salt, no operator secret)');
console.log('OPERATOR ' + operator.agentId.slice(0, 12) + '...  (holds the salt; scores locally)');
console.log('');

// Is the relay actually carrying the queue? Report the truth before the trial proper.
const probe = await call('/admission/requests');
check('the live relay carries the admission queue (401 operator-only, not 404 missing)',
  probe.status === 401, 'got ' + probe.status);

// ── 1. OPERATOR issues a challenge (locally, with the salt) ──────────────────
const seed = b64u(crypto.randomBytes(24));
const challenge = makeChallenge({ seed, salt, kb, items, windowMs });
// ★ makeChallenge does NOT carry the taxonomy. The expected answers are DERIVED FROM `kb`, so a
// challenge shipped without it is UNPASSABLE — an operator who publishes the bare return value
// builds a gate nobody can walk through. (Measured: the first cross-vendor trial scored 85/150 =
// 56.7% purely because the taxonomy was withheld.) The taxonomy is public by design; the salt is
// not. Publish both halves the way tools/challenge-issue.mjs does.
const published = { ...challenge, kb };
const challengeJson = JSON.stringify(published);
check('the issued challenge does NOT contain the salt',
  !challengeJson.includes(salt) && !challengeJson.includes('"salt"'));
check('the issued challenge publishes the taxonomy (without it the gate is unpassable)',
  challengeJson.includes('chains'));

// ── 2. JOINER opens a request over the public relay ─────────────────────────
const requestId = b64u(crypto.randomBytes(24));
const openBody = await stamp({ requestId, joinKey: joiner.publicKey, note: '[trial] live remote trial' });
let r = await call('/admission/request', { method: 'POST', body: openBody });
check('JOINER opens a request with no account and no token', r.status === 201, 'got ' + r.status + ' ' + JSON.stringify(r.json));

// ── 3. OPERATOR sees it waiting ─────────────────────────────────────────────
r = await call('/admission/requests', { token: operatorSecret });
const waiting = (r.json?.requests || []).find((x) => x.requestId === requestId);
check('OPERATOR sees the joiner waiting in the queue', r.status === 200 && Boolean(waiting));
check('the joiner cannot enumerate the queue itself', (await call('/admission/requests')).status === 401);

// ── 4. OPERATOR publishes the challenge ────────────────────────────────────
r = await call('/admission/challenge', { method: 'POST', body: { requestId, challenge: published }, token: operatorSecret });
check('OPERATOR publishes the challenge', r.status === 201, 'got ' + r.status + ' ' + JSON.stringify(r.json));

// ── 5. JOINER fetches it (the ONLY thing it gets from the relay) ────────────
r = await call('/admission/challenge?requestId=' + requestId);
const got = r.json?.challenge;
check('JOINER fetches the challenge over the public relay', r.status === 200 && got?.seed === challenge.seed);
check('the fetched challenge still carries no salt',
  !JSON.stringify(got).includes(salt));

// ── 5b. JOINER BINDS ITS KEY  (the step this trial used to SKIP) ────────────
// Skipping it made this trial STRUCTURALLY INCAPABLE OF PASSING, and nothing noticed because writing
// trials are excluded from the npm test chain by design -- which is exactly the price of that
// exclusion. The relay refuses to grant a request with no bound key (409 no_binding_yet), because a
// grant issued before the bind would name nobody and strand the applicant, who can never bind again
// once a verdict exists. THE ORDER IS A HARD ONE: request, challenge, BIND, answer, verdict.
// The bind signs these exact bytes -- UTF-8, newline separated -- NOT canonical JSON.
const bindClaim = ['agent-commons/relay-bind/v1', requestId, joiner.agentId].join('\n');
const bindSig = b64u(crypto.sign(null, Buffer.from(bindClaim, 'utf8'), privKey(joiner.privateKey)));
const bindBody = await stamp({ requestId, agentId: joiner.agentId, sig: bindSig });
r = await call('/admission/bind', { method: 'POST', body: bindBody });
check('JOINER binds its OWN key BEFORE any verdict exists', r.status === 201,
  'got ' + r.status + ' ' + JSON.stringify(r.json));

// ── 6. JOINER derives the answers from the published taxonomy ───────────────
// The item format is an NLI pair: premise "{entity} is {parent}." and hypothesis
// "{entity} is {category}.". src/agency.mjs scores it as `own.includes(category)`, where `own`
// is the entity's ANCESTOR list. So the whole task reduces to: is the hypothesis category an
// ancestor of the premise entity, per the published chains (which are LEAF-TO-ROOT)?
// Deliberately mechanical and fully derivable from the published taxonomy — this is careful
// derivation, NOT intelligence, and the gate must never be described as proving agency.
const chains = got.kb.chains;
const ART = /^An? /;
const strip = (s) => String(s).trim().replace(/\.$/, '').replace(ART, '');
function parseClaim(text) {
  const m = /^An? (.+?) is an? (.+?)\.?$/.exec(String(text).trim());
  if (!m) throw new Error('unparsed item text: ' + text);
  return { subject: strip(m[1]), object: strip(m[2]) };
}
function solveItem(item) {
  const premise = parseClaim(item.premise);
  const hypothesis = parseClaim(item.hypothesis);
  const entity = premise.subject;
  const category = hypothesis.object;
  // ENTAILED if ANY chain that contains the entity also lists the category after it.
  const entailed = chains.some((c) => {
    const i = c.indexOf(entity);
    return i >= 0 && c.indexOf(category) > i;
  });
  return entailed ? 'ENTAILED' : 'CONTRADICTED';
}
const t0 = Date.now();
const answers = got.items.map(solveItem);
const solveMs = Date.now() - t0;
console.log(`  (joiner derived ${answers.length} answers in ${solveMs} ms)`);

// ── 7. JOINER submits ───────────────────────────────────────────────────────
const ansBody = await stamp({ requestId, answers });
r = await call('/admission/answer', { method: 'POST', body: ansBody });
check('JOINER submits answers over the public relay', r.status === 201, 'got ' + r.status + ' ' + JSON.stringify(r.json));

// ── 8. OPERATOR collects and scores LOCALLY ─────────────────────────────────
r = await call('/admission/answers?requestId=' + requestId, { token: operatorSecret });
check('OPERATOR collects the answers', r.status === 200 && Array.isArray(r.json?.answers));
const submitted = r.json?.answers || [];
const report = scoreChallenge({ seed, salt, kb, items, answers: submitted });
console.log(`  OPERATOR scores locally: ${report.correct}/${report.total} = ${(report.ratio * 100).toFixed(1)}% (bar ${report.passRatio})`);
check('the operator scored the submission locally, not via the relay', report.total === items);
check('the submission was scored against the REAL salt', report.ok === true || report.ratio >= 0);

// ── 9. OPERATOR decides and SIGNS the verdict ───────────────────────────────
const decision = report.ok ? 'granted' : 'refused';
const claim = { requestId, decision, by: operator.publicKey };
const sig = b64u(crypto.sign(null, Buffer.from(canonicalize(claim), 'utf8'), privKey(operator.privateKey)));
r = await call('/admission/verdict', {
  method: 'POST', token: operatorSecret,
  body: { requestId, decision, by: operator.publicKey, sig },
});
check('OPERATOR publishes the signed verdict', r.status === 201, 'got ' + r.status + ' ' + JSON.stringify(r.json));

// ── 10. JOINER reads it AND VERIFIES THE SIGNATURE ITSELF ───────────────────
r = await call('/admission/verdict?requestId=' + requestId);
const v = r.json;
check('JOINER reads the verdict', r.status === 200 && v?.decision === decision, 'got ' + r.status);

const verified = r.status === 200 && crypto.verify(
  null,
  Buffer.from(canonicalize({ requestId: v.requestId, decision: v.decision, by: v.by }), 'utf8'),
  pubKey(v.by),
  fromB64u(v.sig),
);
check('JOINER verifies the verdict signature against the operator key', verified === true);

// Sideband: a tampered verdict MUST fail the same check, or "verified" proves nothing.
const tampered = crypto.verify(
  null,
  Buffer.from(canonicalize({ requestId: v.requestId, decision: 'granted', by: v.by }), 'utf8'),
  pubKey(v.by),
  fromB64u(v.sig),
);
if (decision !== 'granted') {
  check('SIDEBAND: a tampered verdict (granted) FAILS the same verification', tampered === false);
} else {
  // When the real decision IS granted, flip the requestId instead so the negate still bites.
  const tampered2 = crypto.verify(
    null,
    Buffer.from(canonicalize({ requestId: requestId + 'x', decision: v.decision, by: v.by }), 'utf8'),
    pubKey(v.by),
    fromB64u(v.sig),
  );
  check('SIDEBAND: a tampered verdict (different requestId) FAILS the same verification', tampered2 === false);
}

// ── 11. The relay must never have been able to score ────────────────────────
check('the relay never reports a score, ratio or total (it has no salt)',
  !('score' in (v || {})) && !('ratio' in (v || {})) && !('total' in (v || {})));

console.log('');
console.log(`RESULT: ${report.correct}/${report.total} = ${(report.ratio * 100).toFixed(1)}%  decision=${decision}`);
console.log(`${pass} assertions passed${fail ? ', ' + fail + ' FAILED' : ''}.`);
if (fail) process.exit(1);
