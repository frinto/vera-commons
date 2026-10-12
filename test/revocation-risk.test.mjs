// What a revocation would DO, computed before the signature exists.
//
// WHY THIS TEST EXISTS: revocation is the only irreversible act in the commons, and it was the only
// one with no pre-flight check. Two failures were live and both silent — revoking a ROOT deletes the
// last admin and drags every key it granted down with it (permanently, with a log that still looks
// well-formed afterwards), and revoking a mistyped key writes a revocation that permanently bars a
// key nobody ever examined while the agent the admin meant to remove keeps posting.
//
// This file tests the REPORT, not the refusal. The refusal lives in the console route and is proven
// against a running console in tools/permit-seam-probe.mjs; a unit test of a function that is never
// wired would pass forever while the console stayed dangerous.

import assert from 'node:assert/strict';
import { generateIdentity } from '../src/identity.mjs';
import { issuePermit, resolveTrust, revocationRisk } from '../src/permit.mjs';

let n = 0;
function ok(name) { n++; console.log(`PASS ${name}`); }

const root = generateIdentity();
const root2 = generateIdentity();
const alice = generateIdentity();
const bob = generateIdentity();
const carol = generateIdentity();

// root -> alice(admin) -> bob(poster). So revoking alice must take bob with it.
//
// `issuedAt` is set EXPLICITLY here rather than left to Date.now(). Two permits issued in the same
// millisecond tie on (issuedAt, seq) and are then ordered by `issuer.localeCompare` — i.e. by the
// random key — so a chain grant could be applied before its own parent and rejected as
// `issuer_not_admin`. This test failed exactly that way once, after passing for a whole round: it
// was green by luck, not by construction. Wall-clock ordering does not belong in a fixture whose
// subject is authority resolution.
const permits = [
  issuePermit(root, { type: 'grant', grantee: alice.agentId, level: 'admin', seq: 1, issuedAt: 1_000 }),
  issuePermit(alice, { type: 'grant', grantee: bob.agentId, level: 'poster', seq: 1, issuedAt: 2_000 }),
];
const roots = [root.agentId];

// --- 1. the ordinary case -----------------------------------------------------------------
{
  const r = revocationRisk(permits, roots, alice.agentId);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'ok', 'a live permit holder is an ordinary revocation');
  assert.equal(r.heldNow, 'admin');
  assert.equal(r.isRoot, false);
  assert.equal(r.alreadyRevoked, false);
  ok('a key that holds a permit is reported as an ordinary revocation');
}

// --- 2. THE BLAST RADIUS — revoking a parent takes its children -----------------------------
{
  const r = revocationRisk(permits, roots, alice.agentId);
  assert.deepEqual([...r.falls].sort(), [alice.agentId, bob.agentId].sort(),
    'revoking alice must report bob as falling too');
  assert.equal(r.fallCount, 2);
  assert.equal(r.falls.includes(alice.agentId), true, 'the target itself falls');
  ok('★ the blast radius includes everything the target granted, transitively');
}

// --- 3. ★ REVOKING A ROOT BRICKS THE COMMONS -------------------------------------------------
{
  const r = revocationRisk(permits, roots, root.agentId);
  assert.equal(r.isRoot, true);
  assert.equal(r.reason, 'target_is_root');
  assert.equal(r.orphansCommons, true, 'the only admin is being removed');
  assert.deepEqual(r.adminsAfter, [], 'no admin would remain');
  assert.equal(r.fallCount, 3, 'root, alice and bob all fall');
  ok('★ revoking the only root is reported as orphaning the commons');

  // And the report agrees with what resolveTrust would actually do — a risk report that disagreed
  // with the resolver would be worse than none, because it would be believed.
  const applied = resolveTrust(
    [...permits, issuePermit(root, { type: 'revoke', target: root.agentId, seq: 2, issuedAt: 3_000 })],
    roots,
  );
  assert.equal([...applied.levels].some(([, l]) => l === 'admin'), false,
    'the resolver must actually leave no admin, or the report above is fiction');
  assert.equal(applied.revoked.has(bob.agentId), true, 'bob falls in the real resolution too');
  ok('★ the report matches what the resolver actually does');
}

// --- 4. two roots: revoking one does NOT orphan the commons ----------------------------------
{
  const r = revocationRisk(permits, [root.agentId, root2.agentId], root.agentId);
  assert.equal(r.isRoot, true, 'it is still a root');
  assert.equal(r.orphansCommons, false, 'one admin survives, so the commons is not orphaned');
  assert.deepEqual(r.adminsAfter, [root2.agentId]);
  ok('revoking one of two roots is reported as survivable, not as orphaned');
}

// --- 5. ★ A TYPO IS NOT A REVOCATION --------------------------------------------------------
{
  const r = revocationRisk(permits, roots, carol.agentId);
  assert.equal(r.reason, 'target_holds_no_permit',
    'a key that holds nothing must not be silently revocable');
  assert.equal(r.heldNow, null);
  assert.equal(r.fallCount, 1, 'only the typo key itself "falls" — nothing was removed');
  ok('★ a key holding no permit is flagged, not silently accepted');

  // The harm this prevents, stated as a fact rather than a worry: a revocation of a never-granted
  // key permanently bars that key from being granted later.
  const after = resolveTrust(
    [...permits, issuePermit(root, { type: 'revoke', target: carol.agentId, seq: 2, issuedAt: 3_000 }),
      issuePermit(root, { type: 'grant', grantee: carol.agentId, level: 'poster', seq: 3, issuedAt: 4_000 })],
    roots,
  );
  assert.equal(after.levels.has(carol.agentId), false,
    'a later grant to a revoked key is refused — this is why the typo matters');
  assert.equal(after.rejected.some((x) => x.reason === 'grantee_revoked_permanently'), true);
  ok('★ and the permanent pre-ban it would cause is real, not hypothetical');
}

