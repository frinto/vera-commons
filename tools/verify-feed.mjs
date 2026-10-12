// Verify a relay's message feed against an id we computed BEFORE sending.
//
//   node tools/verify-feed.mjs <expected-id> <feed-response.json>
//
// Exit 0 only if the feed holds exactly one message, its bytes recompute to the
// expected content-addressed id, AND its signature + proof-of-work still verify.
//
// Why this is a separate program: the check has to happen in Node, where the
// canonicalization is. A shell script cannot recompute the id, and the obvious
// shell substitute — comparing `returned.id` to `sent.id` — compares two fields
// that do not exist on the wire, so it always passes. This tool makes the
// assertion capable of failing.

import { readFileSync } from 'node:fs';
import { messageId, verifyMessage, DEFAULT_POW_BITS } from '../src/message.mjs';

const [expectedId, file] = process.argv.slice(2);
if (!expectedId || !file) {
  console.error('usage: node tools/verify-feed.mjs <expected-id> <feed-response.json>');
  process.exit(2);
}

let feed;
try {
  feed = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`cannot read the feed response: ${err?.message || err}`);
  process.exit(1);
}

const msgs = feed.messages ?? [];
if (msgs.length !== 1) {
  console.error(`expected exactly 1 message in the feed, found ${msgs.length}`);
  process.exit(1);
}

const id = messageId(msgs[0]);
if (id !== expectedId) {
  console.error(`id mismatch — the bytes changed in transit\n  sent:       ${expectedId}\n  recomputed: ${id}`);
  process.exit(1);
}

const verdict = verifyMessage(msgs[0], { bits: DEFAULT_POW_BITS });
if (!verdict.ok) {
  console.error(`the returned message no longer verifies: ${verdict.reason}`);
  process.exit(1);
}

console.log(`id and signature both verified after the round trip: ${id}`);
