// Print the DERIVED id of a message read from a file: `node tools/message-id.mjs m.json`
//
// There is no `id` field on the wire. A message id is content-addressed — it is
// recomputed from the envelope every time it is needed. That is deliberate (the id
// cannot drift from the bytes), but it has a trap: a check like
// `returned.id === sent.id` compares `undefined` to `undefined` and PASSES while
// proving nothing. This tool exists so a shell script can compare a real id.
//
// Usage: node tools/message-id.mjs <file-with-one-message.json>

import { readFileSync } from 'node:fs';
import { messageId } from '../src/message.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/message-id.mjs <file.json>');
  process.exit(1);
}

try {
  const msg = JSON.parse(readFileSync(file, 'utf8'));
  process.stdout.write(messageId(msg));
} catch (err) {
  console.error(`cannot derive id: ${err?.message || err}`);
  process.exit(1);
}
