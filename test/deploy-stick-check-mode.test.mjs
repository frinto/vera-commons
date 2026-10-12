/**
 * Catches a silent-staleness defect that no test could previously see.
 *
 * `tools/deploy-stick.mjs` copied the code to the stick FIRST and compared it SECOND. So the act of
 * checking REPAIRED the thing being checked, and the comparison could only ever answer "in sync" --
 * it was structurally incapable of reporting drift, because by the time it looked, it had already
 * overwritten the evidence. This is not theoretical: a stick ran for hours with an OLDER
 * src/policy.mjs (the admission rules the admin console enforces) and with src/frame.mjs absent
 * entirely, while every deploy printed success. The divergence was only visible from OUTSIDE the
 * tool, by comparing the two trees by hand.
 *
 * `--check` fixes that by stopping before the copy. This test holds together the three properties
 * that make the flag mean what it says:
 *   1. it is a real flag (documented, in KNOWN_FLAGS) and not accepted by accident;
 *   2. the copy, the launcher write and the console start are all on the OTHER side of it -- an
 *      early exit BEFORE the writers is the whole mechanism, so it is asserted structurally;
 *   3. an unrecognised flag is REFUSED (exit 2) rather than ignored, because this script writes to a
 *      physical device.
 *
 * What it does NOT do: it cannot prove a real stick is in sync, and it cannot prove that no byte was
 * written -- that was verified once against real hardware by hashing all 238 code-tree files before
 * and after a --check run (0 changed). This test is the cheap standing guard in place of a device,
 * which the npm test chain cannot depend on being plugged in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOOL = join(ROOT, 'tools', 'deploy-stick.mjs');
const SRC = readFileSync(TOOL, 'utf8');

const idx = (needle) => {
  const i = SRC.indexOf(needle);
  assert.notEqual(i, -1, `expected deploy-stick.mjs to contain ${JSON.stringify(needle)}`);
  return i;
};

test('--check is a declared flag, documented in the usage line', () => {
  assert.match(SRC, /const KNOWN_FLAGS = \[\s*'--check'/, 'KNOWN_FLAGS must declare --check');
  assert.match(SRC, /Usage: node tools\/deploy-stick\.mjs \[stickRoot\] \[--check\]/,
    'the usage line must document --check, or nobody will find it');
});

test('the early exit sits BEFORE every writer, which is the whole mechanism', () => {
  const exitAt = idx('if (CHECK_ONLY) {');
  // The copy cannot happen in check mode, or the comparison below it would repair what it checks.
  assert.ok(SRC.slice(idx('// --- 1. copy'), idx('// --- 1b.')).includes('if (!CHECK_ONLY) {'),
    'the copy section must be gated on !CHECK_ONLY');
  // The generated launcher is a write, and writing it would mask a stick whose launcher is missing.
  assert.ok(SRC.includes('if (!CHECK_ONLY) writeFileSync(LAUNCHER'),
    'the launcher must not be written under --check');
  // Starting the console creates <stick>/console/data, so check mode must stop before it.
  assert.ok(exitAt < idx('// --- 2b. THE PRECONDITION'),
    '--check must exit before the precondition gate');
  assert.ok(exitAt < idx('// --- 3. START IT'),
    '--check must exit before the console is started (starting it writes to the stick)');
  assert.ok(SRC.slice(exitAt, idx('// --- 2b. THE PRECONDITION')).includes('process.exit('),
    'the --check block must actually exit, not merely print');
});

test('--check reports both outcomes with the promise that makes it trustworthy', () => {
  assert.match(SRC, /CHECK OK: the stick matches the repo\. Nothing was written\./);
  assert.match(SRC, /has DRIFTED from the repo\. Nothing was written\./);
  assert.match(SRC, /without --check to repair it/,
    'a drifted stick must tell the operator the one command that fixes it');
});

test('a missing console/ dir is REPORTED, not thrown -- check mode does not create it', () => {
  // In deploy mode the copy above guarantees the directory exists. --check does not copy, so an
  // unguarded readdir met its first empty volume with ENOENT instead of "nothing deployed".
  assert.match(SRC, /existsSync\(deployedDir\) \? readdirSync\(deployedDir\)/,
    'the deployed-module scan must tolerate a volume where nothing was ever deployed');
});

test('an unrecognised flag is refused before the device is touched', () => {
  const r = spawnSync(process.execPath, [TOOL, '--bogus'], { encoding: 'utf8' });
  assert.equal(r.status, 2, 'an unknown flag must exit 2, not be ignored');
  assert.match(r.stdout, /unrecognised flag\(s\): --bogus/, 'the refusal must name the offending flag');
  assert.match(r.stdout, /accepted: --check/, 'and state what IS accepted');
});

test('an unrecognised flag is refused even alongside a stick path', () => {
  // The discriminator is the MESSAGE, not the exit code: a bad path also exits 2, so asserting the
  // code alone would pass for the wrong reason. Naming the flag proves the flag check ran first.
  const r = spawnSync(process.execPath, [TOOL, 'Q:\\', '--deploy'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /unrecognised flag\(s\): --deploy/,
    'flags must be validated before the target is even looked at');
});

test('a nested target is still refused (the wrong-root bug must not come back)', () => {
  const r = spawnSync(process.execPath, [TOOL, join(ROOT, '.tmp')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /must be a drive root/);
});
