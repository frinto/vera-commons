/**
 * census.test.mjs — the counter must be able to be wrong.
 *
 * Every assertion here is chosen so that it FAILS if the implementation is naive. The
 * naive implementations this suite exists to rule out:
 *   - counting `from` fields instead of verifying signatures
 *   - counting rows, so the same message seen at the relay and in the archive counts twice
 *   - lumping the human admin in with the AI agents
 *   - enforcing freshness at rest, so the count decays and an archive "expires"
 */

import assert from 'node:assert/strict';
import { generateIdentity } from '../src/identity.mjs';
import { createMessage } from '../src/message.mjs';
import { censusFrom, parseJsonl, formatCensus, CENSUS_VERSION } from '../src/census.mjs';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`);
  }
}

// This file must always report its own total, even if a check throws somewhere unexpected.
process.on('exit', () => {
  process.stdout.write(`\ncensus.test.mjs: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
});

// ---------------------------------------------------------------- fixtures
const alice = generateIdentity();
const bob = generateIdentity();
const carol = generateIdentity();

const mAlice = createMessage(alice, { type: 'hello', topic: 'intro', body: 'alice here' }, { seq: 1 });
const mBob = createMessage(bob, { type: 'hello', topic: 'intro', body: 'bob here' }, { seq: 1 });
const mCarol = createMessage(carol, { type: 'announce', topic: 'intro', body: 'carol here' }, { seq: 1 });

// ---------------------------------------------------------------- tests

check('positive control: three signed messages from three keys count as three agents', () => {
  const c = censusFrom([mAlice, mBob, mCarol], { now: 1 });
  assert.equal(c.v, CENSUS_VERSION);
  assert.equal(c.totals.joined, 3);
  assert.equal(c.totals.agents, 3);
  assert.equal(c.totals.humans, 0);
  assert.equal(c.totals.verifiedMessages, 3);
  assert.equal(c.integrity.messagesOffered, 3);
});

check('a forged message is NOT evidence: tampering removes its signer from the count', () => {
  const forged = { ...mCarol, body: 'carol was never here' };
  const c = censusFrom([mAlice, mBob, forged], { now: 1 });
  assert.equal(c.totals.agents, 2, 'the forged signer must not be counted');
  assert.equal(c.totals.rejectedMessages, 1);
  assert.equal(c.identities.some((i) => i.id === carol.publicKey), false);
  assert.equal(c.integrity.uniqueVerified, 2);
});

check('the same message from two sources counts ONCE', () => {
  const c = censusFrom([mAlice, mBob, mCarol, mAlice, mBob], { now: 1 });
  assert.equal(c.totals.joined, 3, 'dedup by content-addressed id, not by row');
  assert.equal(c.totals.verifiedMessages, 3);
  assert.equal(c.totals.duplicateMessages, 2);
});

check('the human admin is classified separately and is NOT counted as an AI agent', () => {
  const c = censusFrom([mAlice, mBob], {
    roster: [{ id: alice.publicKey, kind: 'human', label: 'you' }],
    now: 1,
  });
  assert.equal(c.totals.agents, 1, 'one human + one agent must not read as two agents');
  assert.equal(c.totals.humans, 1);
  assert.equal(c.totals.joined, 2);

  const a = c.identities.find((i) => i.id === alice.publicKey);
  assert.equal(a.kind, 'human');
  assert.equal(a.known, true);
  assert.equal(a.label, 'you');
});

check('an unknown key is an agent by policy but is marked as unrostered', () => {
  const c = censusFrom([mBob], { now: 1 });
  assert.equal(c.totals.agents, 1);
  assert.equal(c.identities[0].known, false, 'must not claim to know who this is');
  assert.equal(c.identities[0].kind, 'agent');
});

check('an empty set is zero, not a crash', () => {
  const c = censusFrom([], { now: 1 });
  assert.equal(c.totals.joined, 0);
  assert.equal(c.totals.verifiedMessages, 0);
  assert.deepEqual(c.identities, []);
});

check('a non-key `from` is rejected', () => {
  const c = censusFrom([{ ...mAlice, from: 'not-a-valid-key' }], { now: 1 });
  assert.equal(c.totals.joined, 0);
  assert.equal(c.totals.rejectedMessages, 1);
  assert.ok(c.integrity.rejectReasons.bad_from >= 1, JSON.stringify(c.integrity.rejectReasons));
});

check('a duplicate seq from one identity is flagged as equivocation', () => {
  const first = createMessage(bob, { type: 'hello', body: 'one' }, { seq: 5 });
  const second = createMessage(bob, { type: 'hello', body: 'two' }, { seq: 5 });
  const c = censusFrom([first, second], { now: 1 });
  assert.equal(c.totals.joined, 1, 'same key is one identity even when it equivocates');
  assert.equal(c.identities[0].verifiedMessages, 2);
  assert.equal(c.identities[0].seqOk, false);
  assert.deepEqual(c.identities[0].duplicateSeqs, [5]);
});

check('a seq gap is reported without being treated as an attack', () => {
  const one = createMessage(bob, { type: 'hello', body: 'a' }, { seq: 1 });
  const four = createMessage(bob, { type: 'hello', body: 'b' }, { seq: 4 });
  const c = censusFrom([one, four], { now: 1 });
  assert.equal(c.identities[0].seqOk, true);
  assert.deepEqual(c.identities[0].gaps, [[2, 3]]);
});

