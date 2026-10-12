// The admission -> permit seam, as a unit. The live probe (tools/permit-seam-probe.mjs) proves the
// route works on a running server; this pins the RULE so a future edit cannot quietly widen it.
//
// The rule matters because a permit is what lets a stranger speak. Every partial state below is a
// state in which somebody has NOT been admitted, and each must refuse rather than fall through.
import assert from 'node:assert/strict';
import { granteeFromAdmission, liveGrantFor, nextSeqFor } from '../src/permit-admission.mjs';

const KEY = 'qet0hHfBk5' + 'x'.repeat(33);

assert.equal(granteeFromAdmission(null).reason, 'unknown_admission', 'a missing record authorises nobody');
assert.equal(granteeFromAdmission(undefined).reason, 'unknown_admission');
assert.equal(granteeFromAdmission({ status: 'pending' }).reason, 'not_decided', 'a pending challenge is not an admission');
assert.equal(granteeFromAdmission({ status: 'answered' }).reason, 'not_decided', 'passing the test is not being admitted');

// The one that would invert a decision: a refusal is "decided" too.
assert.equal(granteeFromAdmission({ status: 'decided', decision: 'refuse' }).reason, 'not_granted',
  'a refused admission must never yield a permit');

assert.equal(granteeFromAdmission({ status: 'decided', decision: 'grant' }).reason, 'no_grantee',
  'a grant with no key recorded grants nothing');

assert.deepEqual(granteeFromAdmission({ status: 'decided', decision: 'grant', grantee: KEY, agentId: KEY }),
  { ok: true, grantee: KEY });

// Corruption or tampering, not a preference to be resolved by picking one of the two.
assert.equal(
  granteeFromAdmission({ status: 'decided', decision: 'grant', grantee: KEY, agentId: 'Z'.repeat(43) }).reason,
  'grantee_key_mismatch',
  'a grantee that disagrees with the bound key is refused, never silently resolved');

// A legacy record with no agentId still resolves: rejecting it would revoke admissions that were
// legitimately made before binding was recorded.
assert.equal(granteeFromAdmission({ status: 'decided', decision: 'grant', grantee: KEY }).ok, true);

// --- what counts as a permit someone already holds ------------------------------------------
const grant = { type: 'grant', grantee: KEY, level: 'poster', issuer: 'ADMIN', seq: 1 };
assert.equal(liveGrantFor([grant], KEY)?.level, 'poster');
assert.equal(liveGrantFor([], KEY), null, 'no permits means no permit');
assert.equal(liveGrantFor([grant], 'Z'.repeat(43)), null, 'a grant for someone else is not this key\'s permit');

// Revocation is transitive and permanent, so a revoked grant is NOT held. Getting this backwards
// would let the console re-issue a permit that a revocation was meant to end.
assert.equal(liveGrantFor([grant, { type: 'revoke', target: KEY, issuer: 'ADMIN', seq: 2 }], KEY), null,
  'a revoked grant stops counting as held');

// The revocation must name THIS key. A revoke aimed elsewhere must not suppress this grant.
assert.equal(liveGrantFor([grant, { type: 'revoke', target: 'Z'.repeat(43), issuer: 'ADMIN', seq: 2 }], KEY)?.level,
  'poster', 'a revocation of another key does not revoke this one');

// --- sequencing ------------------------------------------------------------------------------
assert.equal(nextSeqFor([], 'ADMIN'), 1, 'the first permit is seq 1');
assert.equal(nextSeqFor([grant, { seq: 7, issuer: 'ADMIN' }], 'ADMIN'), 8, 'seq continues from the issuer\'s own history');
assert.equal(nextSeqFor([{ seq: 9, issuer: 'SOMEONE-ELSE' }], 'ADMIN'), 1,
  'another issuer\'s seq does not advance mine — the counters are per issuer');

console.log('permit-admission: OK');