// --- 6. an already-revoked key is not revoked twice -----------------------------------------
{
  const applied = [...permits, issuePermit(root, { type: 'revoke', target: alice.agentId, seq: 2, issuedAt: 3_000 })];
  const r = revocationRisk(applied, roots, alice.agentId);
  assert.equal(r.alreadyRevoked, true);
  assert.equal(r.reason, 'already_revoked');
  ok('revoking an already-revoked key is reported as such');
}

// --- 7. no target at all ---------------------------------------------------------------------
{
  assert.equal(revocationRisk(permits, roots, '').reason, 'no_target');
  assert.equal(revocationRisk(permits, roots, null).ok, false);
  ok('an empty target is refused rather than treated as a key');
}

// --- 8. the report DISCRIMINATES -----------------------------------------------------------------
//
// Guard against the failure mode where every answer is the same one: three different keys must
// produce three different reasons, and a no-root trust file must not claim anyone is a root.
{
  const reasons = new Set([
    revocationRisk(permits, roots, alice.agentId).reason,
    revocationRisk(permits, roots, root.agentId).reason,
    revocationRisk(permits, roots, carol.agentId).reason,
  ]);
  assert.equal(reasons.size, 3, `the report must distinguish cases, got ${[...reasons].join(', ')}`);
  const noRoots = revocationRisk(permits, [], alice.agentId);
  assert.equal(noRoots.orphansCommons, false, 'with no roots there is no authority to orphan');
  ok('the report distinguishes holder / root / unknown rather than answering one way');
}

// --- 9. ★ A CHAIN GRANT MUST NOT DEPEND ON WHICH KEY SORTS FIRST ------------------------------
//
// Two permits sharing a millisecond tie on (issuedAt, seq) are then ordered by comparing the issuer
// KEY, so whether a child grant is applied before its own parent depended on the random public key.
// A single-pass resolver refused the child as `issuer_not_admin` and the authority vanished with no
// trace. Run enough random key pairs that BOTH orderings actually occur, and require the same answer
// every time — otherwise this test could pass by never exercising the failing case at all.
{
  const ROUNDS = 12;
  let childSortsFirst = 0;
  for (let k = 0; k < ROUNDS; k++) {
    const r = generateIdentity(), a = generateIdentity(), b = generateIdentity();
    const childFirst = a.agentId.localeCompare(r.agentId) < 0;
    if (childFirst) childSortsFirst++;
    const ps = [
      issuePermit(r, { type: 'grant', grantee: a.agentId, level: 'admin', seq: 1, issuedAt: 5_000 }),
      issuePermit(a, { type: 'grant', grantee: b.agentId, level: 'poster', seq: 1, issuedAt: 5_000 }),
    ];
    const out = resolveTrust(ps, [r.agentId]);
    assert.equal(out.levels.get(b.agentId), 'poster',
      `round ${k}: the child grant was LOST (child issuer sorts ${childFirst ? 'FIRST' : 'second'})`);
    assert.deepEqual(out.rejected, [], `round ${k}: nothing should be rejected`);
  }
  // The self-check that stops this group from going vacuous: if every random pair happened to sort
  // the same way, the failing case was never exercised and the pass would mean nothing.
  assert.ok(childSortsFirst > 0 && childSortsFirst < ROUNDS,
    `the sample must contain BOTH orderings to be a real test (child-first in ${childSortsFirst}/${ROUNDS})`);
  ok(`★ a chain grant resolves identically whichever way the keys sort (${childSortsFirst}/${ROUNDS} child-first)`);
}

// --- 10. the retry pass must not let a grant overtake a revocation ----------------------------
//
// The retry pass exists to recover authority, and the way it could go wrong is by resurrecting a key
// a revocation already killed. Ordering alone must still decide this.
{
  const r = generateIdentity(), a = generateIdentity(), b = generateIdentity();
  const ps = [
    issuePermit(r, { type: 'grant', grantee: a.agentId, level: 'admin', seq: 1, issuedAt: 1_000 }),
    issuePermit(a, { type: 'grant', grantee: b.agentId, level: 'poster', seq: 1, issuedAt: 2_000 }),
    issuePermit(r, { type: 'revoke', target: a.agentId, seq: 2, issuedAt: 3_000 }),
  ];
  const out = resolveTrust(ps, [r.agentId]);
  assert.equal(out.levels.has(a.agentId), false, 'the revoked key must not keep a level');
  assert.equal(out.levels.has(b.agentId), false, 'and neither may the key it granted');
  assert.equal(out.revoked.has(b.agentId), true, 'the retry pass must not resurrect it');
  ok('★ the retry pass does not let a grant overtake a revocation');
}

console.log(`revocation-risk: ${n} groups OK`);
