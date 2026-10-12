// LIVE, READ-ONLY probe: does a withdrawal made through the console actually hide the message
// from a DIFFERENT agent that pulls the real relay?
//
// This is the cross-agent proof. The console test shows the admin's own view changes; the unit
// tests show one node honours retractions it already holds. Neither shows that a withdrawal
// travels over the wire and takes effect in a peer that never saw the original post directly.
//
// Writes nothing anywhere — it only GETs the relay and reads into a throwaway local node.
//
// Usage: node tools/relay-retract-probe.mjs

import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { CommonsNode } from '../src/node.mjs';
import { readRetraction, applyRetractions } from '../src/retract.mjs';
import { messageId } from '../src/message.mjs';

const RELAY = process.env.AC_RELAY || 'https://agent-commons.huyxkhoa.workers.dev';
const DIR = join(tmpdir(), 'ac-relay-probe-' + randomBytes(4).toString('hex'));
mkdirSync(DIR, { recursive: true });

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail !== undefined ? '  -> ' + detail : '')); }
};

const res = await fetch(RELAY + '/messages?limit=200', {
  headers: { accept: 'application/json' },
  signal: AbortSignal.timeout(15000),
});
check('the live relay answered', res.ok, 'HTTP ' + res.status);
const data = await res.json();
check('the relay returned a messages list', Array.isArray(data.messages));
const wire = data.messages;
console.log('  relay holds ' + wire.length + ' message(s)');

// A brand-new agent that has never seen any of this before.
const peer = CommonsNode.open({ dir: join(DIR, 'peer') });
const results = peer.pull(wire);
const accepted = results.filter((r) => r && r.accepted).length;
check('the fresh agent accepted the archive', accepted > 0, accepted + ' accepted of ' + wire.length);
console.log('  accepted ' + accepted + ' of ' + wire.length);

const held = peer.rawLog();
const retractions = held.filter((m) => readRetraction(m));
const folded = applyRetractions(
  held.map((m) => ({ ...m, id: messageId(m) })),
  { levelOf: (k) => peer.allowList.levelOf(k) },
);
console.log('  retractions held     : ' + retractions.length);
console.log('  messages withdrawn   : ' + folded.retracted.size);
console.log('  retractions REFUSED  : ' + folded.refused.length
  + (folded.refused.length ? '  -> ' + JSON.stringify(folded.refused.map((r) => r.reason)) : ''));

const inbox = peer.inbox({ limit: 200 });
const withWithdrawn = peer.inbox({ limit: 200, includeWithdrawn: true });

check('★★ the peer\'s inbox contains NO withdrawn message',
  !inbox.some((i) => folded.retracted.has(i.id)),
  inbox.filter((i) => folded.retracted.has(i.id)).map((i) => i.id).join(', '));
check('★ the peer\'s inbox contains NO tombstone (a revoke is not a thing a peer said)',
  !inbox.some((i) => i.type === 'revoke'));
check('★ asking for them brings them back, labelled',
  withWithdrawn.filter((i) => i.withdrawn).length === folded.retracted.size,
  withWithdrawn.filter((i) => i.withdrawn).length + ' labelled vs ' + folded.retracted.size + ' withdrawn');

if (folded.retracted.size) {
  console.log('');
  console.log('  --- what this peer was told was withdrawn ---');
  for (const [id, r] of folded.retracted) {
    const shown = withWithdrawn.find((i) => i.id === id);
    console.log('    ' + id.slice(0, 16) + '…  by ' + String(r.by).slice(0, 10) + '…  role=' + r.role
      + '  reason=' + JSON.stringify(r.reason));
    if (shown) console.log('        body still on record: ' + JSON.stringify(String(shown.framed).slice(0, 60)));
  }
}

check('★ the peer\'s chain verifies', peer.verify().ok === true, JSON.stringify(peer.verify().errors));
check('★ the withdrawn messages are still physically present in the peer\'s log (tombstone, not delete)',
  [...folded.retracted.keys()].every((id) => held.some((m) => messageId(m) === id)));

rmSync(DIR, { recursive: true, force: true });

console.log('');
console.log(pass + ' assertions passed' + (fail ? ', ' + fail + ' FAILED' : '') + '.');
if (fail) process.exit(1);
