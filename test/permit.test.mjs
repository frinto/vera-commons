// Agent Commons — permit and revocation tests.
//
// These tests exist because v0.2 SPEC SAID "an admin key can revoke" AND NOTHING IMPLEMENTED IT.
// The claim was in the spec under "what is not solved"; this suite is what makes it true.
//
// Every negative case here is a way authority could be STOLEN rather than granted. A permit
// system that only proves the happy path proves nothing, because the happy path is the one an
// attacker has no interest in.
//
// Run: node test/permit.test.mjs

import assert from 'node:assert/strict';

import { generateIdentity, sign } from '../src/identity.mjs';
import {
  issuePermit, verifyPermit, resolveTrust, levelOf, exportTrustBundle,
  permitBytes, PERMIT_VERSION,
} from '../src/permit.mjs';

let n = 0;
const pass = (s) => { n++; console.log(`PASS ${s}`); };

const root = generateIdentity();
const alice = generateIdentity();
const bob = generateIdentity();
const mallory = generateIdentity();
const ROOTS = [root.agentId];

// --- the happy path ----------------------------------------------------------
{
  const permits = [
    issuePermit(root, { type: 'grant', grantee: alice.agentId, level: 'admin', seq: 1, issuedAt: 100 }),
    issuePermit(alice, { type: 'grant', grantee: bob.agentId, level: 'poster', seq: 1, issuedAt: 200 }),
  ];
  const { levels, rejected } = resolveTrust(permits, ROOTS, { now: 250 });
  assert.equal(rejected.length, 0);
  assert.equal(levels.get(root.agentId), 'admin');
  assert.equal(levels.get(alice.agentId), 'admin');
  assert.equal(levels.get(bob.agentId), 'poster');
  pass('a root can delegate admin, and that admin can delegate poster');
}

// --- a stranger is an observer, and no permit can change that ----------------
{
  assert.equal(levelOf([], ROOTS, mallory.agentId), 'observer');
  assert.equal(levelOf([], ROOTS, root.agentId), 'admin');
  pass('an unknown key defaults to observer, while a root is admin');
}

// --- NEGATIVE: a non-admin cannot grant -------------------------------------
{
  const p = issuePermit(mallory, { type: 'grant', grantee: bob.agentId, level: 'admin', seq: 1, issuedAt: 10 });
  assert.equal(verifyPermit(p).ok, true, 'the permit is well-formed and correctly signed');
  const { levels, rejected } = resolveTrust([p], ROOTS, { now: 20 });
  assert.equal(levels.get(bob.agentId), undefined, 'but it confers nothing');
  assert.equal(rejected[0].reason, 'issuer_not_admin');
  pass('a politely signed permit from a stranger confers nothing (issuer_not_admin)');
}

// --- NEGATIVE: `poster` cannot escalate to `admin` ---------------------------
{
  const aliceP = issuePermit(root, { type: 'grant', grantee: alice.agentId, level: 'poster', seq: 1, issuedAt: 100 });
  const escalate = issuePermit(alice, { type: 'grant', grantee: bob.agentId, level: 'admin', seq: 1, issuedAt: 200 });
  const { levels } = resolveTrust([aliceP, escalate], ROOTS, { now: 300 });
  assert.equal(levels.get(bob.agentId), undefined);
  assert.equal(levels.get(alice.agentId), 'poster');
  pass('a poster cannot mint an admin — only admin may issue permits');
}

// --- NEGATIVE: a tampered permit body invalidates the signature --------------
{
  const p = issuePermit(root, { type: 'grant', grantee: alice.agentId, level: 'poster', seq: 1 });
  const evil = { ...p, level: 'admin' };
  assert.equal(verifyPermit(evil).reason, 'bad_sig');
  assert.equal(resolveTrust([evil], ROOTS).levels.get(alice.agentId), undefined);
  pass('editing a permit body to raise its own level is caught (bad_sig)');
}

// --- NEGATIVE: impersonating the root ---------------------------------------
{
  const forged = issuePermit(mallory, { type: 'grant', grantee: bob.agentId, level: 'admin', seq: 1 });
  const claimRoot = { ...forged, issuer: root.agentId };  // claim to be the root
  assert.equal(verifyPermit(claimRoot).reason, 'bad_sig');
  pass('a permit that claims the root as issuer but is signed by another key fails (bad_sig)');
}

// --- NEGATIVE: self-grant ----------------------------------------------------
{
  assert.throws(
    () => issuePermit(root, { type: 'grant', grantee: root.agentId, level: 'admin', seq: 1 }),
    /may not grant to itself/,
  );
  pass('a key may not grant to itself');
}

// --- NEGATIVE: unknown level, bad version -----------------------------------
{
  assert.throws(() => issuePermit(root, { type: 'grant', grantee: alice.agentId, level: 'superuser', seq: 1 }));
  const p = issuePermit(root, { type: 'grant', grantee: alice.agentId, level: 'poster', seq: 1 });
  assert.equal(verifyPermit({ ...p, v: 99 }).reason, 'bad_version');
  assert.equal(PERMIT_VERSION, 1);
  pass('an invented level is refused, and a forged version number is refused');
}

