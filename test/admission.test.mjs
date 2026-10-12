// Verifier-side admission manager contract and secrecy controls.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdmissionManager } from '../src/admission.mjs';

const KB = { chains: [
  ['falcon', 'bird', 'animal', 'living thing'],
  ['sparrow', 'bird', 'animal', 'living thing'],
  ['salmon', 'fish', 'animal', 'living thing'],
  ['whale', 'mammal', 'animal', 'living thing'],
  ['wolf', 'mammal', 'animal', 'living thing'],
  ['oak', 'tree', 'plant', 'living thing'],
  ['fern', 'plant', 'living thing'],
  ['granite', 'igneous rock', 'rock', 'mineral'],
  ['quartz', 'mineral', 'mineral'],
  ['copper', 'metal', 'element', 'mineral'],
  ['triangle', 'polygon', 'shape', 'abstract thing'],
  ['sonnet', 'poem', 'text', 'abstract thing'],
] };
const SALT = 'admission-test-verifier-secret';
// A syntactically valid ed25519 public key (43-char base64url). Its private half is unknown and
// deliberately so: `decide()` must never need to verify a signature, only to require that a key
// was declared. Requiring a signature here would be testing the wrong layer.
const AGENT_ID = 'A'.repeat(43);
const TEST_KB = KB;

const roots = [];
function fixture({ clock = { value: 10_000 }, items = 30, windowMs = 45_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'commons-admission-'));
  roots.push(dir);
  const manager = createAdmissionManager({ dir, salt: SALT, kb: TEST_KB, items, windowMs, now: () => clock.value });
  return { dir, manager, clock };
}
function solve(challenge) {
  return challenge.items.map((item, i) => {
    // Accept BOTH articles. The generator now emits correct English ("an oak", not "a oak"), so a
    // parser pinned to the old "A ... is a ..." form rejects valid input — a stale test accusing
    // correct code. Failing loudly matters too: the previous version dereferenced a null match and
    // surfaced as "Cannot read properties of null", which names the wrong problem entirely.
    const p = item.premise.match(/^An? (.+?) is an? /);
    const h = item.hypothesis.match(/ is an? (.+?)\.$/);
    if (!p || !h) throw new Error(`solve: item ${i} did not parse as "<article> X is <article> Y": ${JSON.stringify(item)}`);
    const chain = TEST_KB.chains.find((candidate) => candidate[0] === p[1]);
    if (!chain) throw new Error(`solve: item ${i} entity "${p[1]}" is absent from the test taxonomy`);
    return chain.slice(1).includes(h[1]) ? 'ENTAILED' : 'CONTRADICTED';
  });
}
function assertShape(result, keys) { assert.deepEqual(Object.keys(result).sort(), [...keys].sort()); }

