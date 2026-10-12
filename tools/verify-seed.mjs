// Verify that a backed-up ed25519 seed is intact BEFORE you delete the original.
//
// WHY THIS EXISTS
// A photograph of a private key is a CLAIM, not a verified backup. If the photo is blurry,
// cropped, or missed a character, the key is gone and NOTHING can recover it — these keys
// are not regenerable, and the commons root is the only key that can revoke anything.
//
// An ed25519 seed is 32 bytes and determines its public key exactly. So a backup is provable:
// read the `privateKey` field off the photo, run it through this tool, and see whether the
// derived agentId equals the one on file. MATCH means the backup decodes and is usable.
// MISMATCH means do not delete anything.
//
// The seed is never echoed back, so it is safe to run with the screen visible.
//
// Usage:
//   node tools/verify-seed.mjs --seed <base64url> [--expect <agentId>]
//   node tools/verify-seed.mjs --seed-file <path-to-key.json>   (self-check an existing file)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { identityFromSeed, shortId } from '../src/identity.mjs';

const argv = process.argv.slice(2);
const val = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

const seedArg = val('--seed');
const fileArg = val('--seed-file');
const expect = val('--expect');

if (!seedArg && !fileArg) {
  console.error('usage: node tools/verify-seed.mjs --seed <base64url> [--expect <agentId>]');
  console.error('       node tools/verify-seed.mjs --seed-file <key.json> [--expect <agentId>]');
  process.exit(2);
}

let seed = seedArg;
let expected = expect;

if (fileArg) {
  const identity = JSON.parse(readFileSync(resolve(fileArg), 'utf8'));
  seed = identity.privateKey;
  expected = expected ?? identity.agentId;
}

let id;
try {
  id = identityFromSeed(Buffer.from(String(seed), 'base64url'));
} catch (err) {
  console.error(`INVALID SEED — do not trust this backup: ${err.message}`);
  process.exit(1);
}

console.log(`derived agentId : ${id.agentId}`);
console.log(`short           : ${shortId(id.agentId)}`);

if (!expected) {
  console.log('\nNo --expect given, so this only proves the seed DECODES, not that it is the right key.');
  process.exit(0);
}

if (id.agentId === expected) {
  console.log(`expected        : ${expected}`);
  console.log('\nMATCH — the backup decodes to exactly this key. It is safe to rely on.');
  process.exit(0);
}

console.log(`expected        : ${expected}`);
console.log('\nMISMATCH — THIS BACKUP IS NOT THAT KEY. Do not delete the original.');
process.exit(1);
