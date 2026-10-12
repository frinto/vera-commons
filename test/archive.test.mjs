// Agent Commons — the live/archive distinction.
//
// THIS TEST EXISTS BECAUSE THE SAME BUG SHIPPED TWICE.
//
// The rule is easy to state and was easy to get wrong: authenticity is permanent, freshness
// is a replay defence for LIVE traffic only. An archive must never expire (spec §3d).
//
// First occurrence: verifyMessage enforced the window unconditionally, so every stored message
// became invalid five minutes after it was written.
// Second occurrence: node.ingest() enforced it on a relay PULL, so fetching a published
// archive rejected everything older than five minutes and a console showed an empty inbox
// forever — while reporting success.
//
// A test that creates a message and reads it back in the same millisecond cannot see either.
// So this test deliberately spans time: it stamps messages in the past and asserts that the
// two paths disagree about them.
//
// Run: node test/archive.test.mjs

import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';

import { generateIdentity } from '../src/identity.mjs';
import { createMessage, verifyMessage, messageId, stampPow, powOK } from '../src/message.mjs';
import { AppendOnlyStore } from '../src/store.mjs';
import { AllowList } from '../src/policy.mjs';
import { CommonsNode } from '../src/node.mjs';

let n = 0;
const pass = (s) => { n++; console.log(`PASS ${s}`); };

const BASE = join(import.meta.dirname, '..', '.tmp', `archive-${Date.now()}`);
mkdirSync(BASE, { recursive: true });

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const YEAR = 365 * 24 * HOUR;

function freshNode(dir, identity) {
  return new CommonsNode({
    dir,
    identity,
    store: new AppendOnlyStore(dir),
    allowList: new AllowList(join(dir, 'allowlist.json')),
  });
}

const author = generateIdentity();

/** A signed, genuine message — just stamped in the past. */
function messageAged(ms, seq = 1) {
  return createMessage(
    author,
    { type: 'announce', topic: 'aged', body: 'written a while ago' },
    { seq, ts: Date.now() - ms },
  );
}

// --- the two paths must disagree about an old message ------------------------
{
  const dir = join(BASE, 'live-vs-archive');
  mkdirSync(dir, { recursive: true });
  const node = freshNode(dir, generateIdentity());

  const old = messageAged(HOUR);
  assert.equal(verifyMessage(old, { enforceFreshness: false }).ok, true,
    'an hour-old message is still AUTHENTIC — the signature does not decay');

  // LIVE path: refused, because a stranger handing us an hour-old message is a replay.
  const live = node.ingest(old, { enforceFreshness: true });
  assert.equal(live.accepted, false);
  assert.equal(live.reason, 'bad_ts');
  pass('live ingest REFUSES an hour-old message (bad_ts) — replay defence works');

  // ARCHIVE path: accepted, because a relay's history is history.
  const pulled = node.pull([old]);
  assert.equal(pulled[0].accepted, true, 'pulling the same message from a relay must accept it');
  pass('pull() ACCEPTS the very same message — an archive does not expire');
}

// --- a YEAR-old message: same disagreement, bigger number --------------------
{
  const dir = join(BASE, 'year');
  mkdirSync(dir, { recursive: true });
  const node = freshNode(dir, generateIdentity());
  const ancient = messageAged(YEAR);

  assert.equal(node.ingest(ancient, { enforceFreshness: true }).accepted, false);
  assert.equal(node.pull([ancient])[0].accepted, true);
  pass('a YEAR-old message is refused live and accepted from an archive');
}

// --- what was accepted must still verify, and must NOT be re-accepted --------
{
  const dir = join(BASE, 'roundtrip');
  mkdirSync(dir, { recursive: true });
  const node = freshNode(dir, generateIdentity());
  const old = messageAged(2 * HOUR);

  assert.equal(node.pull([old])[0].accepted, true);

  // The archive on disk must verify forever, with no fresh clock involved.
  const chain = node.store.verifyChain();
  assert.equal(chain.ok, true, `archive must verify: ${JSON.stringify(chain.errors)}`);
  assert.equal(chain.messages.length, 1);
  pass('the accepted archive verifies at rest, with no clock involved');

  // A duplicate pull is a no-op, not a second copy: content addressing makes replay harmless.
  const again = node.pull([old]);
  assert.equal(again[0].accepted, false);
  assert.equal(again[0].duplicate, true);
  pass('re-pulling the same message is a duplicate, not a second copy');
}

// --- the store itself must not impose freshness ------------------------------
{
  const dir = join(BASE, 'store');
  mkdirSync(dir, { recursive: true });
  const store = new AppendOnlyStore(dir);
  const old = messageAged(3 * HOUR);

  // Default: the store is a LOG, not a policy engine. It checks authenticity, nothing else.
  assert.equal(store.append(old).ok, true,
    'store.append must not enforce freshness by default — that is the caller\'s decision');
  pass('store.append() treats the log as a log: authenticity yes, freshness no');

  const dir2 = join(BASE, 'store-strict');
  mkdirSync(dir2, { recursive: true });
  const strict = new AppendOnlyStore(dir2);
  assert.equal(strict.append(old, { enforceFreshness: true }).ok, false,
    'and it must still be able to enforce it on request');
  pass('store.append({enforceFreshness:true}) still refuses a stale message on request');
}

// --- tampering is unaffected by any of this ---------------------------------
{
  const dir = join(BASE, 'tamper');
  mkdirSync(dir, { recursive: true });
  const node = freshNode(dir, generateIdentity());
  const old = messageAged(HOUR);

  // Arm 1: a naive edit. Proof-of-work covers the body too, so this is caught as bad_pow
  // before the signature is even consulted. Correct, but it proves less than it looks like.
  const naive = { ...old, body: 'rewritten by someone else' };
  const r1 = node.pull([naive]);
  assert.equal(r1[0].accepted, false);
  assert.equal(r1[0].reason, 'bad_pow');
  pass('an edited old message is refused (bad_pow fires first, because PoW covers the body)');

  // Arm 2 — THE SHARP ONE: re-mine the proof-of-work so PoW is valid again, leaving the
  // SIGNATURE as the only thing that can catch it. Without this arm the test above would
  // pass even if signatures were never checked on this path at all.
  const restamped = stampPow({ ...old, body: 'rewritten by someone else' });
  assert.equal(powOK(restamped), true, 'the re-mined PoW must genuinely be valid');
  const r2 = node.pull([restamped]);
  assert.equal(r2[0].accepted, false, 'a valid PoW must not rescue a forged body');
  assert.equal(r2[0].reason, 'bad_sig');
  pass('an edited old message with VALID re-mined proof-of-work is still refused (bad_sig)');
}

rmSync(BASE, { recursive: true, force: true });
console.log(`\n${n} archive assertions passed.`);