try {
  assert.throws(() => createAdmissionManager({ dir: 'x', salt: '', kb: TEST_KB }), /salt/);
  assert.throws(() => createAdmissionManager({ dir: 'x', salt: SALT, kb: {} }), /knowledge base/);
  console.log('PASS requires verifier-injected secrets');

  const { dir, manager } = fixture();
  const started = manager.start('join-key-123456');
  assertShape(started, ['id', 'challenge']);
  assertShape(started.challenge, ['seed', 'items', 'options', 'count', 'windowMs', 'passRatio']);
  assert.equal(started.challenge.count, 30);
  const wire = JSON.stringify(started.challenge);
  for (const item of started.challenge.items) assert.deepEqual(Object.keys(item).sort(), ['hypothesis', 'i', 'premise']);
  for (const blocked of ['answer', 'answerKey', 'key']) assert.equal(Object.hasOwn(started.challenge, blocked), false, `challenge leaked ${blocked}`);
  assert.equal(wire.includes(SALT), false);
  assert.equal(wire.includes(JSON.stringify(TEST_KB)), false, 'challenge exposed the full verifier knowledge base');
  const persisted = readFileSync(join(dir, 'admissions.json'), 'utf8');
  assert.equal(persisted.includes(SALT), false);
  assert.equal(persisted.includes(JSON.stringify(TEST_KB)), false);
  const record = JSON.parse(persisted).admissions[0];
  assert.deepEqual(Object.keys(record).sort(), ['id', 'joinKey', 'agentId', 'seed', 'issuedAt', 'windowMs', 'status', 'itemCount', 'verdict', 'interview'].sort());
  assert.equal(record.interview, null);
  // Started without a declared key, so the record must carry agentId:null — not omit the field,
  // which would make "no key" and "old record" indistinguishable on disk.
  assert.equal(record.agentId, null, 'a challenge started without a key must persist agentId:null');
  const listed = manager.list()[0];
  // The projection is pinned exactly, on purpose: every field here is something an outside reader
  // is entitled to see, and a silently added one would widen the published surface without review.
  // `boundVia` / `relayRequestId` were added deliberately — a relay-bound record was signed over a
  // different handle than a local one, so without them the stored signature cannot be re-derived.
  // `via` was added deliberately too: a decision reached over the relay is adopted rather than made
  // here, and a reader who cannot tell those apart has to take a record's word for its own
  // provenance. This assertion failing is the review, not an obstacle to it.
  assert.deepEqual(Object.keys(listed).sort(), ['id', 'joinKey', 'short', 'issuedAt', 'expiresAt', 'msRemaining', 'status', 'verdict', 'agentId', 'bound', 'boundVia', 'relayRequestId', 'via', 'decision', 'grantee', 'decidedBy', 'interview'].sort());
  // No key was ever attached to this record, so it must not claim a binding route either — a null
  // `boundVia` is the honest answer, and `'local'` here would be a small lie about a field whose
  // whole purpose is to say which bytes to re-derive.
  assert.equal(listed.boundVia, null, 'an unbound record must not claim a binding route');
  assert.equal(listed.relayRequestId, null);
  assert.equal(listed.status, 'pending');
  assert.equal(listed.verdict, null);
  assert.equal(listed.interview, null);
  // THE property the permit seam relies on. This record has no key, so it must report bound:false
  // — and exactly one such record exists for the whole program, which is why nothing was ever
  // admitted through it.
  assert.equal(listed.bound, false, 'a keyless challenge must report bound:false, not merely omit the key');
  assert.equal(listed.agentId, null);
  console.log('PASS start/list exact shape, secrecy, and persisted verifier state');

  const passed = manager.answer(started.id, solve(started.challenge));
  assertShape(passed, ['ok', 'correct', 'total', 'ratio', 'wrong']);
  assert.equal(passed.ok, true);
  assert.equal(passed.correct, 30);
  assert.equal(passed.total, 30);
  const afterAnswer = manager.list()[0];
  assert.equal(afterAnswer.status, 'answered');
  assert.equal(afterAnswer.verdict.ok, true);
  assert.equal(JSON.stringify(afterAnswer.verdict).includes('expected'), false);
  assert.equal('authorityGranted' in passed, false);
  // This record was started with NO key, so it has no grantee. Granting it would authorise nobody
  // in particular while LOOKING like an admission had happened — which is precisely what this
  // assertion used to require. It must now be refused, and refusing must leave the record open
  // rather than half-closing it.
  const unboundGrant = manager.decide(started.id, 'grant', 'admin-agent-7');
  assert.deepEqual(unboundGrant, { ok: false, reason: 'cannot_grant_unbound_admission' });
  assert.equal(manager.list()[0].status, 'answered', 'a refused grant must not close the record');
  console.log('PASS an admission with no bound key cannot be granted: a permit needs a grantee');

  // The same decision on a BOUND record succeeds, records its grantee, and still issues no
  // permit: a grant is bookkeeping, and authority remains a separate deliberate act.
  const boundFix = fixture();
  const boundChallenge = boundFix.manager.start('join-key-bound', { agentId: AGENT_ID });
  boundFix.manager.answer(boundChallenge.id, solve(boundChallenge.challenge));
  const grant = boundFix.manager.decide(boundChallenge.id, 'grant', 'admin-agent-7');
  assert.deepEqual(grant, { id: boundChallenge.id, decision: 'grant', by: 'admin-agent-7', grantee: AGENT_ID });
  assert.equal(boundFix.manager.list()[0].status, 'decided');
  assert.equal('permit' in grant, false, 'admin bookkeeping must not issue a permit');
  console.log('PASS a bound admission grants, names its grantee, and still issues no permit');

  const failed = fixture({ items: 20 });
  const failedChallenge = failed.manager.start('join-key-fail');
  const denied = failed.manager.answer(failedChallenge.id, Array(20).fill('incorrect'));
  assert.equal(denied.ok, false);
  assert.equal(denied.correct, 0);
  assert.equal(denied.total, 20);
  assert.ok(denied.wrong.length <= 5);
  assert.equal(JSON.stringify(denied).includes('expected'), false);
  assert.equal(failed.manager.list()[0].status, 'answered');
  assert.deepEqual(failed.manager.decide(failedChallenge.id, 'refuse', 'admin-agent-8'), {
    id: failedChallenge.id, decision: 'refuse', by: 'admin-agent-8', grantee: null,
  });
  // A DECIDED record reports "already decided", not "not answered": telling an operator that the
  // answer is missing when it is present and already ruled on sends them looking in the wrong
  // place. The two states are different events and must read differently.
  assert.equal(failed.manager.decide(failedChallenge.id, 'grant', 'admin-agent-8').reason, 'already_decided');
  // A record whose challenge was genuinely never answered still says exactly that.
  const pendingFix = fixture({ items: 8 });
  const pendingChallenge = pendingFix.manager.start('join-key-pending');
  assert.equal(pendingFix.manager.decide(pendingChallenge.id, 'grant', 'admin-agent-8').reason, 'challenge_not_answered');
  console.log('PASS failed answers are bounded and refusal/decision state is enforced');

  const expiring = fixture({ items: 8 });
  const expiringChallenge = expiring.manager.start('join-key-expiring');
  expiring.clock.value += 45_001;
  const expired = expiring.manager.list()[0];
  assert.equal(expired.status, 'expired');
  assert.ok(expired.msRemaining <= 0);
  assert.equal(expired.verdict, null);
  assert.equal(expiring.manager.answer(expiringChallenge.id, Array(8).fill('ENTAILED')).reason, 'expired');
  console.log('PASS expiration is clock-injectable and blocks late answers');

  const duplicate = fixture();
  duplicate.manager.start('same-key');
  assert.equal(duplicate.manager.start('same-key').reason, 'pending_challenge');
  assert.equal(duplicate.manager.answer('missing-id', []).reason, 'unknown_admission');
  assert.equal(duplicate.manager.decide('missing-id', 'grant', 'admin').reason, 'unknown_admission');
  assert.equal(duplicate.manager.decide('missing-id', 'grant', '').reason, 'admin_agent_required');
  console.log('PASS duplicate, unknown ID, and missing admin controls');

  assert.deepEqual(manager.interview('missing-id', { statement: 'Hello', answers: {} }), { reason: 'unknown_admission' });
  // A DECIDED record is closed. This used to be `started`, which the suite had granted; that
  // grant is now correctly refused, so the closed record is the one that was refused instead.
  assert.deepEqual(failed.manager.interview(failedChallenge.id, { statement: 'A late interview', answers: {} }), { reason: 'already_decided' });
  // An answered but UNBOUND record still accepts a statement — with no key declared there is
  // nothing to verify a signature against — and must SAY so by reporting signed:false rather
  // than letting an unsigned statement look indistinguishable from a proven one.
  assert.deepEqual(manager.interview(started.id, { statement: 'An unbound statement', answers: {} }), { ok: true, id: started.id, signed: false });
  assert.equal(expiring.manager.interview(expiringChallenge.id, { statement: 'Too late', answers: {} }).reason, 'expired');
  console.log('PASS interview rejects unknown, expired, and decided admissions');

  const interviewFixture = fixture({ items: 8 });
  const interviewChallenge = interviewFixture.manager.start('join-key-interview');
  assert.deepEqual(interviewFixture.manager.interview(interviewChallenge.id, { statement: '', answers: {} }), { reason: 'bad_statement' });
  assert.deepEqual(interviewFixture.manager.interview(interviewChallenge.id, { statement: 'x'.repeat(4001), answers: {} }), { reason: 'statement_too_long' });
  assert.deepEqual(interviewFixture.manager.interview(interviewChallenge.id, { statement: 'Statement', answers: [] }), { reason: 'bad_answers' });
  assert.deepEqual(interviewFixture.manager.interview(interviewChallenge.id, { statement: 'Statement', answers: { 'Why?': 'x'.repeat(4001) } }), { reason: 'answer_too_long' });
  console.log('PASS interview validates statement and answer bounds');

  const firstInterview = interviewFixture.manager.interview(interviewChallenge.id, {
    statement: 'First statement', answers: { 'Why join?': 'To contribute.' },
  });
  // signed:false is the honest label for an unbound record: the statement was accepted, but
  // nothing was proven about who wrote it, and the record must not imply otherwise.
  assert.deepEqual(firstInterview, { ok: true, id: interviewChallenge.id, signed: false });
  const firstInterviewAt = interviewFixture.manager.list()[0].interview.at;
  interviewFixture.clock.value += 100;
  const replacement = interviewFixture.manager.interview(interviewChallenge.id, { statement: 'Refined statement', answers: {} });
  assert.deepEqual(replacement, { ok: true, id: interviewChallenge.id, signed: false });
  const latestInterview = interviewFixture.manager.list()[0].interview;
  // `via: 'local'` is not decoration. A reader who wants to re-derive the signed bytes has to know
  // whether this text was signed over the local admission id or over a relay requestId; defaulting
  // to the local form without saying so would make the field a guess rather than a statement.
  assert.deepEqual(latestInterview, { statement: 'Refined statement', answers: {}, at: interviewFixture.clock.value, signed: false, signedBy: null, via: 'local', relayRequestId: null, sig: null });
  assert.ok(latestInterview.at > firstInterviewAt, 'replacement records the latest interviewAt');
  const persistedInterview = JSON.parse(readFileSync(interviewFixture.manager.storePath, 'utf8')).admissions[0].interview;
  assert.deepEqual(persistedInterview, { statement: 'Refined statement', answers: {}, interviewAt: interviewFixture.clock.value, signed: false, signedBy: null, sig: null });
  console.log('PASS interview accepts, replaces, timestamps, and persists submissions');

  // The interview is OPTIONAL — an admin may decide without one. The record still has to name a
  // grantee, so it is started with a key; those are two independent rules, not one.
  const noInterview = fixture({ items: 8 });
  const noInterviewChallenge = noInterview.manager.start('join-key-no-interview', { agentId: AGENT_ID });
  assert.equal(noInterview.manager.list()[0].interview, null);
  assert.equal(noInterview.manager.answer(noInterviewChallenge.id, solve(noInterviewChallenge.challenge)).ok, true);
  assert.deepEqual(noInterview.manager.decide(noInterviewChallenge.id, 'grant', 'admin-agent-no-interview'), {
    id: noInterviewChallenge.id, decision: 'grant', by: 'admin-agent-no-interview', grantee: AGENT_ID,
  });
  assert.equal(noInterview.manager.list()[0].status, 'decided');
  assert.equal(noInterview.manager.list()[0].interview, null);
  console.log('PASS an absent optional interview does not block admin decision');
} finally {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
}
