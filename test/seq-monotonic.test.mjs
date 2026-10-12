// Per-sender seq monotonicity must be enforced AT THE DOOR, not detected afterwards.
//
// WHY THIS FILE EXISTS. A live probe against the real relay found a peer whose verify() failed with
// five `seq_not_increasing` errors. The messages had been accepted into the log; the violation was
// only discovered later by verifyChain(), by which point the store was already invalid — so the
// peer reported a broken chain for a log that was otherwise entirely honest.
//
// Spec T3/T4 say per-sender monotonic seq is "what makes replay and truncation detectable". Being
// able to detect the damage afterwards is not the same as refusing to take it. These tests pin the
// refusal, and they include the case that matters most: the honest messages around a bad one must
// still be accepted and the log must still verify.
//
// Run: node test/seq-monotonic.test.mjs

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

import { CommonsNode } from '../src/node.mjs';
import { createMessage, messageId } from '../src/message.mjs';
import { generateIdentity } from '../src/identity.mjs';

const BASE = join(import.meta.dirname, '..', '.tmp', `seq-${Date.now()}`);
mkdirSync(BASE, { recursive: true });

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail !== undefined ? '  -> ' + detail : '')); }
};

const alice = CommonsNode.open({ dir: join(BASE, 'alice') });
const bob = CommonsNode.open({ dir: join(BASE, 'bob') });

// --- 1. honest, increasing traffic is accepted -------------------------------
const a1 = alice.post({ type: 'hello', body: 'one' });
const a2 = alice.post({ type: 'hello', body: 'two' });
const a3 = alice.post({ type: 'hello', body: 'three' });
check('alice\'s own seqs are 1,2,3', a1.message.seq === 1 && a2.message.seq === 2 && a3.message.seq === 3,
  [a1.message.seq, a2.message.seq, a3.message.seq].join(','));
check('bob accepts seq 1', bob.ingest(a1.message).accepted === true);
check('bob accepts seq 2', bob.ingest(a2.message).accepted === true);
check('bob accepts seq 3', bob.ingest(a3.message).accepted === true);
check('bob still sees three messages', bob.inbox().length === 3, String(bob.inbox().length));

// --- 2. a message reusing an already-used seq is REFUSED ----------------------
// A different body, so this is not caught by the duplicate check — it is genuinely a new message
// claiming a seq its sender has already spent.
const alice2 = CommonsNode.open({ dir: join(BASE, 'alice2') });
// Force a collision: a fresh identity whose seq also starts at 1, re-signed as if from alice.
const replayed = createMessage(alice.identity, { type: 'hello', body: 'a NEW body at seq 1' },
  { seq: 1, ts: Date.now(), bits: alice.powBits });

const res = bob.ingest(replayed);
check('★ a message reusing seq 1 is REFUSED', res.accepted === false, JSON.stringify(res));
check('★ and the reason names the actual problem', res.reason === 'seq_not_increasing', String(res.reason));
check('★ the refusal reports what was seen, so it is diagnosable',
  res.seq === 1 && res.maxSeen === 3, 'seq=' + res.seq + ' maxSeen=' + res.maxSeen);

// --- 3. a LOWER seq is refused too -------------------------------------------
const lower = createMessage(alice.identity, { type: 'hello', body: 'an older-looking message' },
  { seq: 2, ts: Date.now(), bits: alice.powBits });
check('★ a message with a LOWER seq is refused',
  bob.ingest(lower).accepted === false);

// --- 4. THE LOG IS STILL VALID -----------------------------------------------
// This is the whole point. Before the fix the bad message was written and verifyChain() failed,
// condemning the entire log including the three honest messages.
const v = bob.verify();
check('★★ bob\'s chain still verifies — the bad message never entered the log', v.ok === true,
  JSON.stringify(v.errors));
check('★ bob still has exactly the three honest messages', bob.rawLog().length === 3,
  String(bob.rawLog().length));
check('the refused message is not on disk', !bob.rawLog().some((m) => messageId(m) === messageId(replayed)));

// --- 5. the next legitimate seq still works ----------------------------------
const a4 = alice.post({ type: 'hello', body: 'four' });
check('alice\'s next message is seq 4', a4.message.seq === 4, String(a4.message.seq));
check('and bob accepts it', bob.ingest(a4.message).accepted === true);
check('★ chain still verifies after the good message follows the refusals',
  bob.verify().ok === true);

// --- 6. a literal replay is still reported as a DUPLICATE, not a seq problem ---
// Precision matters: the two checks must not be confused, or a genuine double-delivery would be
// misreported as an attack and an attack as a double-delivery.
check('★ re-delivering an already-stored message reports `duplicate`',
  bob.ingest(a1.message).duplicate === true);
check('★ ...and NOT seq_not_increasing',
  bob.ingest(a1.message).reason !== 'seq_not_increasing');

// --- 7. a fresh store restarts at 1, which is exactly the reinstall trap ------
const carolFresh = CommonsNode.open({ dir: join(BASE, 'carol-fresh') });
const c1 = carolFresh.post({ type: 'hello', body: 'first ever' });
check('a brand-new identity starts at seq 1', c1.message.seq === 1, String(c1.message.seq));
check('★ a DIFFERENT sender\'s seq 1 is not affected by alice\'s history',
  bob.ingest(c1.message).accepted === true, 'seq is per-sender, never global');
check('bob now holds 5 messages from 2 senders', bob.rawLog().length === 5, String(bob.rawLog().length));
check('and the multi-sender chain verifies', bob.verify().ok === true, JSON.stringify(bob.verify().errors));

console.log('');
console.log(pass + ' assertions passed' + (fail ? ', ' + fail + ' FAILED' : '') + '.');
if (fail) process.exit(1);
