// RED ARM: the admission gate must be bound to an identity.
//
// The defect this test exists for: the admission record carried NO public key. `start(joinKey)`
// took only a join key, `answer()` scored answers without naming who gave them, and `interview()`
// took free text from whoever held the uuid. So the gate could prove "someone derived 150 answers"
// and could never say WHO — and the permit that grants real authority needs a grantee key.
// Every part existed; the seam between them did not.
//
// A test that passes on the broken code is worse than no test, so each case below is written
// against the property, not the implementation.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdmissionManager, bindBytes, interviewBytes } from '../src/admission.mjs';
import { generateIdentity, sign, verify } from '../src/identity.mjs';

const KB = { chains: [
  ['falcon', 'bird', 'animal', 'living thing'],
  ['sparrow', 'bird', 'animal', 'living thing'],
  ['salmon', 'fish', 'animal', 'living thing'],
  ['whale', 'mammal', 'animal', 'living thing'],
  ['oak', 'tree', 'plant', 'living thing'],
  ['granite', 'igneous rock', 'rock', 'mineral'],
  ['triangle', 'polygon', 'shape', 'abstract thing'],
] };
const SALT = 'binding-test-verifier-secret';

const roots = [];
function fixture({ clock = { value: 10_000 }, items = 12, windowMs = 900_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'commons-binding-'));
  roots.push(dir);
  const manager = createAdmissionManager({ dir, salt: SALT, kb: KB, items, windowMs, now: () => clock.value });
  return { dir, manager, clock };
}
function solve(challenge) {
  return challenge.items.map((item) => {
    const p = item.premise.match(/^An? (.+?) is an? /);
    const h = item.hypothesis.match(/ is an? (.+?)\.$/);
    if (!p || !h) throw new Error(`solve: unparsable item ${JSON.stringify(item)}`);
    const chain = KB.chains.find((c) => c[0] === p[1]);
    if (!chain) throw new Error(`solve: "${p[1]}" absent from the taxonomy`);
    return chain.slice(1).includes(h[1]) ? 'ENTAILED' : 'CONTRADICTED';
  });
}

/** Start a challenge and answer it correctly, returning the answered admission id. */
function answered(manager, joinKey, opts) {
  const { id, challenge } = manager.start(joinKey, opts);
  const r = manager.answer(id, solve(challenge));
  assert.equal(r.ok, true, `the challenge fixture must score as passing (got ${JSON.stringify(r)})`);
  return id;
}

let n = 0;
function ok(label) { n++; console.log(`PASS ${label}`); }

