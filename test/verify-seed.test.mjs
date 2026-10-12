// Guards for tools/verify-seed.mjs -- the tool you run BEFORE deleting the original of an
// irreplaceable ed25519 key.
//
// WHY THIS FILE EXISTS. verify-seed.mjs was written to stop one specific catastrophe: taking a photo
// of a private key, being satisfied by it, and deleting the original. Its own header says a photograph
// of a key is a CLAIM, not a verified backup. Nothing in the repository had ever run it -- it takes
// `--seed`, so it needed a human who already had the key in hand, and no test proved it still worked.
// A safety tool that is never exercised is a safety tool that is assumed to work.
//
// Every assertion below was measured from the real process first (see the round's probe), not inferred
// from the source. No real key is used: the seeds are generated inside this test and never printed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityFromSeed } from '../src/identity.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(ROOT, 'tools', 'verify-seed.mjs');

const seed = randomBytes(32).toString('base64url');
const otherSeed = randomBytes(32).toString('base64url');
const agentId = identityFromSeed(Buffer.from(seed, 'base64url')).agentId;
const otherId = identityFromSeed(Buffer.from(otherSeed, 'base64url')).agentId;

/** Run the tool and return {code, out}. Never throws on a non-zero exit -- a non-zero exit is data. */
function run(args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

test('a backup that is the WRONG KEY fails loudly and says not to delete the original', () => {
  // This is the whole point of the tool. It must be able to fail, and the failure must be unmissable:
  // an operator reading a green-ish "derived agentId: ..." and deleting the original loses the key.
  const { code, out } = run(['--seed', seed, '--expect', otherId]);
  assert.equal(code, 1, 'a mismatched backup must exit non-zero');
  assert.match(out, /MISMATCH/, 'the mismatch must be stated in words, not implied by an exit code');
  assert.match(out, /[Dd]o not delete the original/, 'the operator must be told what NOT to do');
  assert.doesNotMatch(out, /MATCH — the backup decodes to exactly this key/,
    'the success sentence must not appear on a failure path');
});

test('the right key matches, and is not claimed safe without --expect', () => {
  const good = run(['--seed', seed, '--expect', agentId]);
  assert.equal(good.code, 0);
  assert.match(good.out, /MATCH/);

  // Without --expect the tool can only prove the seed DECODES. It must say so rather than let an
  // operator read its exit 0 as "the backup is good" -- a flash photo that decodes is not a backup.
  const noExpect = run(['--seed', seed]);
  assert.equal(noExpect.code, 0);
  assert.match(noExpect.out, /only proves the seed DECODES/,
    'without --expect the tool must refuse to imply the backup is verified');
  assert.doesNotMatch(noExpect.out, /safe to rely on/,
    'the tool must not call a backup safe when it was never compared against a known key');
});

test('a seed that cannot decode is rejected, and a missing argument is a usage error', () => {
  const short = run(['--seed', randomBytes(8).toString('base64url'), '--expect', agentId]);
  assert.equal(short.code, 1);
  assert.match(short.out, /INVALID SEED/);

  // Exit 2, distinct from 1: "I was not asked a question" is not the same as "the answer is no".
  const none = run([]);
  assert.equal(none.code, 2, 'no arguments must be a usage error, never a silent pass');
  assert.match(none.out, /usage:/);
});

test('the seed is NEVER echoed, in any outcome', () => {
  // The tool's own promise is that it is safe to run with the screen visible. That promise is only
  // worth anything if it holds on every path -- including the failure paths, which are the ones a
  // panicking operator is most likely to paste into a chat window.
  const paths = [[], ['--seed', seed, '--expect', agentId], ['--seed', seed, '--expect', otherId],
    ['--seed', randomBytes(8).toString('base64url')], ['--seed', seed]];
  for (const args of paths) {
    const { out } = run(args);
    assert.ok(!out.includes(seed), `the seed leaked on: verify-seed ${args.join(' ')}`);
    assert.ok(!out.includes(otherSeed), 'the comparison seed leaked');
  }
});

test('--seed-file self-checks an existing key file without modifying it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-seed-'));
  try {
    const file = join(dir, 'key.json');
    writeFileSync(file, JSON.stringify({ privateKey: seed, agentId }, null, 2));
    const before = createHash('sha256').update(readFileSync(file)).digest('hex');

    const { code, out } = run(['--seed-file', file]);
    assert.equal(code, 0);
    assert.match(out, /MATCH/);

    // A verifier that rewrites the thing it was asked to inspect would destroy the only copy.
    const after = createHash('sha256').update(readFileSync(file)).digest('hex');
    assert.equal(after, before, 'verify-seed must not modify the key file it inspects');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