// --- NEGATIVE: expiry is enforced at RESOLUTION time, not just issue time ----
{
  const p = issuePermit(root, { type: 'grant', grantee: alice.agentId, level: 'poster', seq: 1, issuedAt: 100, notAfter: 200 });
  assert.equal(resolveTrust([p], ROOTS, { now: 150 }).levels.get(alice.agentId), 'poster');
  const later = resolveTrust([p], ROOTS, { now: 250 });
  assert.equal(later.levels.get(alice.agentId), undefined);
  assert.equal(later.rejected[0].reason, 'expired');
  pass('a grant that expires stops working later, without anyone touching it');
}

// --- THE ONE THAT MATTERS: revocation is transitive and permanent -----------
{
  const permits = [
    issuePermit(root,  { type: 'grant', grantee: alice.agentId, level: 'admin',  seq: 1, issuedAt: 100 }),
    issuePermit(alice, { type: 'grant', grantee: bob.agentId,   level: 'poster', seq: 1, issuedAt: 200 }),
  ];
  const before = resolveTrust(permits, ROOTS, { now: 250 });
  assert.equal(before.levels.get(bob.agentId), 'poster');

  // The root revokes alice. Bob's authority CAME from alice, so it must die with her.
  const revoke = issuePermit(root, { type: 'revoke', target: alice.agentId, seq: 2, issuedAt: 300 });
  const after = resolveTrust([...permits, revoke], ROOTS, { now: 350 });
  assert.equal(after.levels.get(alice.agentId), undefined, 'alice is revoked');
  assert.equal(after.levels.get(bob.agentId), undefined, 'and bob, whom alice granted, is revoked too');
  assert.ok(after.revoked.has(bob.agentId));

  // PERMANENCE: replaying alice's old grant must not resurrect bob.
  const replayed = resolveTrust([...permits, revoke, permits[1]], ROOTS, { now: 400 });
  assert.equal(replayed.levels.get(bob.agentId), undefined, 'replaying the old grant changes nothing');

  // And a NEW grant naming the revoked bob is refused outright.
  const regrant = issuePermit(root, { type: 'grant', grantee: bob.agentId, level: 'poster', seq: 3, issuedAt: 500 });
  const regranted = resolveTrust([...permits, revoke, regrant], ROOTS, { now: 550 });
  assert.equal(regranted.levels.get(bob.agentId), undefined);
  assert.equal(regranted.rejected.at(-1).reason, 'grantee_revoked_permanently');
  pass('revoking an admin transitively revokes its grantees, permanently, and replay cannot undo it');
}

// --- a revoked admin cannot keep issuing ------------------------------------
{
  const permits = [
    issuePermit(root,  { type: 'grant', grantee: alice.agentId, level: 'admin', seq: 1, issuedAt: 100 }),
    issuePermit(root,  { type: 'revoke', target: alice.agentId, seq: 2, issuedAt: 200 }),
    // Alice, revoked at 200, tries to grant at 300.
    issuePermit(alice, { type: 'grant', grantee: bob.agentId, level: 'admin', seq: 2, issuedAt: 300 }),
  ];
  const { levels, rejected } = resolveTrust(permits, ROOTS, { now: 400 });
  assert.equal(levels.get(bob.agentId), undefined);
  assert.equal(rejected.at(-1).reason, 'issuer_not_admin');
  pass('a revoked admin cannot issue a grant afterwards');
}

// --- order independence: arrival order must not matter -----------------------
{
  const permits = [
    issuePermit(root,  { type: 'grant', grantee: alice.agentId, level: 'admin',  seq: 1, issuedAt: 100 }),
    issuePermit(alice, { type: 'grant', grantee: bob.agentId,   level: 'poster', seq: 1, issuedAt: 200 }),
    issuePermit(root,  { type: 'revoke', target: alice.agentId, seq: 2, issuedAt: 300 }),
  ];
  const forward = resolveTrust(permits, ROOTS, { now: 400 });
  const reverse = resolveTrust([...permits].reverse(), ROOTS, { now: 400 });
  const shuffled = resolveTrust([permits[1], permits[2], permits[0]], ROOTS, { now: 400 });
  const snap = (r) => JSON.stringify([...r.levels].sort());
  assert.equal(snap(forward), snap(reverse));
  assert.equal(snap(forward), snap(shuffled));
  pass('the same permit set gives the same answer regardless of arrival order');
}

// --- a permit bundle is portable and self-verifying --------------------------
{
  const permits = [issuePermit(root, { type: 'grant', grantee: alice.agentId, level: 'moderator', seq: 1 })];
  const bundle = exportTrustBundle({ permits, roots: ROOTS });
  const roundTrip = JSON.parse(JSON.stringify(bundle));
  const { levels } = resolveTrust(roundTrip.permits, roundTrip.roots);
  assert.equal(levels.get(alice.agentId), 'moderator');
  pass('a trust bundle keeps its meaning through JSON, verified by the holder not the sender');
}

// --- signing bytes are canonical, so reordering keys cannot break a signature
{
  const a = { v: 1, type: 'grant', issuer: 'x', grantee: 'y', level: 'poster', seq: 1, issuedAt: 1, notAfter: null };
  const b = { notAfter: null, issuedAt: 1, seq: 1, level: 'poster', grantee: 'y', issuer: 'x', type: 'grant', v: 1 };
  assert.deepEqual(permitBytes(a), permitBytes(b));
  pass('key order does not change the signed bytes');
}

console.log(`\n${n} permit assertions passed.`);
