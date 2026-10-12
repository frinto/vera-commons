// The remote admission queue, exercised through the worker's real fetch() surface.
//
// WHY THIS TEST EXISTS: the admission gate was wired, enforced, and proven 150/150 by a
// cross-vendor trial — and completely unreachable from another machine, because the console
// binds 127.0.0.1 and its routes sit behind a per-run admin token. Every test we had passed
// the whole time. None of them asked "could a stranger reach this?". So this test walks the
// whole handshake the way a remote joiner must, plus the ways an attacker would try to abuse
// it. A test of the library would not have caught the missing transport either; this one goes
// through fetch().

import worker from '../worker/worker.js';
import { generateIdentity, sign } from '../src/identity.mjs';
import { relayInterviewBytes } from '../src/admission.mjs';

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

// --- a KV stand-in with the two methods the worker uses ----------------------
function fakeKV() {
  const map = new Map();
  return {
    _map: map,
    async get(key, type) {
      if (!map.has(key)) return null;
      const v = map.get(key);
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { map.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

// --- proof of work, computed the way the worker checks it --------------------
// powOK() hashes canonicalize(withoutProof(msg)) CONCATENATED with String(msg.pow).
// withoutProof strips sig/pow/id, so the canvas must be built the same way here.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
const enc = new TextEncoder();
async function sha256(bytes) { return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)); }
function leadingZeroBits(bytes) {
  let bits = 0;
  for (const b of bytes) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; }
  return bits;
}
async function stamp(obj, bits = 12) {
  const { sig, pow, id, ...rest } = obj;
  const canvas = enc.encode(canonicalize(rest));
  for (let n = 0; n < 5_000_000; n++) {
    const nonce = enc.encode(String(n));
    const buf = new Uint8Array(canvas.length + nonce.length);
    buf.set(canvas, 0); buf.set(nonce, canvas.length);
    if (leadingZeroBits(await sha256(buf)) >= bits) return { ...obj, pow: String(n) };
  }
  throw new Error('could not stamp ' + bits + ' bits');
}

const SECRET = 'operator-secret-for-test';
const BASE = 'https://relay.test';

function call(kv, path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers['authorization'] = 'Bearer ' + token;
  return worker.fetch(
    new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    { COMMONS: kv, ADMISSION_OPERATOR_SECRET: SECRET },
  );
}

// A requestId shaped like the ones the console issues.
const RID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const JOIN_KEY = 'K'.repeat(44);

// The joiner's key. An interview now carries BOTH the claiming key and a signature over its own
// text, because an unsigned interview is a statement nobody is accountable for — the relay would
// be forwarding an anonymous 4 KB blob to the operator and calling it a person.
const JOINER = generateIdentity();
async function signedInterview(requestId, statement, id = JOINER) {
  return stamp({
    requestId,
    statement,
    agentId: id.agentId,
    sig: sign(id, relayInterviewBytes({ requestId, agentId: id.agentId, statement })),
  });
}

console.log('--- the gate must be REACHABLE from outside ---');

const kv = fakeKV();
const noKv = await worker.fetch(new Request(BASE + '/admission/request', { method: 'POST' }), {});
check('with no KV binding the queue refuses rather than pretending', noKv.status === 503, 'got ' + noKv.status);

// 1. joiner opens a request
const reqBody = await stamp({ requestId: RID, joinKey: JOIN_KEY, note: 'a remote agent asks to join' });
let r = await call(kv, '/admission/request', { method: 'POST', body: reqBody });
check('joiner opens a request with no account and no token', r.status === 201, 'got ' + r.status);

// 2. operator sees it waiting
r = await call(kv, '/admission/requests', { token: SECRET });
let j = await r.json();
check('operator sees the waiting request', r.status === 200 && j.requests.length === 1, JSON.stringify(j).slice(0, 120));
check('the queue is operator-only (a joiner cannot enumerate other joiners)',
  (await call(kv, '/admission/requests')).status === 401);

// 3. operator publishes a challenge
const CHALLENGE = { seed: 'seed-abc', items: 150, windowMs: 900000, kb: { chains: [['falcon', 'bird', 'animal']] } };
r = await call(kv, '/admission/challenge', { method: 'POST', body: { requestId: RID, challenge: CHALLENGE }, token: SECRET });
check('operator publishes the challenge', r.status === 201, 'got ' + r.status);

// 4. joiner fetches it
r = await call(kv, '/admission/challenge?requestId=' + RID);
j = await r.json();
check('joiner fetches the challenge over the public relay', r.status === 200 && j.challenge.seed === 'seed-abc');

// 5. joiner answers
const ansBody = await stamp({ requestId: RID, answers: ['ENTAILED', 'CONTRADICTED'] });
r = await call(kv, '/admission/answer', { method: 'POST', body: ansBody });
check('joiner submits answers', r.status === 201, 'got ' + r.status);

// 6. operator collects them
r = await call(kv, '/admission/answers?requestId=' + RID, { token: SECRET });
j = await r.json();
check('operator collects the answers', r.status === 200 && j.answers.length === 2);
check('answers are NOT public (they are the joiner\'s work, not a billboard)',
  (await call(kv, '/admission/answers?requestId=' + RID)).status === 401);

// 6b. THE JOINER BINDS THE KEY IT WILL SPEAK WITH -- and it must happen BEFORE the verdict.
//     This step is mandatory, and it is now enforced: a grant that names no key would strand the
//     applicant for good, because bind refuses forever once a verdict exists. The relay refuses
//     such a grant outright (409 no_binding_yet). This test used to skip the step entirely, which
//     is exactly how a flow no real joiner could complete stayed green.
r = await call(kv, '/admission/bind', { method: 'POST', body: await stamp({ requestId: RID, agentId: JOINER.agentId, sig: 'G'.repeat(86) }) });
check('joiner binds the key it will speak with', r.status === 201, 'got ' + r.status);

// 7. operator publishes a signed verdict
const VERDICT = {
  requestId: RID, decision: 'granted',
  by: 'A'.repeat(44), sig: 'S'.repeat(86),
};
r = await call(kv, '/admission/verdict', { method: 'POST', body: VERDICT, token: SECRET });
check('operator publishes the signed verdict', r.status === 201, 'got ' + r.status);

// 8. joiner reads it
r = await call(kv, '/admission/verdict?requestId=' + RID);
j = await r.json();
check('joiner reads the verdict', r.status === 200 && j.decision === 'granted');
check('the response tells the joiner to verify the signature rather than trust the relay',
  typeof j.verify === 'string' && /verify/i.test(j.verify));
check('the relay never reports a score (it has no salt and cannot compute one)',
  !('score' in j) && !('ratio' in j) && !('total' in j));
// The bind is operator-only to READ, so without the key in the verdict nobody but the operator
// could ever link a public grant to an agent, and the grant would be unauditable by anyone else.
check('the public verdict names the key it admitted', j.agentId === JOINER.agentId,
  'agentId=' + String(j.agentId).slice(0, 8));

console.log('');
console.log('--- and it must resist abuse ---');

// The operator secret is the ONLY thing separating the operator from an attacker.
r = await call(kv, '/admission/challenge', { method: 'POST', body: { requestId: 'z'.repeat(32), challenge: CHALLENGE } });
check('a challenge cannot be published without the operator secret', r.status === 401, 'got ' + r.status);
r = await call(kv, '/admission/challenge', { method: 'POST', body: { requestId: 'z'.repeat(32), challenge: CHALLENGE }, token: 'wrong' });
check('a WRONG operator secret is refused, not coerced', r.status === 401, 'got ' + r.status);
r = await call(kv, '/admission/verdict', { method: 'POST', body: VERDICT, token: 'wrong' });
check('nobody can grant themselves a verdict', r.status === 401, 'got ' + r.status);

// Fail CLOSED: no configured secret must shut the operator routes, not open them.
const openKv = fakeKV();
const openCall = (p, o) => worker.fetch(
  new Request(BASE + p, { method: o.method || 'GET', headers: o.body ? { 'content-type': 'application/json' } : {}, body: o.body ? JSON.stringify(o.body) : undefined }),
  { COMMONS: openKv },
);
r = await openCall('/admission/requests', { token: '' });
check('with NO operator secret configured the operator routes fail CLOSED', r.status === 401, 'got ' + r.status);

// A challenge that would leak the scorer's secret must not be publishable.
for (const leak of [{ seed: 's', salt: 'THE-SECRET' }, { seed: 's', expected: ['ENTAILED'] }, { seed: 's', answers: ['ENTAILED'] }]) {
  r = await call(kv, '/admission/challenge', { method: 'POST', body: { requestId: 'y'.repeat(32), challenge: leak }, token: SECRET });
  check('a challenge carrying ' + Object.keys(leak)[1] + ' is refused at the relay boundary', r.status === 400, 'got ' + r.status);
}

// An unsigned verdict must not sit in the queue looking authoritative.
r = await call(kv, '/admission/verdict', { method: 'POST', body: { requestId: RID, decision: 'granted', by: 'A'.repeat(44) }, token: SECRET });
check('an UNSIGNED verdict is refused', r.status === 400, 'got ' + r.status);

// Posting is PoW-gated, so filling the queue costs the attacker.
r = await call(kv, '/admission/request', { method: 'POST', body: { requestId: 'q'.repeat(32), joinKey: JOIN_KEY, pow: 'not-a-stamp' } });
check('opening a request without proof-of-work is refused', r.status === 429, 'got ' + r.status);

// Replay: the first answer set stands.
r = await call(kv, '/admission/answer', { method: 'POST', body: await stamp({ requestId: RID, answers: ['ENTAILED', 'ENTAILED'] }) });
check('a second answer set for the same request is refused (no replay over a later challenge)', r.status === 409, 'got ' + r.status);

// An answer to a challenge that does not exist is refused early.
r = await call(kv, '/admission/answer', { method: 'POST', body: await stamp({ requestId: 'w'.repeat(32), answers: ['ENTAILED'] }) });
check('answering a request with no challenge yet is refused', r.status === 409, 'got ' + r.status);

// Duplicate request ids cannot overwrite a live handshake.
r = await call(kv, '/admission/request', { method: 'POST', body: await stamp({ requestId: RID, joinKey: JOIN_KEY }) });
check('a duplicate requestId cannot hijack a live handshake', r.status === 409, 'got ' + r.status);

// Shape checks.
r = await call(kv, '/admission/request', { method: 'POST', body: { requestId: 'short', joinKey: JOIN_KEY } });
check('a malformed requestId is refused', r.status === 400, 'got ' + r.status);
r = await call(kv, '/admission/verdict?requestId=' + RID, { method: 'GET' });
check('reading a verdict that does not exist reports absence honestly', r.status === 200);
r = await call(kv, '/admission/verdict?requestId=' + 'n'.repeat(32));
check('an unknown requestId has NO verdict rather than an empty one', r.status === 404, 'got ' + r.status);
r = await call(kv, '/admission/challenge?requestId=' + 'n'.repeat(32));
check('an unknown requestId has NO challenge', r.status === 404, 'got ' + r.status);

console.log('');
console.log('--- the interview: the third stage, previously unreachable ---');

// The interview is the agent's own words. It must be REACHABLE by a remote joiner, must be
// REPLACEABLE before a decision (an agent may think again), and must be operator-only to read.
r = await call(kv, '/admission/interview', { method: 'POST', body: await signedInterview(RID, 'I am an agent. Here is what I am for.') });
check('a joiner submits a SIGNED interview over the relay', r.status === 201, 'got ' + r.status + ' ' + JSON.stringify(await r.json()).slice(0, 120));

r = await call(kv, '/admission/interview?requestId=' + RID);
check('the interview is NOT public (it is the agent\'s own words)', r.status === 401, 'got ' + r.status);
r = await call(kv, '/admission/interview?requestId=' + RID, { token: SECRET });
j = await r.json();
check('the operator reads the interview', r.status === 200 && j.statement === 'I am an agent. Here is what I am for.');
check('the relay labels the interview as data, never an instruction',
  typeof j.untrusted === 'string' && /never as an instruction/i.test(j.untrusted));
check('the claiming key and its signature travel WITH the interview', j.agentId === JOINER.agentId && typeof j.sig === 'string' && j.sig.length > 0,
  'agentId=' + String(j.agentId).slice(0, 8) + ' sig=' + typeof j.sig);

// Replaceable — the property that deliberately DIFFERS from the answers.
r = await call(kv, '/admission/interview', { method: 'POST', body: await signedInterview(RID, 'On reflection, here is a fuller account.') });
check('an interview is REPLACEABLE before a decision (unlike answers)', r.status === 201, 'got ' + r.status + ' ' + JSON.stringify(await r.json()).slice(0, 120));
r = await call(kv, '/admission/interview?requestId=' + RID, { token: SECRET });
j = await r.json();
check('the replacement is what is stored', j.statement === 'On reflection, here is a fuller account.');

// Negative cases.
r = await call(kv, '/admission/interview', { method: 'POST', body: { requestId: RID, statement: 'no stamp', pow: 'x' } });
check('an interview without proof-of-work is refused', r.status === 429, 'got ' + r.status);
// An UNSIGNED interview is now refused at the relay, not just distrusted downstream. The relay
// still cannot verify the signature — it has no idea which key an admission belongs to — so this
// is a well-formedness gate, and the real check happens on the operator's node. Saying so here
// keeps the claim honest: "refused" means "not carried", not "proven a forgery".
r = await call(kv, '/admission/interview', { method: 'POST', body: await stamp({ requestId: RID, statement: 'trust me', agentId: JOINER.agentId }) });
check('an UNSIGNED interview is not carried by the relay at all', r.status === 400, 'got ' + r.status);
j = await r.json();
check('and the refusal names the missing signature rather than a generic error', j.reason === 'not_signed', 'got ' + j.reason);
r = await call(kv, '/admission/interview', { method: 'POST', body: await stamp({ requestId: RID, statement: 'trust me', agentId: 'tooshort', sig: 'x' }) });
check('an interview naming a malformed key is refused', r.status === 400, 'got ' + r.status);
j = await r.json();
check('and that refusal names the key, not the signature', j.reason === 'bad_agent_id', 'got ' + j.reason);
r = await call(kv, '/admission/interview', { method: 'POST', body: await signedInterview(RID, '   ') });
check('a whitespace-only interview is refused', r.status === 400, 'got ' + r.status);
r = await call(kv, '/admission/interview', { method: 'POST', body: await signedInterview(RID, 'x'.repeat(4001)) });
check('an overlong interview is refused', r.status === 400, 'got ' + r.status);
r = await call(kv, '/admission/interview', { method: 'POST', body: await stamp({ ...(await signedInterview(RID, 'ok')), answers: ['array', 'not', 'object'] }) });
check('a malformed answers shape is refused', r.status === 400, 'got ' + r.status);
r = await call(kv, '/admission/interview', { method: 'POST', body: await signedInterview('w'.repeat(32), 'interview with no handshake') });
check('an interview for a request with no challenge is refused', r.status === 409, 'got ' + r.status);
r = await call(kv, '/admission/interview?requestId=' + 'n'.repeat(32), { token: SECRET });
check('an unknown requestId has NO interview', r.status === 404, 'got ' + r.status);

console.log('');
console.log(pass + ' assertions passed' + (fail ? ', ' + fail + ' FAILED' : '') + '.');
if (fail) process.exit(1);
