// The relay verdict -> permit bridge, as a unit.
//
// This is the seam that made the gate a dead end: an agent could walk the whole gate over the relay
// (vendor #2 did, 150/150) and still be refused a permit, because `/api/grant` resolves grantees from
// the LOCAL admission store and a relay pass has no row there. The gate worked and nobody could get
// through it.
//
// The two properties worth testing hardest are both about not trusting the transport:
//   - the grantee is PROVEN by the bind's signature, never read off the relay's word;
//   - the operator must already be trusted HERE, because a verdict naming its own authority is a claim.
//
// Identities come from fixed seeds on purpose. A fixture that depends on Date.now() or on random keys
// is green by luck, and this project already paid for that lesson once.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canonicalize } from '../src/message.mjs';
import { identityFromSeed, sign } from '../src/identity.mjs';
import { relayBindBytes, bindBytes, isAgentId } from '../src/admission.mjs';
import { admissionFromVerdict, granteeFromAdmission } from '../src/permit-admission.mjs';

let n = 0;
const ok = (m) => { n++; console.log(`  PASS ${m}`); };

const id = (b) => identityFromSeed(Buffer.alloc(32, b));

const joiner = id(1);
const operator = id(2);
const stranger = id(3);
const victim = id(4);
const requestId = 'req-fixed-0001';

// A well-formed bind: the joiner signs over the RELAY domain, binding itself to this request.
const goodBind = {
  requestId,
  agentId: joiner.agentId,
  sig: sign(joiner, relayBindBytes({ requestId, agentId: joiner.agentId })),
};

// A well-formed verdict, signed by whoever is passed in.
const verdictBy = (decision, signer = operator) => {
  const claim = { requestId, decision, by: signer.agentId };
  return { ...claim, sig: sign(signer, Buffer.from(canonicalize(claim), 'utf8')) };
};

const call = (verdict, bind = goodBind, operatorKeys = [operator.agentId]) =>
  admissionFromVerdict({ verdict, bind, operatorKeys });

// --- 1. the bridge works, and its output is something the seam actually accepts -----------------
{
  const r = call(verdictBy('granted'));
  assert.equal(r.ok, true, `expected ok, got ${r.reason}`);
  assert.equal(r.record.grantee, joiner.agentId, 'the grantee is the key that signed the bind');
  assert.equal(r.record.decision, 'grant', 'granted maps to grant');
  assert.equal(r.record.via, 'relay', 'provenance is recorded, not inferred');
  ok('a trusted operator + a signed bind yields a grant for the binding key');

  // The point of the whole file: the record must be consumable by the consumer.
  const consumed = granteeFromAdmission(r.record);
  assert.equal(consumed.ok, true, `the seam refused its own bridge output: ${consumed.reason}`);
  assert.equal(consumed.grantee, joiner.agentId);
  ok('★ and the permit seam accepts that record unchanged');
}

// --- 2. a relay REFUSAL must not become a permit ------------------------------------------------
{
  const r = call(verdictBy('refused'));
  assert.equal(r.ok, true, 'a refusal is still a decided verdict');
  assert.equal(r.record.decision, 'refuse');
  const consumed = granteeFromAdmission(r.record);
  assert.equal(consumed.ok, false, 'a refused verdict must NEVER grant');
  assert.equal(consumed.reason, 'not_granted');
  ok('★ a relay refusal bridges to a record the seam still refuses');
}

// --- 3. THE GRANTEE IS PROVEN, NOT RECEIVED -----------------------------------------------------
//
// The relay is third-party infrastructure. If it could name the grantee, whoever runs it could hand
// authority to any key. It cannot: the grantee must be the key that signed the bind.
{
  // The relay swaps in a different key but keeps the original signature.
  const spoofed = { ...goodBind, agentId: victim.agentId };
  const r = call(verdictBy('granted'), spoofed);
  assert.equal(r.ok, false, 'a substituted grantee must be refused');
  assert.equal(r.reason, 'bind_bad_signature');
  ok('★ a relay that substitutes the grantee is refused, not obeyed');

  // ...and re-signing as the attacker does not help: then the bind is theirs, so the grant is theirs
  // and NOT the victim's. Stated as an assertion so the property is pinned rather than assumed.
  const attackerBind = {
    requestId,
    agentId: victim.agentId,
    sig: sign(stranger, relayBindBytes({ requestId, agentId: victim.agentId })),
  };
  assert.equal(call(verdictBy('granted'), attackerBind).reason, 'bind_bad_signature',
    'a bind signed by anyone other than the key it names is refused');
  ok('★ and a third party cannot bind someone else\'s key to a request');
}

