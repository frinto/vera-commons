// SILENTLY UNRUN TESTS.
//
// `npm test` is an explicit &&-chain of file paths, not a directory glob. So a test file that is written
// and never added to the chain runs NOWHERE -- it is not slow, not skipped, not reported: as far as the
// project is concerned it does not exist. Measured 2026-10-12: 41 test files on disk, 35 in the chain,
// and one of the six orphans (console-relay-queue) was FAILING with 5 broken assertions while `npm test`
// reported exit 0. The console panel's own 19 tests had never run once since they were written.
//
// This file is the missing invariant, and it is deliberately the same shape as
// test/trial-coverage.test.mjs:
//
//     every test/*.test.mjs must be EITHER in the npm test chain OR in EXEMPT with a written reason.
//
// A file may be exempt -- some tests genuinely need a resource the chain cannot assume -- but the
// exemption has to be WRITTEN DOWN. The failure this prevents is not "a test is slow": it is "the suite
// is green and a real failure is sitting in a file nothing runs".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('package.json', root)), 'utf8'));
const chain = pkg.scripts.test ?? '';

// Files deliberately NOT in the chain. Each needs a reason, and the reason is checked for length, so
// "exempt" cannot quietly become a synonym for "forgotten".
const EXEMPT = new Map([
  // (nothing is exempt today, and that is the honest state: all 41 files run.)
]);

const onDisk = readdirSync(fileURLToPath(new URL('test/', root)))
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

test('every test file on disk is either in the npm test chain or explicitly exempt', () => {
  const orphans = onDisk.filter((f) => !chain.includes(`test/${f}`) && !EXEMPT.has(f));
  assert.deepEqual(orphans, [],
    `${orphans.length} test file(s) run NOWHERE: ${orphans.join(', ')}\n`
    + '  Add each one to scripts.test where it belongs, or list it in EXEMPT above with a reason.');
});

test('the chain does not name a test file that no longer exists', () => {
  const named = [...chain.matchAll(/test\/([A-Za-z0-9._-]+\.test\.mjs)/g)].map((m) => m[1]);
  const missing = named.filter((f) => !onDisk.includes(f));
  assert.deepEqual(missing, [], `scripts.test names file(s) that do not exist: ${missing.join(', ')}`);
});

test('this file is itself in the chain', () => {
  // The invariant has to hold for its own author, or the next orphan is the checker.
  assert.ok(chain.includes('test/chain-coverage.test.mjs'),
    'chain-coverage is not in the npm test chain -- the orphan check is itself an orphan');
});

test('every exemption states a usable reason', () => {
  for (const [file, reason] of EXEMPT) {
    assert.ok(typeof reason === 'string' && reason.trim().length > 10,
      `${file} is exempt with no usable reason written down`);
  }
});
