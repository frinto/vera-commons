import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { identityFromSeed } from '../src/identity.mjs';
import { canonicalize, createMessage, messageId, powOK, signingBytes, stampPow, verifyMessage } from '../src/message.mjs';

let passed = 0;
function check(name, fn) {
  fn();
  console.log(`PASS ${name}`);
  passed += 1;
}
// See identity.test.mjs: a suite that never announces its total can silently vanish from a
// tally, and the tally still looks credible.
process.on('exit', () => console.log(`\n${passed} assertions passed.`));
function reason(message, expected, opts = {}) {
  assert.deepEqual(verifyMessage(message, opts), { ok: false, reason: expected });
}

const identity = identityFromSeed(Buffer.alloc(32, 7));
const other = identityFromSeed(Buffer.alloc(32, 8));
const now = 1_800_000_000_000;
const baseFields = { type: 'announce', topic: 'test', body: { hello: 'world' }, refs: [] };
const msg = createMessage(identity, baseFields, { seq: 1, ts: now, bits: 12 });
const opts = { now };

check('valid signed and stamped message verifies', () => assert.deepEqual(verifyMessage(msg, opts), { ok: true }));
check('message identifier excludes proof-of-work nonce', () => {
  const changed = { ...msg, pow: `${msg.pow}00` };
  assert.equal(messageId(msg), messageId(changed));
});
const canonicalA = { v: 1, from: 'x', seq: 1, ts: now, type: 'hello', topic: null, body: { z: 1, a: 2 }, refs: [], pow: '00', sig: 's' };
const canonicalB = { sig: 's', pow: '00', refs: [], body: { a: 2, z: 1 }, topic: null, type: 'hello', ts: now, seq: 1, from: 'x', v: 1 };
const canonicalC = { type: 'hello', body: { a: 2, z: 1 }, v: 1, from: 'x', ts: now, seq: 1, topic: null, refs: [], sig: 's', pow: 'ff' };
check('canonical bytes ignore key insertion order', () => assert.deepEqual(canonicalize(canonicalA), canonicalize(canonicalB)));
check('message ID stable across key insertion order', () => assert.equal(messageId(canonicalA), messageId(canonicalB)));
check('message ID excludes proof-of-work nonce', () => assert.equal(messageId(canonicalA), messageId(canonicalC)));
check('canonical bytes survive parse and recanonicalize', () => {
  assert.deepEqual(canonicalize(JSON.parse(canonicalize(msg).toString('utf8'))), canonicalize(msg));
});
check('tampered body fails signature after valid re-stamping', () => {
  const tampered = { ...msg, body: { hello: 'wurld' } };
  const restamped = stampPow(tampered, 12);
  reason(restamped, 'bad_sig', opts);
});
check('valid signature from a different message fails', () => {
  const second = createMessage(identity, { ...baseFields, body: { hello: 'different' } }, { seq: 2, ts: now, bits: 12 });
  const swapped = { ...msg, sig: second.sig };
  reason(swapped, 'bad_sig', opts);
});
check('malformed sender key fails with bad_from', () => reason({ ...msg, from: `${msg.from.slice(0, 10)}!` }, 'bad_from', opts));
check('different valid sender key is caught by proof-of-work', () => reason({ ...msg, from: other.publicKey }, 'bad_pow', opts));
check('wrong proof-of-work nonce fails with bad_pow', () => {
  const wrong = { ...msg, pow: `${msg.pow}wrong` };
  reason(wrong, 'bad_pow', opts);
});
check('out-of-window timestamp fails with bad_ts when freshness IS enforced', () => {
  reason({ ...msg, ts: now - 300_001 }, 'bad_ts', { ...opts, enforceFreshness: true });
});
check('a message still verifies ONE YEAR after it was written — an archive must not expire', () => {
  // Regression test for a real shipped defect. The clock-skew window used to be enforced
  // unconditionally inside verifyMessage, so EVERY stored message became "invalid" five
  // minutes after it was written, and a node's own archive reported ok:false. Authenticity
  // is permanent; only freshness is time-bound, and only an ingest path cares about it.
  assert.deepEqual(verifyMessage(msg, { now: now + 365 * 24 * 60 * 60 * 1000 }), { ok: true });
});
check('that same year-old message is still refused when freshness IS enforced', () => {
  reason(msg, 'bad_ts', { now: now + 365 * 24 * 60 * 60 * 1000, enforceFreshness: true });
});
check('zero sequence number fails with bad_seq', () => reason({ ...msg, seq: 0 }, 'bad_seq', opts));
check('negative sequence number fails with bad_seq', () => reason({ ...msg, seq: -1 }, 'bad_seq', opts));
check('unknown message type fails with bad_type', () => reason({ ...msg, type: 'unknown' }, 'bad_type', opts));
check('unsupported version fails with bad_version', () => reason({ ...msg, v: 2 }, 'bad_version', opts));
check('oversized envelope fails with too_large', () => reason({ ...msg, body: 'x'.repeat(70_000) }, 'too_large', { ...opts, maxBytes: 64 * 1024 }));
check('malformed envelope fails with bad_shape', () => reason({ ...msg, refs: null }, 'bad_shape', opts));
const stampStart = performance.now();
const stamped = stampPow({ ...msg, pow: '' }, 12);
const stampElapsed = performance.now() - stampStart;
check('stamped nonce satisfies 12-bit proof-of-work', () => assert.equal(powOK(stamped, 12), true));
check('12-bit proof-of-work stamps under one second', () => assert.ok(stampElapsed < 1000, `stamping took ${stampElapsed}ms`));
