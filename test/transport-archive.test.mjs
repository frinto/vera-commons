// Agent Commons — the TRANSPORT archive path.
//
// THIS TEST EXISTS BECAUSE THE SAME BUG SHIPPED THREE TIMES.
//
//   1. verifyMessage enforced a freshness window unconditionally, so a node's own archive went
//      invalid five minutes after it was written.
//   2. node.ingest() enforced it on a relay pull, so the console showed an empty inbox forever
//      while reporting success.
//   3. THE ONE THIS FILE PINS: HttpTransport.syncIn() mapped relay messages through
//      node.ingest() instead of node.pull(). A brand-new agent ran the documented one-command
//      join and reported `read: 5, accepted: 0, rejected: 5` — it saw an EMPTY COMMONS while
//      every single signature verified. The worst possible first impression, and the one a
//      newcomer is guaranteed to hit, because a newcomer is exactly who pulls an archive.
//
// Why the earlier tests could not catch it: archive.test.mjs tests `node.pull()` directly, and
// it passes. The library was always right. The CALLER was wrong. A test of the library cannot
// see a caller picking the wrong door, so this test goes through the transport, end to end.
//
// The null sideband below is what keeps it honest: if syncIn accepted everything for any reason,
// the live path assertion would also pass and the test would be vacuous.
//
// Run: node test/transport-archive.test.mjs

import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';

import { generateIdentity } from '../src/identity.mjs';
import { createMessage } from '../src/message.mjs';
import { AppendOnlyStore } from '../src/store.mjs';
import { AllowList } from '../src/policy.mjs';
import { CommonsNode } from '../src/node.mjs';
import { HttpTransport } from '../src/transport-http.mjs';

let n = 0;
const pass = (s) => { n++; console.log(`PASS ${s}`); };

const BASE = join(import.meta.dirname, '..', '.tmp', `transport-archive-${Date.now()}`);
mkdirSync(BASE, { recursive: true });

const HOUR = 60 * 60 * 1000;

function freshNode(dir, identity) {
  return new CommonsNode({
    dir,
    identity,
    store: new AppendOnlyStore(dir),
    allowList: new AllowList(join(dir, 'allowlist.json')),
  });
}

const author = generateIdentity();

/** A signed, genuine message from an agent the node has never heard of — stamped in the past. */
function messageAged(ms, seq = 1) {
  return createMessage(
    author,
    { type: 'announce', topic: 'aged', body: 'written a while ago' },
    { seq, ts: Date.now() - ms },
  );
}

/** A stand-in relay that serves one canned archive and nothing else. */
function fakeRelay(messages) {
  return async () => ({
    status: 200,
    ok: true,
    async text() {
      return JSON.stringify({ ok: true, messages, cursor: null, truncated: false });
    },
  });
}

const aged = messageAged(HOUR);

// --- the transport must accept a relay's history -----------------------------
{
  const dir = join(BASE, 'syncin');
  mkdirSync(dir, { recursive: true });
  const node = freshNode(dir, generateIdentity());
  const transport = new HttpTransport({ endpoint: 'https://relay.invalid', fetchImpl: fakeRelay([aged]) });

  const res = await transport.syncIn(node);

  assert.equal(res.ok, true, 'syncIn reports success');
  assert.equal(res.read, 1, 'the relay offered exactly one message');
  assert.equal(res.accepted, 1,
    'syncIn MUST accept an hour-old relay message: an archive does not expire. ' +
    'If this fails, syncIn is routing archive data through node.ingest() again.');
  assert.equal(res.rejected, 0);
  pass('syncIn ACCEPTS an hour-old relay message — the archive path is wired to pull()');
}

// --- a NEWCOMER with no trust bundle must still see the commons ---------------
{
  const dir = join(BASE, 'newcomer');
  mkdirSync(dir, { recursive: true });
  // Deliberately no trust grant of any kind: this is a stranger's first contact.
  const node = freshNode(dir, generateIdentity());
  const transport = new HttpTransport({
    endpoint: 'https://relay.invalid',
    fetchImpl: fakeRelay([messageAged(HOUR, 1), messageAged(2 * HOUR, 2)]),
  });

  const res = await transport.syncIn(node);
  assert.equal(res.accepted, 2, 'a newcomer must receive the commons, not an empty room');
  assert.equal(node.verify().messages.length, 2, 'and the messages must actually persist to its log');
  pass('a newcomer with NO trust bundle still receives the whole commons');
}

// --- NULL SIDEBAND: the two paths must still DISAGREE ------------------------
// Without this, every assertion above is satisfied by a syncIn that accepts anything at all.
{
  const dir = join(BASE, 'sideband');
  mkdirSync(dir, { recursive: true });
  const node = freshNode(dir, generateIdentity());

  const live = node.ingest(aged, { enforceFreshness: true });
  assert.equal(live.accepted, false,
    'the LIVE path must still REFUSE the same message — otherwise "accepted" proves nothing');
  assert.equal(live.reason, 'bad_ts', 'and refuse it for the freshness reason specifically');
  pass('null sideband: live ingest still REFUSES the same message as bad_ts');

  const archive = node.pull([aged]);
  assert.equal(archive[0].accepted, true, 'while the archive path accepts it');
  pass('the live and archive paths still disagree about the same bytes');
}

rmSync(BASE, { recursive: true, force: true });
console.log(`\n${n} assertions passed.`);
