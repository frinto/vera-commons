// Agent Commons — store tests (negative cases are the point).
//
// A tamper-evident log is only worth having if it FAILS when it should.
// Every property below is asserted by breaking it first.
//
// Run: node test/store.test.mjs

import { join } from 'node:path';
import { mkdirSync, appendFileSync, statSync } from 'node:fs';
import assert from 'node:assert/strict';

import { AppendOnlyStore } from '../src/store.mjs';
import { identityFromSeed } from '../src/identity.mjs';
import { createMessage, stampPow, DEFAULT_POW_BITS } from '../src/message.mjs';

const BASE = join(import.meta.dirname, '..', '.tmp', `store-${Date.now()}`);
mkdirSync(BASE, { recursive: true });

let n = 0;
const pass = (s) => { n++; console.log(`PASS ${s}`); };

const seed = (b) => { const a = new Uint8Array(32); a.fill(b); return a; };
const alice = identityFromSeed(seed(1));
const mallory = identityFromSeed(seed(2));
const mk = (who, seq, body) =>
  createMessage(who, { type: 'announce', topic: 't', body, refs: [] },
    { seq, ts: Date.now(), bits: DEFAULT_POW_BITS });

// --- 1. append verifies before writing --------------------------------------
{
  const store = new AppendOnlyStore(join(BASE, 'a'));
  const m1 = mk(alice, 1, { hello: 'world' });

  const ok = store.append(m1);
  assert.equal(ok.ok, true, `expected append to succeed: ${JSON.stringify(ok)}`);
  pass('append accepts a valid signed message');

  const before = statSync(store.path).size;
  const bad = JSON.parse(JSON.stringify(m1));
  bad.body.hello = 'tampered';
  const refused = store.append(bad);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'bad_pow');
  assert.equal(statSync(store.path).size, before, 'a refused append must write nothing');
  pass('append refuses a naive tamper and leaves the file byte-identical');

  const restamped = stampPow(JSON.parse(JSON.stringify(bad)), DEFAULT_POW_BITS);
  const refused2 = store.append(restamped);
  assert.equal(refused2.ok, false);
  assert.equal(refused2.reason, 'bad_sig', 're-stamping the PoW must not defeat the signature');
  pass('append refuses a re-stamped tamper with bad_sig');
}

// --- 2. a torn tail loses only the last partial line ------------------------
{
  const store = new AppendOnlyStore(join(BASE, 'b'));
  store.append(mk(alice, 1, { a: 1 }));
  appendFileSync(store.path, '{"v":1,"from":"this line was cut off mid-wr');

  const meta = store.readAllWithMeta();
  assert.equal(meta.tornTail, true, 'a partial final line must be reported');
  assert.equal(meta.messages.length, 1, 'everything before the torn line must survive');
  pass('a torn tail is reported and earlier messages survive');

  const v = store.verifyChain();
  assert.equal(v.ok, false, 'a torn tail must not be silently ignored');
  assert.ok(v.errors.some((e) => e.kind === 'torn_tail'));
  pass('verifyChain reports a torn tail');
}

// --- 3. a re-used sequence number fails the chain ---------------------------
{
  const store = new AppendOnlyStore(join(BASE, 'c'));
  store.append(mk(alice, 1, { first: true }));
  store.append(mk(alice, 1, { second: true })); // seq 1 again: a replay or a rollback

  const v = store.verifyChain();
  assert.equal(v.ok, false, 'a re-used seq must fail the chain');
  const err = v.errors.find((e) => e.kind === 'seq_not_increasing');
  assert.ok(err, `expected seq_not_increasing, got ${JSON.stringify(v.errors)}`);
  assert.equal(err.previous, 1);
  assert.equal(err.current, 1);
  pass('a re-used sequence number fails the chain');
}

// --- 4. a duplicated message fails the chain --------------------------------
{
  const store = new AppendOnlyStore(join(BASE, 'd'));
  const m = mk(alice, 1, { once: true });
  store.append(m);
  store.append(m); // bypassing node-level dedup on purpose

  const v = store.verifyChain();
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.kind === 'duplicate_message'));
  pass('a byte-identical duplicate fails the chain');
}

// --- 5. a corrupt line in the middle is not silently dropped ----------------
{
  const store = new AppendOnlyStore(join(BASE, 'e'));
  store.append(mk(alice, 1, { a: 1 }));
  appendFileSync(store.path, 'this is not json at all\n');
  store.append(mk(alice, 2, { a: 2 }));

  const v = store.verifyChain();
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.kind === 'corrupt_line'),
    `expected corrupt_line, got ${JSON.stringify(v.errors)}`);
  assert.equal(v.messages.length, 2, 'the two good messages must still be readable');
  pass('a corrupt line in the middle fails the chain without hiding good messages');
}

// --- 6. a forged signature fails the chain ----------------------------------
{
  const store = new AppendOnlyStore(join(BASE, 'f'));
  const m = mk(alice, 1, { a: 1 });
  store.append(m);
  // Hand-write a line claiming to be alice but signed by someone else.
  const impostor = createMessage(mallory, { type: 'announce', topic: 't', body: { a: 1 }, refs: [] },
    { seq: 2, ts: Date.now(), bits: DEFAULT_POW_BITS });
  impostor.from = alice.agentId;
  const restamped = stampPow(impostor, DEFAULT_POW_BITS);
  appendFileSync(store.path, JSON.stringify(restamped) + '\n');

  const v = store.verifyChain();
  assert.equal(v.ok, false, 'an impostor must fail the chain');
  assert.ok(v.errors.some((e) => e.kind === 'bad_signature'),
    `expected bad_signature, got ${JSON.stringify(v.errors)}`);
  pass('a message claiming another agent\'s identity fails the chain');
}

// --- 7. readSince and stats --------------------------------------------------
{
  const store = new AppendOnlyStore(join(BASE, 'g'));
  store.append(mk(alice, 1, {}));
  store.append(mk(mallory, 1, {}));
  store.append(mk(alice, 2, {}));

  const since = store.readSince(alice.agentId, 1);
  assert.equal(since.length, 1);
  assert.equal(since[0].seq, 2);
  pass('readSince returns only later messages from the requested sender');

  const st = store.stats();
  assert.equal(st.messages, 3);
  assert.equal(st.senders, 2);
  assert.ok(st.bytes > 0);
  pass('stats reports messages, senders and bytes');

  assert.equal(store.verifyChain().ok, true);
  pass('a clean log verifies');
}

console.log(`\n${n} assertions passed.`);
