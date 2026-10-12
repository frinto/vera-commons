// Guards for tools/verify-store.mjs, the runner that makes store-wide independent verification a
// single command instead of a thing someone has to remember to do.
//
// WHY THIS FILE EXISTS. tools/verify-admission.mjs is a real, discriminating verifier -- it re-derives
// a record's standing from the store alone, mutates the statement to prove its own check can fail, and
// checks that the interview signature cannot be replayed in the relay signing domain. Nothing in the
// repository ever ran it, because it takes `--id` and so required already knowing which record to ask
// about. The runner fixed that, and the runner's FIRST VERSION had exactly the defect this project
// hunts: it listed records from the store it was pointed at, but let each child process fall back to
// the DEFAULT store, so pointing it at a tampered copy verified that copy's ROWS against the untouched
// original and reported HELD-UP. A tamper test in .tmp/ is the only reason it is not still there.
//
// HONEST LIMIT, stated rather than hidden: the behavioural test below CANNOT catch that pass-through
// bug on its own. With the bug, the child fails to find the record in the default store, the runner
// marks it unverified, and the output is byte-for-byte what a real detection looks like -- both are
// "BROKEN, exit 1". Distinguishing them needs a store whose record VERIFIES, which needs the real
// stick. So the contract is pinned statically, and that is a deliberate, narrow exception to this
// project's preference for behavioural checks: here the behaviour is "the argument is passed", and
// there is no cheaper way to observe it without the hardware.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'tools', 'verify-store.mjs'), 'utf8');

test('verify-store passes --store THROUGH to every child it spawns', () => {
  // The bug that was caught: records listed from the given store, verified against the default one.
  assert.match(SRC, /'--store',\s*STORE/,
    'verify-store no longer passes --store to verify-admission -- it will list one store and verify another');
  assert.match(SRC, /execFileSync\(process\.execPath/,
    'verify-store no longer runs each record in its own process');
});

test('a file that is not this store is not a passing store', () => {
  // The shape that matters: any JSON that is not this store's shape -- {}, {"admissions": null}, a
  // relay or error response saved by mistake -- rendered as "verifying 0 record(s)" followed by the OK
  // banner and exit 0. A tamper check that blesses a file it could not read is worse than no check at
  // all, because it produces the reassuring sentence this whole tool exists to be able to print.
  const TOOL = join(ROOT, 'tools', 'verify-store.mjs');
  const run = (file) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [TOOL, '--store', file], { encoding: 'utf8', cwd: ROOT }) };
    } catch (err) {
      return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };
  const dir = mkdtempSync(join(tmpdir(), 'ac-vstore-shape-'));
  try {
    const cases = [
      ['empty-object', 'an empty object', {}],
      ['null-field', 'a null admissions field', { admissions: null }],
      ['relay-response', 'a saved relay response', { ok: false, reason: 'operator_only' }],
      ['no-records', 'a store that is shape-valid but holds no records', { admissions: [] }],
    ];
    for (const [slug, label, body] of cases) {
      const f = join(dir, `${slug}.json`);
      writeFileSync(f, JSON.stringify(body));
      const r = run(f);
      assert.notEqual(r.code, 0, `${label} must not pass:\n${r.out}`);
      assert.doesNotMatch(r.out, /OK: every record/,
        `${label} printed the clean banner -- this is the false pass:\n${r.out}`);
      assert.doesNotMatch(r.out, /verifying 0 record\(s\)/,
        `${label} was reported as an empty store rather than as a file that is not a store:\n${r.out}`);
    }
    // ...and it must still be able to say "not valid JSON" rather than dumping a parse stack trace.
    const junk = join(dir, 'truncated.json');
    writeFileSync(junk, '{"admissions": [{"id": "abc"');
    const bad = run(junk);
    assert.notEqual(bad.code, 0, 'truncated JSON must not pass');
    assert.match(bad.out, /not valid JSON|is not valid/i, `a truncated store needs a diagnosis:\n${bad.out}`);
    assert.doesNotMatch(bad.out, /at JSON\.parse|node:internal/,
      `a truncated store must not dump a stack trace at the operator:\n${bad.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a decided record that cannot be re-derived is held to account; an expired one is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-vstore-'));
  try {
    const store = join(dir, 'admissions.json');
    writeFileSync(store, JSON.stringify({
      admissions: [
        // A decision was recorded on this one, so the commons says it admitted somebody: it MUST stand up.
        { id: 'decided-but-unsigned', status: 'decided', decision: 'grant', agentId: 'not-a-real-key', interview: { statement: 'hello', sig: 'nope' } },
        // Never completed. It cannot verify by construction, and saying so is not a failure.
        { id: 'expired-one', status: 'expired' },
      ],
    }, null, 2));

    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, [join(ROOT, 'tools', 'verify-store.mjs'), '--store', store],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = String(e.stdout || '') + String(e.stderr || '');
      code = e.status;
    }

    assert.equal(code, 1, 'a decided record that does not verify must make the command fail');
    // The id must appear IN FULL. A truncated id cannot be fed back into `verify-admission --id`, and
    // two ids sharing a prefix would print as the same record -- so the report would name a record
    // nobody can go and look at.
    assert.match(out, /BROKEN\s+decided-but-unsigned\b/,
      'the failing record must be NAMED IN FULL, not just counted -- "1 failed" without an actionable id is not a report');
    assert.match(out, /inert\s+expired-one\b/,
      'the expired record must be reported, so a green summary cannot be read as "all of these are admissions"');
    assert.match(out, /1 of them failed/, 'the summary must separate records held to account from inert ones');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
