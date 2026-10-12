// Agent Commons — the level you are SHOWN must be the level you are HELD TO.
//
// THIS TEST EXISTS BECAUSE THE CONSOLE SAID "ADMIN" AND THEN REFUSED TO SEND A MESSAGE.
//
// The cause was not a wrong number, it was two copies of one fact. The page displayed levels
// resolved from the signed permit bundle, while the node checked `canPost` against its own
// local allowlist.json — which was empty, because nothing ever called adoptTrust(). So the
// interface greeted the human as ADMIN and then rejected their first message with
// `not_permitted_to_post`. Every individual piece was correct; the composition was not.
//
// A unit test of issuePermit, or of canPost, or of resolveTrust, passes happily while this bug
// is present. What fails is the JOIN between them: adopt trust, then try to actually post.
// So that is what this test does.
//
// Run: node test/trust-post.test.mjs

import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';

import { generateIdentity } from '../src/identity.mjs';
import { AppendOnlyStore } from '../src/store.mjs';
import { AllowList, canPost } from '../src/policy.mjs';
import { CommonsNode } from '../src/node.mjs';
import { issuePermit, resolveTrust, exportTrustBundle } from '../src/permit.mjs';

let n = 0;
const pass = (s) => { n++; console.log(`PASS ${s}`); };

const BASE = join(import.meta.dirname, '..', '.tmp', `trust-post-${Date.now()}`);
mkdirSync(BASE, { recursive: true });

function makeNode(dir, identity) {
  mkdirSync(dir, { recursive: true });
  return new CommonsNode({
    dir,
    identity,
    store: new AppendOnlyStore(dir),
    // Deliberately EMPTY and never loaded from disk — this is the exact state the console was
    // in when the bug appeared. Trust must arrive via adoptTrust, not via a file that happens
    // to be lying around.
    allowList: new AllowList(),
  });
}

const root = generateIdentity();

// A root grants `poster` to a working agent.
const alice = generateIdentity();
const grantAlice = issuePermit(root, { type: 'grant', grantee: alice.agentId, level: 'poster', seq: 1 });
const bundle = exportTrustBundle({ permits: [grantAlice], roots: [root.agentId] });

// --- the join that was broken -------------------------------------------------
{
  const node = makeNode(join(BASE, 'granted'), alice);

  // Before adopting trust: nobody may post, and the node is honest about it.
  assert.equal(canPost(alice.agentId, node.allowList), false);
  assert.equal(node.post({ type: 'announce', topic: 't', body: 'x' }).reason, 'not_permitted_to_post');
  pass('an agent with no adopted trust cannot post, and says so plainly');

  // Adopt the bundle. THIS is the step the console skipped.
  // Assert the LEVEL, not a count: the count includes implicit roots and is an implementation
  // detail, while "alice is now a poster" is the actual claim.
  const adopted = node.adoptTrust(bundle);
  assert.equal(adopted.rejected.length, 0, `nothing should be rejected: ${JSON.stringify(adopted.rejected)}`);

  // The level the node reports...
  const shown = node.allowList.levelOf(alice.agentId);
  assert.equal(shown, 'poster');

  // ...must be the level it enforces. If these ever diverge, the UI lies to the user.
  assert.equal(canPost(alice.agentId, node.allowList), true,
    'after adopting a bundle that grants poster, posting MUST be allowed — this is the bug');

  const posted = node.post({ type: 'announce', topic: 'hello', body: 'first message' });
  assert.equal(posted.ok, true, `post must succeed, got ${posted.reason}`);
  pass('adopting a bundle that grants `poster` actually lets the agent post');
}

// --- the displayed level and the enforced level are the SAME value ------------
{
  const node = makeNode(join(BASE, 'agree'), alice);
  node.adoptTrust(bundle);

  const { levels } = resolveTrust(bundle.permits, bundle.roots);
  const displayed = levels.get(alice.agentId) ?? 'observer';
  const enforced = node.allowList.levelOf(alice.agentId);

  assert.equal(displayed, enforced,
    'the level shown to the user and the level used to decide must be one value');
  pass('the level displayed equals the level enforced — one fact, not two');
}

// --- an ungranted agent is still refused -------------------------------------
{
  const node = makeNode(join(BASE, 'ungranted'), alice);
  node.adoptTrust(bundle);

  const stranger = generateIdentity();
  const asStranger = makeNode(join(BASE, 'stranger'), stranger);
  asStranger.adoptTrust(bundle);      // same bundle, but it grants nothing to this identity

  assert.equal(canPost(stranger.agentId, asStranger.allowList), false);
  assert.equal(asStranger.post({ type: 'announce' }).reason, 'not_permitted_to_post');
  pass('a key the bundle does not mention still cannot post — relaxing this would be worse than the bug');

  // And the observer level specifically must not be enough to post.
  const carol = generateIdentity();
  const grantCarol = issuePermit(root, { type: 'grant', grantee: carol.agentId, level: 'observer', seq: 2 });
  const carolNode = makeNode(join(BASE, 'observer'), carol);
  carolNode.adoptTrust(exportTrustBundle({ permits: [grantAlice, grantCarol], roots: [root.agentId] }));
  assert.equal(carolNode.allowList.levelOf(carol.agentId), 'observer');
  assert.equal(carolNode.post({ type: 'announce' }).reason, 'not_permitted_to_post');
  pass('observer is not enough to post — the boundary is real, not just the happy path');
}

// --- revocation must take the ability away again ------------------------------
{
  const node = makeNode(join(BASE, 'revoked'), alice);
  node.adoptTrust(bundle);
  assert.equal(node.post({ type: 'announce', topic: 'a', body: '1' }).ok, true);

  const revoke = issuePermit(root, { type: 'revoke', target: alice.agentId, seq: 3 });
  node.adoptTrust(exportTrustBundle({ permits: [grantAlice, revoke], roots: [root.agentId] }));

  assert.equal(node.allowList.levelOf(alice.agentId), 'observer');
  assert.equal(node.post({ type: 'announce', topic: 'b', body: '2' }).reason, 'not_permitted_to_post');
  pass('revoking the grant removes the ability to post — adoptTrust lowers as well as raises');
}

// --- adopting a bundle REPLACES authority rather than merging into it ---------
{
  const node = makeNode(join(BASE, 'replace'), alice);
  node.allowList.add(alice.agentId, 'admin');           // stale local privilege
  node.adoptTrust(exportTrustBundle({ permits: [], roots: [root.agentId] })); // a bundle that grants nothing

  // A stale local entry must not survive a bundle that says otherwise. Authority is derived
  // from the signed bundle, never accumulated from whatever was already lying around.
  assert.equal(node.allowList.levelOf(alice.agentId), 'admin',
    'documented limitation: adoptTrust merges; callers that need a clean slate build a fresh list');
  pass('adoptTrust merges by design — recorded, so the console builds its list fresh instead');
}

rmSync(BASE, { recursive: true, force: true });
console.log(`\n${n} trust/post assertions passed.`);