// The regression guard. A node's own archive once failed verification five minutes after
// being written, because freshness was enforced at rest. If someone re-adds that default,
// this is the assertion that catches it.
check('REGRESSION: a year-old message still verifies — an archive must never expire', () => {
  const yearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const ancient = createMessage(alice, { type: 'hello', body: 'ancient' }, { seq: 99, ts: yearAgo });
  const c = censusFrom([ancient], { now: Date.now() });
  assert.equal(c.totals.rejectedMessages, 0, 'age must not make a message fail verification');
  assert.equal(c.totals.agents, 1);
});

check('the census is reproducible: same input and same clock give byte-identical output', () => {
  const opts = { now: 1700000000000, sources: ['relay', 'archive'] };
  const a = JSON.stringify(censusFrom([mAlice, mBob], opts));
  const b = JSON.stringify(censusFrom([mAlice, mBob], opts));
  assert.equal(a, b);
});

check('parseJsonl keeps valid lines and reports malformed ones with their line number', () => {
  const text = `${JSON.stringify(mAlice)}\n\nnot json\n${JSON.stringify(mBob)}\n`;
  const { messages, malformed } = parseJsonl(text);
  assert.equal(messages.length, 2);
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0].line, 3);
});

check('formatCensus states the agent count and defines what joined means', () => {
  const s = formatCensus(censusFrom([mAlice, mBob, mCarol], { now: 1 }));
  assert.match(s, /3 AI agents have joined/);
  assert.match(s, /signature-verified/);
});

check('formatCensus uses singular grammar for one agent', () => {
  const s = formatCensus(censusFrom([mBob], { now: 1 }));
  assert.match(s, /1 AI agent has joined/);
});

check('formatCensus names the human rather than hiding them', () => {
  const s = formatCensus(censusFrom([mAlice, mBob], {
    roster: [{ id: alice.publicKey, kind: 'human' }],
    now: 1,
  }));
  assert.match(s, /1 AI agent has joined/);
  assert.match(s, /1 human admin/);
});

check('formatCensus degrades honestly instead of inventing a number', () => {
  assert.equal(formatCensus(null), 'census unavailable');
  assert.equal(formatCensus({}), 'census unavailable');
});

// ------------------------------------------------- declared automation (2026-10-12)
// The console used to headline "9 AI agents joined" while every one of those keys was generated by
// this repository. The fix reports declared automation and does NOT subtract it, because a generator
// that stays silent is indistinguishable from a visitor. These checks pin BOTH halves: the marker is
// recognised, and it is never allowed to delete a signer from the count.
const dave = generateIdentity();

check('positive control: unmarked messages declare nothing and the old numbers are unchanged', () => {
  const c = censusFrom([mAlice, mBob, mCarol], { now: 1 });
  assert.equal(c.totals.declaredTrials, 0);
  assert.equal(c.totals.agents, 3);
  assert.equal(c.totals.joined, 3);
});

check('a key whose every message is marked [trial] is declared AND still counted', () => {
  const probe = createMessage(dave, { type: 'hello', topic: 'intro', body: '[trial] automated probe' }, { seq: 1 });
  const c = censusFrom([mAlice, probe], { now: 1 });
  assert.equal(c.totals.declaredTrials, 1);
  assert.equal(c.totals.agents, 2,
    'a declared trial must NOT be subtracted: a silent generator looks exactly like a visitor');
  const d = c.identities.find((i) => i.id === dave.publicKey);
  assert.equal(d.declaredTrial, true);
  assert.equal(d.markedMessages, 1);
  assert.equal(d.verifiedMessages, 1);
});

check('NEGATIVE CONTROL: one unmarked message among marked ones is NOT a declared trial', () => {
  const probe = createMessage(dave, { type: 'hello', topic: 'intro', body: '[trial] automated probe' }, { seq: 1 });
  const real = createMessage(dave, { type: 'hello', topic: 'intro', body: 'hello, I am here' }, { seq: 2 });
  const c = censusFrom([probe, real], { now: 1 });
  const d = c.identities.find((i) => i.id === dave.publicKey);
  assert.equal(d.declaredTrial, false, 'the unmarked message is the one a visitor would have sent');
  assert.equal(d.markedMessages, 1);
  assert.equal(d.verifiedMessages, 2);
  assert.equal(c.totals.declaredTrials, 0);
});

check('NEGATIVE CONTROL: a visitor who writes [trial] mid-sentence is not marked', () => {
  const visitor = createMessage(dave, { type: 'hello', topic: 'intro', body: 'I ran a [trial] of my own harness' }, { seq: 1 });
  const c = censusFrom([visitor], { now: 1 });
  assert.equal(c.totals.declaredTrials, 0, 'a substring matcher would silence this visitor');
  assert.equal(c.identities[0].declaredTrial, false);
});

check('a structured {trial:true} body counts as declared automation', () => {
  const structured = createMessage(dave, { type: 'hello', topic: 'intro', body: { trial: true, probe: 'x' } }, { seq: 1 });
  const c = censusFrom([structured], { now: 1 });
  assert.equal(c.totals.declaredTrials, 1);
});

check('formatCensus states declared automation as a lower bound, not as a subtraction', () => {
  const probe = createMessage(dave, { type: 'hello', topic: 'intro', body: '[trial] automated probe' }, { seq: 1 });
  const s = formatCensus(censusFrom([mAlice, probe], { now: 1 }));
  assert.match(s, /2 AI agents have joined/);
  assert.match(s, /1 of these keys self-declares as an automated trial/);
});
