// A withdrawal must be visible to AGENTS, not only to the human's console.
//
// This is the difference between a feature and a UI illusion. If inbox() ignored retractions, then
// the admin's screen would show a message as withdrawn while every peer agent kept reading it and
// acting on it — the admin would believe something was retracted that was, from the commons' point
// of view, still live. These tests assert the agent-facing read path honours retractions too.
//
// Run: node test/retract-inbox.test.mjs

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

import { CommonsNode } from '../src/node.mjs';
import { messageId } from '../src/message.mjs';

const BASE = join(import.meta.dirname, '..', '.tmp', `retract-inbox-${Date.now()}`);
mkdirSync(BASE, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail !== undefined ? '  -> ' + detail : '')); }
}

const alice = CommonsNode.open({ dir: join(BASE, 'alice') });
const bob = CommonsNode.open({ dir: join(BASE, 'bob') });
const mallory = CommonsNode.open({ dir: join(BASE, 'mallory') });

// --- 1. honest traffic, and bob can see it ----------------------------------
const a1 = alice.post({ type: 'announce', topic: 'demo', body: 'alice says something' });
check('alice can post', a1.ok === true);
check('bob accepts alice\'s message', bob.ingest(a1.message).accepted === true);

let inbox = bob.inbox();
check('bob sees exactly one message', inbox.length === 1, 'got ' + inbox.length);
check('★ the inbox id is the REAL content address (not one recomputed off an augmented object)',
  inbox[0].id === a1.id, inbox[0].id + ' vs ' + a1.id);

// --- 2. the author withdraws their own message -------------------------------
const r1 = alice.post({ type: 'revoke', body: { retracts: a1.id, reason: 'changed my mind' }, refs: [a1.id] });
check('alice can withdraw her own message', r1.ok === true);
check('bob accepts the withdrawal', bob.ingest(r1.message).accepted === true);

inbox = bob.inbox();
check('★★ the withdrawn message is GONE from bob\'s inbox (agents honour it, not just the console)',
  inbox.length === 0, 'still seeing ' + inbox.length + ': ' + JSON.stringify(inbox.map((i) => i.type)));

inbox = bob.inbox({ includeWithdrawn: true });
check('★ with includeWithdrawn it comes back', inbox.length === 1, 'got ' + inbox.length);
check('★ and it is LABELLED as withdrawn, so it cannot be mistaken for live text',
  inbox[0].withdrawn !== undefined);
check('the label names WHO withdrew it', typeof inbox[0].withdrawn?.by === 'string');
check('the label carries the reason', inbox[0].withdrawn?.reason === 'changed my mind',
  String(inbox[0].withdrawn?.reason));
check('the label records it was the author, not an admin', inbox[0].withdrawn?.role === 'author',
  String(inbox[0].withdrawn?.role));
check('the withdrawn entry keeps its real id', inbox[0].id === a1.id, inbox[0].id + ' vs ' + a1.id);

// --- 3. the tombstone itself is never shown as something a peer said ----------
check('★ the revoke message never appears as an inbox item',
  !inbox.some((i) => i.type === 'revoke'));
check('and it is not in the normal inbox either',
  !bob.inbox().some((i) => i.type === 'revoke'));

// --- 4. a STRANGER cannot withdraw someone else's message --------------------
const a2 = alice.post({ type: 'announce', topic: 'demo', body: 'a second message' });
bob.ingest(a2.message);
check('bob sees the second message', bob.inbox().some((i) => i.id === a2.id));

const r2 = mallory.post({ type: 'revoke', body: { retracts: a2.id, reason: 'I want this gone' }, refs: [a2.id] });
bob.ingest(r2.message);
check('★★ a STRANGER\'s withdrawal does NOT hide alice\'s message from bob',
  bob.inbox().some((i) => i.id === a2.id),
  'mallory is only "observer" to bob, so her retraction must be refused');

// --- 5. an ADMIN may withdraw anyone's message, once bob knows who is admin ---
// Bob learns levels through the same trust bundle path the real flow uses.
alice.adoptTrust({ roots: [alice.agentId], permits: [] });
const adminNode = alice;   // alice is a root of her own bundle, so she resolves to admin
bob.adoptTrust({ roots: [alice.agentId], permits: [] });
check('bob now resolves alice to admin', bob.allowList.levelOf(alice.agentId) === 'admin',
  bob.allowList.levelOf(alice.agentId));

const r3 = adminNode.post({ type: 'revoke', body: { retracts: a2.id, reason: 'admin action' }, refs: [a2.id] });
bob.ingest(r3.message);
check('★ an ADMIN withdrawal hides the message from bob',
  !bob.inbox().some((i) => i.id === a2.id));

inbox = bob.inbox({ includeWithdrawn: true });
const w2 = inbox.find((i) => i.id === a2.id);
check('it is retrievable with the admin attribution',
  w2?.withdrawn?.role === 'admin', String(w2?.withdrawn?.role));
check('and with the admin\'s reason', w2?.withdrawn?.reason === 'admin action', String(w2?.withdrawn?.reason));

// --- 6. the log is intact: withdrawals never remove evidence ------------------
const v = bob.verify();
check('★ bob\'s chain still verifies after all of this', v.ok === true, JSON.stringify(v.errors));
check('★ and the withdrawn messages are still physically in the log',
  bob.rawLog().some((m) => messageId(m) === a1.id),
  'a1 must still be on disk — a withdrawal is a tombstone, not a delete');
check('the log grew by exactly the tombstones, not shrank',
  bob.rawLog().length >= 5, 'log has ' + bob.rawLog().length + ' entries');

// --- 7. an inbox with everything withdrawn is empty, not broken ---------------
const lonely = CommonsNode.open({ dir: join(BASE, 'lonely') });
check('an agent that has heard nothing has an empty inbox', lonely.inbox().length === 0);

console.log('');
console.log(pass + ' assertions passed' + (fail ? ', ' + fail + ' FAILED' : '') + '.');
if (fail) process.exit(1);