try {
  // --- 0. the byte-helpers the agent signs over must exist and be deterministic ------------
  assert.equal(typeof bindBytes, 'function', 'bindBytes must be exported so an agent can sign it');
  assert.equal(typeof interviewBytes, 'function', 'interviewBytes must be exported so an agent can sign it');
  ok('the signing helpers are exported for agents to use');

  const aria = generateIdentity();
  const mallory = generateIdentity();
  const vera = generateIdentity();

  // --- 1. a challenge records the key the agent will be admitted as ------------------------
  {
    const { manager } = fixture();
    const id = answered(manager, 'bound-key-agent', { agentId: aria.agentId });
    const rec = (await_(manager.list())).find((r) => r.id === id);
    assert.equal(rec.agentId, aria.agentId, 'the challenge must record the declaring agent key');
    assert.equal(rec.bound, true, 'a record started with a key must report bound:true');
    ok('a challenge binds to the public key the agent declares at start');

    // An unbound record is still possible (legacy/pretend), but it must SAY so.
    const id2 = answered(manager, 'unbound-agent');
    const rec2 = (await_(manager.list())).find((r) => r.id === id2);
    assert.equal(rec2.bound, false, 'a record started without a key must report bound:false');
    ok('a record started without a key reports bound:false rather than pretending');
  }

  // --- 2. an unsigned interview on a bound record is REFUSED ------------------------------
  {
    const { manager } = fixture();
    const id = answered(manager, 'unsigned', { agentId: aria.agentId });
    const r = manager.interview(id, { statement: 'trust me', answers: {} });
    assert.notEqual(r.ok, true, 'an UNSIGNED interview must not be accepted on a bound record');
    assert.equal(r.reason, 'interview_not_signed', `expected interview_not_signed, got ${JSON.stringify(r)}`);
    ok('an unsigned interview on a bound record is refused');
  }

  // --- 3. an interview signed by the WRONG key is REFUSED ----------------------------------
  {
    const { manager } = fixture();
    const id = answered(manager, 'wrong-key', { agentId: aria.agentId });
    const statement = 'I am definitely aria';
    const sig = sign(mallory, interviewBytes({ id, agentId: aria.agentId, statement }));
    const r = manager.interview(id, { statement, answers: {}, agentId: aria.agentId, sig });
    assert.notEqual(r.ok, true, 'a signature by a non-bound key must not be accepted');
    assert.equal(r.reason, 'interview_bad_signature', `expected interview_bad_signature, got ${JSON.stringify(r)}`);
    ok("an interview signed by a key that is not the bound key is refused");
  }

  // --- 4. a CORRECTLY signed interview is accepted, verbatim ------------------------------
  {
    const { manager } = fixture();
    const id = answered(manager, 'right-key', { agentId: aria.agentId });
    const statement = 'I am aria and I signed this.';
    const sig = sign(aria, interviewBytes({ id, agentId: aria.agentId, statement }));
    const r = manager.interview(id, { statement, answers: { q1: 'a1' }, agentId: aria.agentId, sig });
    assert.equal(r.ok, true, `a correctly signed interview must be accepted: ${JSON.stringify(r)}`);
    const rec = (await_(manager.list())).find((x) => x.id === id);
    assert.equal(rec.interview.statement, statement, 'the statement must be stored verbatim');
    assert.equal(rec.interview.signed, true, 'a signed interview must be flagged as signed');
    // A flag is not evidence. If the signature is checked at the door and then discarded, the
    // record asserts `signed:true` and carries nothing anyone else can re-check — the flag
    // becomes the only proof, and a flag is exactly what a tamperer would write. It must be
    // stored, and it must verify against the STORED statement and the BOUND key.
    assert.equal(typeof rec.interview.sig, 'string', 'the signature must be STORED, not checked and discarded');
    assert.equal(
      verify(aria.agentId, interviewBytes({ id, agentId: aria.agentId, statement }), rec.interview.sig),
      true,
      'a third party must be able to re-verify the stored record from the store alone',
    );
    // And the unsigned path must not fabricate one.
    const unsignedFix = fixture();
    const idU = answered(unsignedFix.manager, 'unbound-sig');
    unsignedFix.manager.interview(idU, { statement: 'unsigned', answers: {} });
    const recU = (await_(unsignedFix.manager.list())).find((x) => x.id === idU);
    assert.equal(recU.interview.sig, null, 'an unsigned interview must store sig:null, never a placeholder');
    ok('a correctly signed interview is accepted and stored verbatim');
  }

  // --- 5. a signature does not transfer to different text ---------------------------------
  {
    const { manager } = fixture();
    const id = answered(manager, 'swap-text', { agentId: aria.agentId });
    const sig = sign(aria, interviewBytes({ id, agentId: aria.agentId, statement: 'the harmless one' }));
    const r = manager.interview(id, { statement: 'something else entirely', answers: {}, agentId: aria.agentId, sig });
    assert.notEqual(r.ok, true, 'a signature over one statement must not authorise another');
    assert.equal(r.reason, 'interview_bad_signature');
    ok('a signature over one statement cannot be replayed onto different text');
  }

  // --- 6. a signature does not transfer to a different admission --------------------------
  {
    const { manager } = fixture();
    const idA = answered(manager, 'replay-a', { agentId: aria.agentId });
    const idB = answered(manager, 'replay-b', { agentId: aria.agentId });
    const statement = 'the same words';
    const sigForA = sign(aria, interviewBytes({ id: idA, agentId: aria.agentId, statement }));
    const r = manager.interview(idB, { statement, answers: {}, agentId: aria.agentId, sig: sigForA });
    assert.notEqual(r.ok, true, 'a signature for admission A must not authorise admission B');
    assert.equal(r.reason, 'interview_bad_signature');
    ok('a signed interview cannot be replayed onto a different admission');
  }

  // --- 7. GRANT on an unbound record is REFUSED (this is the permit seam) -----------------
  {
    const { manager } = fixture();
    const id = answered(manager, 'grant-unbound');
    const r = manager.decide(id, 'grant', vera.agentId);
    assert.notEqual(r.ok, true, 'granting an unbound admission would issue a permit to nobody');
    assert.equal(r.reason, 'cannot_grant_unbound_admission', `expected cannot_grant_unbound_admission, got ${JSON.stringify(r)}`);
    ok('a permit cannot be granted for an admission with no bound key');

    // Refusing needs no grantee, so it must still work — otherwise a bad record is stuck forever.
    const r2 = manager.decide(id, 'refuse', vera.agentId);
    assert.equal(r2.decision, 'refuse', `refusing an unbound record must remain possible: ${JSON.stringify(r2)}`);
    ok('refusing an unbound admission is still possible');
  }

  // --- 8. GRANT records the GRANTEE, so the permit has a target ---------------------------
  {
    const { manager } = fixture();
    const id = answered(manager, 'grant-bound', { agentId: aria.agentId });
    const statement = 'binding me';
    manager.interview(id, { statement, answers: {}, agentId: aria.agentId, sig: sign(aria, interviewBytes({ id, agentId: aria.agentId, statement })) });
    const r = manager.decide(id, 'grant', vera.agentId);
    assert.equal(r.decision, 'grant', `a bound, interviewed admission must be grantable: ${JSON.stringify(r)}`);
    assert.equal(r.grantee, aria.agentId, 'the decision must name the key being admitted');
    assert.equal(r.by, vera.agentId, 'the decision must still name the deciding admin');
    ok('granting records the grantee key alongside the deciding admin');
  }

  // --- 9. an existing UNBOUND record can still be bound, but only by proving the key ------
  {
    const { manager } = fixture();
    const id = answered(manager, 'late-bind');
    const badSig = sign(mallory, bindBytes({ id, agentId: aria.agentId }));
    const bad = manager.bind(id, { agentId: aria.agentId, sig: badSig });
    assert.notEqual(bad.ok, true, 'a bind signature by another key must be refused');
    assert.equal(bad.reason, 'bind_bad_signature', `expected bind_bad_signature, got ${JSON.stringify(bad)}`);

    const good = manager.bind(id, { agentId: aria.agentId, sig: sign(aria, bindBytes({ id, agentId: aria.agentId })) });
    assert.equal(good.ok, true, `a correctly signed bind must be accepted: ${JSON.stringify(good)}`);
    const rec = (await_(manager.list())).find((x) => x.id === id);
    assert.equal(rec.agentId, aria.agentId, 'binding must set the key on the record');
    assert.equal(rec.bound, true);
    // Same rule as the interview: keep the proof. Without `bindSig`, the `agentId` field is
    // something every later reader has to take on trust, which is the defect being fixed here.
    const rawRec = JSON.parse(readFileSync(manager.storePath, 'utf8')).admissions.find((x) => x.id === id);
    assert.equal(typeof rawRec.bindSig, 'string', 'the BIND signature must be stored, not discarded');
    assert.equal(verify(aria.agentId, bindBytes({ id, agentId: aria.agentId }), rawRec.bindSig), true,
      'the stored bind signature must re-verify against the bound key');

    // Rebinding must not be possible: otherwise an admission could be stolen after the fact.
    const steal = manager.bind(id, { agentId: mallory.agentId, sig: sign(mallory, bindBytes({ id, agentId: mallory.agentId })) });
    assert.notEqual(steal.ok, true, 'an already-bound admission must not be rebindable');
    assert.equal(steal.reason, 'already_bound', `expected already_bound, got ${JSON.stringify(steal)}`);
    ok('an unbound record can be bound by proof of key, and cannot then be re-bound');
  }

  // --- 10. a bind signature does not transfer across admissions ---------------------------
  {
    const { manager } = fixture();
    const idA = answered(manager, 'bind-xfer-a');
    const idB = answered(manager, 'bind-xfer-b');
    const sigForA = sign(aria, bindBytes({ id: idA, agentId: aria.agentId }));
    const r = manager.bind(idB, { agentId: aria.agentId, sig: sigForA });
    assert.notEqual(r.ok, true, 'a bind signature for admission A must not bind admission B');
    assert.equal(r.reason, 'bind_bad_signature');
    ok('a bind signature cannot be replayed onto another admission');
  }

  // --- 11. a decided record cannot be interviewed or re-decided ---------------------------
  {
    const { manager } = fixture();
    const id = answered(manager, 'closed-shop', { agentId: aria.agentId });
    manager.decide(id, 'refuse', vera.agentId);
    const again = manager.decide(id, 'grant', vera.agentId);
    assert.notEqual(again.ok, true, 'a decided admission must not be re-decided');
    assert.equal(again.reason, 'already_decided');
    const late = manager.interview(id, { statement: 'too late', answers: {} });
    assert.notEqual(late.ok, true, 'a decided admission must not accept a later statement');
    assert.equal(late.reason, 'already_decided');
    ok('a decided admission is closed to both further interviews and re-decision');
  }

  console.log(`\nAll ${n} binding assertions passed.`);
} finally {
  for (const dir of roots) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}

// `list()` is synchronous in the manager; this keeps the call sites readable without duplicating
// the wrapper. Named with a trailing underscore so it cannot be confused with a real await.
function await_(value) { return value; }