// --- 4. THE OPERATOR MUST ALREADY BE TRUSTED HERE -----------------------------------------------
{
  assert.equal(call(verdictBy('granted'), goodBind, []).reason, 'operator_not_trusted',
    'with no trusted operators, nothing is trusted');
  assert.equal(call(verdictBy('granted'), goodBind, [stranger.agentId]).reason, 'operator_not_trusted',
    'a verdict signed by an untrusted key is refused even though its signature is perfectly valid');
  ok('★ an untrusted operator is refused even when the signature verifies');

  // A trusted operator is NAMED but a stranger signs. The trust lookup passes (the claim says
  // operator), so only the signature check stands between this and a grant. Note the arm above would
  // also be satisfied by this code path, so this one has to name the trusted key to isolate it.
  const forgedClaim = { requestId, decision: 'granted', by: operator.agentId };
  const forged = { ...forgedClaim, sig: sign(stranger, Buffer.from(canonicalize(forgedClaim), 'utf8')) };
  assert.equal(call(forged).reason, 'verdict_bad_signature',
    'claiming a trusted operator is not the same as being one');
  ok('★ naming a trusted operator does not make you one');
}

// --- 5. the decision vocabulary is CLOSED -------------------------------------------------------
//
// The relay says granted/refused; this store says grant/refuse. A mapping that guessed, or that
// defaulted to granted, would admit an unexamined agent on a typo.
{
  for (const d of ['maybe', 'GRANTED', 'Granted', 'grant', '', undefined, null, 0, 'true']) {
    const r = call(verdictBy(d));
    assert.equal(r.ok, false, `decision ${JSON.stringify(d)} must not bridge`);
    assert.equal(r.reason, 'unknown_decision', `decision ${JSON.stringify(d)} gave ${r.reason}`);
  }
  ok('★ every unrecognised decision refuses — including ones that look like a grant');
}

// --- 6. domain separation still holds at this seam ----------------------------------------------
//
// The bind may only be signed over the RELAY domain. A local-domain signature over the same agent
// must not satisfy it, or the two flows would be interchangeable and one requestId could be replayed
// as the other.
{
  const localSig = sign(joiner, bindBytes({ id: requestId, agentId: joiner.agentId }));
  const crossed = { requestId, agentId: joiner.agentId, sig: localSig };
  assert.equal(call(verdictBy('granted'), crossed).reason, 'bind_bad_signature',
    'a LOCAL-domain bind signature must not satisfy the relay seam');
  ok('★ a local-domain signature does not verify as a relay bind');

  // The positive control for the arm above: the relay-domain signature does verify. Without this,
  // "crossed fails" would also be satisfied by a seam that refuses every bind.
  assert.equal(call(verdictBy('granted'), goodBind).ok, true,
    'the relay-domain bind must still work');
  ok('★ and the correct domain still works, so the arm above discriminates');
}

// --- 7. requests must MATCH ---------------------------------------------------------------------
{
  const otherBind = {
    requestId: 'req-someone-else',
    agentId: joiner.agentId,
    sig: sign(joiner, relayBindBytes({ requestId: 'req-someone-else', agentId: joiner.agentId })),
  };
  assert.equal(call(verdictBy('granted'), otherBind).reason, 'bind_request_mismatch',
    'a verdict for one request must not authorise a different request');
  ok('★ a bind for another request is refused');
}

// --- 8. every partial state refuses -------------------------------------------------------------
{
  assert.equal(call(null).reason, 'no_verdict');
  assert.equal(call({}).reason, 'no_request_id');
  assert.equal(call({ requestId }).reason, 'no_operator');
  assert.equal(call({ requestId, by: operator.agentId }).reason, 'unsigned_verdict');
  assert.equal(call(verdictBy('granted'), null).reason, 'no_bind');
  assert.equal(call(verdictBy('granted'), { requestId, agentId: joiner.agentId }).reason, 'unsigned_bind');
  assert.equal(call(verdictBy('granted'), { requestId, sig: 'x' }).reason, 'bind_no_agent');
  assert.equal(call(verdictBy('granted'), { requestId, agentId: 'not-a-key', sig: 'x' }).reason, 'bind_no_agent');
  ok('★ every partial state refuses rather than resolving to somebody');

  // The positive control again: at least one input in this battery must still succeed, or the whole
  // battery would be satisfied by a function that returns a refusal for everything.
  assert.equal(call(verdictBy('granted')).ok, true);
  ok('★ and the well-formed input still succeeds, so this battery discriminates');
}

// --- 9. the record id is derived from the request, not carried ----------------------------------
{
  const a = call(verdictBy('granted'));
  const b = call(verdictBy('granted'));
  assert.equal(a.record.id, b.record.id, 'the same request yields the same record id');
  assert.equal(a.record.id, `relay:${requestId}`);
  assert.equal(a.record.id.includes(joiner.agentId), false,
    'the id must not embed the key, so it cannot be mistaken for one');
  ok('★ the bridged record id is derived from the request and is stable');
}

console.log(`permit-verdict-bridge: ${n} groups OK`);
