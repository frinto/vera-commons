// Agent Commons — Cloudflare Worker tests, run locally with a mock KV binding.
//
// Why this file matters: worker/worker.js RE-IMPLEMENTS canonicalization, the
// message id and the proof-of-work check, because a Worker cannot import the
// Node modules (no node:crypto, no Buffer). Duplicated logic is exactly the code
// that silently rots, so it gets its own tests against the same vectors.
//
// Node can import the Worker directly: it is a plain ES module, and Node 24
// provides global crypto.subtle, atob, Request and Response.
//
// Run: node test/worker.test.mjs

import assert from 'node:assert/strict';
import worker from '../worker/worker.js';
import { identityFromSeed } from '../src/identity.mjs';
import { createMessage, stampPow, messageId, DEFAULT_POW_BITS } from '../src/message.mjs';

let n = 0;
const pass = (s) => { n++; console.log(`PASS ${s}`); };

// --- a KV stub that behaves like the real binding ---------------------------
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
const alice = identityFromSeed(seed(7));
const mallory = identityFromSeed(seed(8));
const mk = (who, seq, body) => createMessage(who, { type: 'announce', topic: 't', body, refs: [] },
  { seq, ts: Date.now(), bits: DEFAULT_POW_BITS });

// --- does this runtime actually expose Ed25519? -----------------------------
let ed25519 = false;
try {
  const k = await crypto.subtle.importKey('raw', new Uint8Array(32), { name: 'Ed25519' }, false, ['verify']);
  ed25519 = !!k;
} catch { ed25519 = false; }
console.log(`NOTE: runtime Ed25519 in WebCrypto = ${ed25519}`);

// --- identity of the Worker's canonicalization ------------------------------
{
  // The Worker's messageId must agree with the Node implementation byte for byte,
  // or the two halves of the system would address the same message differently.
  const kv = makeKV();
  const m = mk(alice, 1, { agree: true });
  const res = await post(m, kv);
  const body = await res.json();
  assert.equal(res.status, 201, `expected 201, got ${res.status} ${JSON.stringify(body)}`);
  assert.equal(body.accepted, true);
  assert.equal(body.id, messageId(m), 'worker and node must compute the SAME message id');
  pass('worker message id matches the node implementation exactly');
}

// --- routes ------------------------------------------------------------------
{
  const kv = makeKV();
  const h = await (await get('/health', kv)).json();
  assert.equal(h.ok, true);
  assert.equal(h.storage, 'kv');
  pass('GET /health reports ok with storage bound');

  const solo = await worker.fetch(new Request('https://relay.test/health'), {});
  const soloBody = await solo.json();
  assert.equal(soloBody.storage, 'none');
  pass('GET /health degrades honestly when no KV is bound');

  const missing = await get('/nope', kv);
  assert.equal(missing.status, 404);
  pass('an unknown route returns 404');
}

// --- admission control at the edge -------------------------------------------
{
  const kv = makeKV();

  const bad = await post('{not json', kv);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).reason, 'bad_json');
  pass('malformed JSON is refused with bad_json');

  const oversize = await post(JSON.stringify({ ...mk(alice, 1, {}), body: { b: 'A'.repeat(200000) } }), kv);
  assert.equal(oversize.status, 413);
  pass('an oversized request is refused before it costs a write');

  const shape = await post({ v: 2, from: 'x'.repeat(44), seq: 1, ts: Date.now(), type: 'announce', pow: '0', sig: '0'.repeat(64) }, kv);
  assert.equal(shape.status, 400);
  assert.equal((await shape.json()).reason, 'bad_version');
  pass('a wrong protocol version is refused with bad_version');

  const noPow = JSON.parse(JSON.stringify(mk(alice, 1, { x: 1 })));
  noPow.pow = 'deadbeef';
  const powRes = await post(noPow, kv);
  assert.equal(powRes.status, 429, `expected 429 for bad proof-of-work, got ${powRes.status}`);
  assert.equal((await powRes.json()).reason, 'bad_pow');
  pass('missing proof-of-work is refused with 429, the anti-flood gate');
  assert.equal(kv._store.size, 0, 'nothing may be written when proof-of-work fails');
  pass('a rejected message writes nothing to storage');
}

// --- tampering ----------------------------------------------------------------
{
  const kv = makeKV();
  const m = mk(alice, 1, { v: 'original' });

  const naive = JSON.parse(JSON.stringify(m));
  naive.body.v = 'tampered';
  const r1 = await post(naive, kv);
  assert.equal(r1.status, 429, 'a naive tamper breaks its own proof-of-work');
  pass('a naive tamper is caught by proof-of-work at the edge');

  const restamped = stampPow(JSON.parse(JSON.stringify(naive)), DEFAULT_POW_BITS);
  const r2 = await post(restamped, kv);
  if (ed25519) {
    assert.equal(r2.status, 400, `expected 400 for a forged signature, got ${r2.status}`);
    assert.equal((await r2.json()).reason, 'bad_sig');
    pass('a re-stamped forgery is caught by the signature at the edge');
  } else {
    const body = await r2.json();
    const header = r2.headers.get('x-ac-sig-verified');
    assert.equal(header, 'unknown', 'without Ed25519 the worker must admit it did not verify');
    console.log(`SKIP forged-signature rejection: runtime lacks Ed25519 (${JSON.stringify(body)})`);
  }
}

// --- happy path, dedup, and read-back ----------------------------------------
{
  const kv = makeKV();
  const m = mk(alice, 1, { hello: 'commons' });

  const first = await post(m, kv);
  assert.equal(first.status, 201);
  assert.equal((await first.json()).accepted, true);
  pass('a valid message is accepted with 201');

  const replay = await post(m, kv);
  assert.equal(replay.status, 200, 'a duplicate is not an error');
  const replayBody = await replay.json();
  assert.equal(replayBody.accepted, false);
  assert.equal(replayBody.reason, 'duplicate');
  pass('replaying the same message is idempotent, not a second write');

  const second = mk(alice, 2, { hello: 'again' });
  await post(second, kv);
  const other = mk(mallory, 1, { hello: 'from mallory' });
  await post(other, kv);

  const listed = await (await get('/messages', kv)).json();
  assert.equal(listed.ok, true);
  assert.equal(listed.messages.length, 3, `expected 3 messages, got ${listed.messages.length}`);
  pass('GET /messages returns everything that was accepted');

  const ids = listed.messages.map((x) => messageId(x));
  assert.equal(new Set(ids).size, 3, 'every stored message must be distinct');
  pass('the stored set contains no duplicates');

  const sinceRes = await (await get(`/messages?since=${messageId(m)}`, kv)).json();
  assert.equal(sinceRes.messages.length, 2, `expected 2 after the cursor, got ${sinceRes.messages.length}`);
  pass('GET /messages?since= resumes after the given message');
}

console.log(`\n${n} assertions passed.`);
