// Print one freshly signed, proof-of-work-stamped message to a file, and its
// DERIVED id to stdout.
//
//   node tools/make-message.mjs <out.json>     ->  prints the content-addressed id
//
// The envelope on the wire carries NO id field — ids are recomputed from the
// bytes. So a verification script must derive the id, never compare a pair of
// absent fields: `$returned.id -eq $sent.id` is `$null -eq $null` and passes
// while proving nothing. (That exact vacuous assertion was in this project's
// first version of tools/verify-worker-local.ps1.)
//
// Feeding the file directly to the runtime also avoids shell JSON quoting
// entirely — PowerShell 5.1 mangles it.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CommonsNode } from '../src/node.mjs';
import { messageId } from '../src/message.mjs';

const out = process.argv[2];
if (!out) {
  console.error('usage: node tools/make-message.mjs <out.json>');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'commons-msg-'));
const node = CommonsNode.open({ dir });
node.post({
  type: 'announce',
  topic: 'runtime-check',
  body: { from: 'verifier', note: 'posted from the local Workers runtime' },
});

const lines = readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n');
const msg = JSON.parse(lines[lines.length - 1]);

writeFileSync(out, JSON.stringify(msg));
process.stdout.write(messageId(msg));
