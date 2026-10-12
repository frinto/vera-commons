// Guards for tools/verify-relay-verdicts.mjs -- the runner that re-verifies every verdict the live
// relay has published.
//
// WHY THIS FILE EXISTS. tools/verify-relay-verdict.mjs could always check one verdict, but it takes an
// id and the list of ids is behind the operator secret, so nobody was ever going to run it 17 times by
// hand. Nothing ran it. The runner closes that gap.
//
// WHAT IS TESTED HERE, AND WHAT IS NOT. This file is OFFLINE: it pins the classification arithmetic and
// the refusal to run without a way to enumerate. It does NOT test the cryptography -- that is
// verify-relay-verdict.mjs's job, and its discriminating power was demonstrated separately by serving
// a REAL verdict from the live relay twice through a local stub, once untouched and once with the
// decision flipped and the signature unchanged: intact -> exit 0, tampered -> exit 1. A test that
// needed the live relay would be a flaky test, not a stronger one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from '../tools/verify-relay-verdicts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(ROOT, 'tools', 'verify-relay-verdicts.mjs');

test('published verdicts are counted; undecided requests never masquerade as verified', () => {
  const s = summarize([
    { id: 'a', hasVerdict: true, verifies: true },
    { id: 'b', hasVerdict: true, verifies: true },
    { id: 'c', hasVerdict: true, verifies: false },
    { id: 'd', hasVerdict: false, verifies: false },
    { id: 'e', hasVerdict: false, verifies: false },
  ]);
  assert.equal(s.total, 5);
  assert.equal(s.published, 3, 'only records with a published verdict may be held to account');
  assert.equal(s.verified, 2);
  assert.deepEqual(s.broken.map(b => b.id), ['c'], 'a published verdict that does not re-derive must be named');
  assert.deepEqual(s.undecided.map(u => u.id), ['d', 'e'],
    'a request with no verdict was never decided -- it must be reported, not counted as a failure');
});

test('an empty relay is not an error, and an all-undecided relay verifies nothing', () => {
  const empty = summarize([]);
  assert.equal(empty.published, 0);
  assert.deepEqual(empty.broken, []);
  assert.equal(empty.verified, 0);

  const s = summarize([{ id: 'x', hasVerdict: false, verifies: false }]);
  assert.equal(s.verified, 0, 'nothing was decided, so nothing may be reported as verified');
  assert.equal(s.published, 0);
});

test('it refuses to run rather than report "nothing to verify" when it cannot ask', () => {
  // The dangerous confusion: "the relay lists no requests" and "I could not reach the relay" both
  // produce an empty list, and only the first is good news. Without a secret and without explicit ids
  // it must exit 2, not 0.
  let code = 0, out = '';
  try {
    out = execFileSync(process.execPath, [TOOL], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AC_OPERATOR_SECRET_FILE: join(ROOT, '.tmp', 'definitely-not-here.txt') },
    });
  } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); code = e.status; }
  assert.equal(code, 2, 'no secret and no ids must be a usage failure, never a clean pass');
  assert.match(out, /Cannot enumerate/);
});
