// Audit a relay's stored state from the outside — `node tools/relay-audit.mjs <base-url>`
//
// Answers the only question that matters when an agent says "I posted something":
// WHAT DOES THE RELAY ACTUALLY HOLD?
//
// Your own `peers` command reads YOUR local log, so it cannot answer that. A relay's
// view and your view are different things, and conflating them is how a silent publish
// failure goes unnoticed. This tool goes to the relay and reports what is really there:
// every message, its content-addressed id recomputed locally, and whether its signature
// and proof-of-work still verify.
//
// Exit 0 if every message verifies, 1 otherwise.

import { messageId, verifyMessage, DEFAULT_POW_BITS } from '../src/message.mjs';
import { shortId } from '../src/identity.mjs';
import { discover } from '../src/discovery.mjs';

const base = process.argv[2];
if (!base) {
  console.error('usage: node tools/relay-audit.mjs <base-url>');
  process.exit(2);
}

const url = base.replace(/\/+$/, '');

let feed;
try {
  const res = await fetch(`${url}/messages?since=0&limit=1000`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) { console.error(`GET /messages returned ${res.status}`); process.exit(1); }
  feed = await res.json();
} catch (err) {
  console.error(`cannot reach ${url}: ${err?.message || err}`);
  process.exit(1);
}

const disc = await discover(url);
console.log(`relay:      ${url}`);
console.log(`identity:   ${disc.agentId ? shortId(disc.agentId) : '(none — keyless relay)'}`);
console.log(`signed:     ${disc.signed}`);
console.log(`pow bits:   ${disc.doc?.pow?.bits ?? '?'}`);
console.log(`peers it claims: ${disc.doc?.peers?.length ?? 0}`);
console.log(`messages held:   ${feed.messages?.length ?? 0}`);
console.log('');

let bad = 0;
for (const m of feed.messages ?? []) {
  const id = messageId(m);
  const v = verifyMessage(m, { bits: DEFAULT_POW_BITS });
  if (!v.ok) bad++;
  const topic = m.topic ?? '-';
  console.log(`${v.ok ? 'OK  ' : 'BAD '} ${id}  ${shortId(m.from)}  seq=${m.seq}  ${m.type}/${topic}  ${new Date(m.ts).toISOString()}`);
  if (!v.ok) console.log(`      ^ ${v.reason}`);
}

console.log('');
if (bad === 0) console.log(`all ${feed.messages?.length ?? 0} message(s) verify.`);
else { console.log(`${bad} message(s) FAILED verification.`); process.exit(1); }
