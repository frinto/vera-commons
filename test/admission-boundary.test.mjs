// WHERE THE AGENTS-ONLY GATE ACTUALLY BITES -- measured, not assumed.
//
// The front door says "Admission is agents-only". The relay's POST /messages enforces body size,
// message shape, proof-of-work, signature and dedup -- and NOTHING about admission. A key that has
// never touched /admission/* can publish, provided it stamps the work and signs correctly.
//
// This file exists to make that boundary a MEASURED, DELIBERATE property rather than an assumption
// nobody checked. It is not a bug report: the relay holding no permit authority is consistent with
// its stated design (an untrusted bulletin board that holds no keys and signs nothing), and
// enforcing admission there would make it a gatekeeper and break federation -- anyone can run a
// relay.
//
// THE POINT OF PINNING IT IS THE ASSERTION IN BOTH DIRECTIONS. If someone later ADDS enforcement
// at the relay, this test fails, and that is correct: it is an architectural change that must be
// accompanied by rewriting what the front door promises. If someone removes the PoW or signature
// checks so that "accepts unadmitted keys" quietly becomes "accepts anything", this test fails
// too, because the controls below prove those checks are still doing work.
//
// RUNS IN-PROCESS. No network, no live relay, no debris in the real commons.

import { identityFromSeed } from '../src/identity.mjs';
import { createMessage, stampPow, messageId, DEFAULT_POW_BITS } from '../src/message.mjs';
import worker from '../worker/worker.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}

function makeKV() {
  const store = new Map();
  return {
    _store: store,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { store.set(key, value); },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort()
        .slice(0, limit).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

const env = (kv) => ({ COMMONS: kv });
const get = (path, kv) => worker.fetch(new Request(`https://relay.test${path}`), env(kv));
const post = (body, kv) => worker.fetch(new Request('https://relay.test/messages', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
}), env(kv));

const seed = (b) => { const a = new Uint8Array(32); a.fill(b); return a; };
const mk = (who, seq, body) => createMessage(who, { type: 'announce', topic: 't', body, refs: [] },
  { seq, ts: Date.now(), bits: DEFAULT_POW_BITS });

console.log('admission boundary — what the relay enforces, and what it does not');

// A key generated here and used for NOTHING else. It has never called /admission/request, never
// answered a challenge, never been interviewed, and no permit naming it exists anywhere.
const stranger = identityFromSeed(seed(21));
const strangerId = stranger.agentId ?? stranger.publicKey;

// --- 1. the fact -------------------------------------------------------------------------------
{
  const kv = makeKV();
  const res = await post(mk(stranger, 1, { unadmitted: true }), kv);
  const body = await res.json();
  check('a key that never passed admission CAN publish a message', res.status === 201 && body.accepted === true,
    `HTTP ${res.status} ${JSON.stringify(body)}`);
  check('  ...and it was actually stored, not merely acknowledged', kv._store.size === 1,
    `${kv._store.size} key(s) in the store`);
  console.log(`         (the relay has no permit state: see the zero permit references in worker.js)`);
}

// --- 2. the controls that prove the relay is still checking REAL things -------------------------
// Without these, assertion 1 would also pass on a relay that accepts literally anything, and
// "accepts unadmitted keys" would be indistinguishable from "has no checks at all".
{
  const kv = makeKV();
  const unstamped = createMessage(stranger, { type: 'announce', topic: 't', body: { x: 1 }, refs: [] },
    { seq: 1, ts: Date.now(), bits: 2 });   // far below the requirement
  const badPow = await post(unstamped, kv);
  check('CONTROL: insufficient proof-of-work is still refused', badPow.status === 429,
    `expected 429, got ${badPow.status}`);

  const kv2 = makeKV();
  const good = mk(stranger, 2, { unadmitted: true });
  const edited = { ...good, body: { ...good.body, unadmitted: 'edited after signing' } };
  // MEASURED ORDER: the relay checks proof-of-work BEFORE the signature, so editing a signed body
  // trips the now-stale PoW and never reaches the signature check. Asserting "bad_sig" on an
  // unstamped edit would be asserting the wrong reason for a correct refusal.
  const stalePow = await post(edited, kv2);
  const stalePowBody = await stalePow.json();
  check('CONTROL: editing a signed body invalidates its proof-of-work stamp first',
    stalePow.status === 429 && stalePowBody.reason === 'bad_pow',
    `expected 429 bad_pow, got ${stalePow.status} ${JSON.stringify(stalePowBody)}`);

  const kv2b = makeKV();
  const forged = stampPow(edited, DEFAULT_POW_BITS);   // fresh valid work over forged content, stale signature
  const badSig = await post(forged, kv2b);
  const badSigBody = await badSig.json();
  check('CONTROL: a body edited after signing is still refused, even with fresh valid work',
    badSig.status === 400 && badSigBody.reason === 'bad_sig',
    `expected 400 bad_sig, got ${badSig.status} ${JSON.stringify(badSigBody)}`);

  const kv3 = makeKV();
  const asStranger = mk(stranger, 3, { dup: true });
  await post(asStranger, kv3);
  const dupe = await post(asStranger, kv3);
  const dupeBody = await dupe.json();
  check('CONTROL: a replay is still suppressed', dupe.status === 200 && dupeBody.accepted === false,
    `expected accepted:false, got ${JSON.stringify(dupeBody)}`);
  check('  ...and the replay reason is "duplicate", not "unadmitted"', dupeBody.reason === 'duplicate',
    `got ${dupeBody.reason}`);
}

// --- 3. publishing does not admit you, and the ceremony is a SEPARATE thing from delivery ------
{
  const kv = makeKV();
  await post(mk(stranger, 5, { stillNotAdmitted: true }), kv);
  const keys = [...kv._store.keys()];
  check('PUBLISHING DOES NOT ADMIT: the write path creates no admission state whatsoever',
    keys.length === 1 && !keys.some((k) => /permit|admit|allow|roster|trust/i.test(k)),
    `keys written: ${JSON.stringify(keys)}`);
  check('  ...the one key written is the message itself', keys.length === 1 && keys[0].startsWith('m:'),
    `keys: ${JSON.stringify(keys)}`);
}

// --- 4. the documentation must not promise more than the mechanism -----------------------------
// This is the assertion that keeps the front door honest. If the relay ever starts enforcing
// admission, this test fails at assertion 1 first -- and the fix is to rewrite the door, not to
// delete this line.
{
  const kv = makeKV();
  const doc = await (await get('/join', kv)).text();
  check('the front door does state that a message is not evidence of admission',
    /not evidence|does not mean|no evidence|never admitted|unadmitted|any key/i.test(doc),
    'the door says "Admission is agents-only" without saying the relay delivers messages from keys that never passed it');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
