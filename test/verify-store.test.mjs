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

test('a DECLARED known-broken record is honoured, and is still never a clean store', () => {
  // The defect this guards was measured on 2026-10-12: one unrepairable record (a decided grant whose
  // key no signature ever attested) made EVERY run end "FAILED: 1 record(s) ... do NOT stand up",
  // identical whether it was that known record or a NEWLY tampered one. Telling the two apart cost a
  // second command and a human reading the log, so the red light was permanent and hid the signal it
  // existed to give. The fix declares unrepairable records BY FULL ID WITH A STATED REASON, in a
  // sidecar beside the store. These assertions pin both halves: the declaration is honoured and
  // never phrased as a pass, while an undeclared failure in the same store still fails.
  const TOOL = join(ROOT, 'tools', 'verify-store.mjs');
  const run = (file, exc) => {
    const args = [TOOL, '--store', file];
    if (exc) args.push('--known-broken', exc);
    try {
      return { code: 0, out: execFileSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT }) };
    } catch (err) {
      return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };
  const broken = (id) => ({
    id, status: 'decided', decision: 'grant', agentId: 'not-a-real-key',
    interview: { statement: 'hello', sig: 'nope' },
  });
  const dir = mkdtempSync(join(tmpdir(), 'ac-vstore-declared-'));
  try {
    const store = join(dir, 'admissions.json');
    const exc = join(dir, 'known-broken.json');
    writeFileSync(store, JSON.stringify({ admissions: [broken('unrepairable-one'), { id: 'expired-one', status: 'expired' }] }));

    const without = run(store);
    assert.equal(without.code, 1, 'without a declaration, a decided record that does not verify must still fail');
    assert.match(without.out, /BROKEN\s+unrepairable-one\b/, without.out);

    writeFileSync(exc, JSON.stringify({
      knownBroken: [{
        id: 'unrepairable-one',
        reason: 'never had a signature attesting its key; residue of an interrupted trial',
        declaredAt: '2026-10-12', declaredBy: 'test',
      }],
    }));
    const decl = run(store, exc);
    assert.equal(decl.code, 0, `a declared unrepairable record must not fail the run:\n${decl.out}`);
    assert.match(decl.out, /KNOWN-BROKEN\s+unrepairable-one\b/,
      'the declared record must still be NAMED, not counted away');
    assert.match(decl.out, /residue of an interrupted trial/,
      'the stated reason must be printed -- a silent exception is what this must never become');
    assert.match(decl.out, /declared 2026-10-12/, 'the date it was declared must be printed');
    assert.match(decl.out, /NOT CLEAN/, 'it must say what it is');
    assert.doesNotMatch(decl.out, /OK: every record/,
      'a store holding a declared failure must NEVER print the clean banner -- that sentence is the whole point of this tool');
    assert.match(decl.out, /1 of them failed \(1 declared\)/,
      'the summary must attribute the failure to the declaration rather than losing count of it');

    // A declaration buys exactly ONE id, never a class of them: add a second broken record and the
    // run must fail again, naming the new one. A count or a wildcard would have absorbed it silently.
    writeFileSync(store, JSON.stringify({ admissions: [broken('unrepairable-one'), broken('newly-tampered-one')] }));
    const grown = run(store, exc);
    assert.equal(grown.code, 1, `a NEW undeclared failure must still fail while another record is declared:\n${grown.out}`);
    assert.match(grown.out, /BROKEN\s+newly-tampered-one\b/, 'the new failure must be named for what it is');
    assert.match(grown.out, /KNOWN-BROKEN\s+unrepairable-one\b/, 'and the declared one must still be reported');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a declaration that no longer describes reality is a hole, not a footnote', () => {
  // An exception nobody ever has to clean up is permanent, so every way a declaration can go stale
  // must exit 2 instead of quietly keeping the hole open. The "the record NOW verifies" branch cannot
  // be reached from here without minting a genuinely signed record -- that belongs to the admission
  // tests -- so it is pinned at the source level and labelled as the weaker evidence it is.
  const TOOL = join(ROOT, 'tools', 'verify-store.mjs');
  const run = (file, exc) => {
    const args = [TOOL, '--store', file, '--known-broken', exc];
    try {
      return { code: 0, out: execFileSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT }) };
    } catch (err) {
      return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };
  const dir = mkdtempSync(join(tmpdir(), 'ac-vstore-stale-'));
  try {
    const store = join(dir, 'admissions.json');
    const exc = join(dir, 'known-broken.json');
    writeFileSync(store, JSON.stringify({ admissions: [{ id: 'expired-one', status: 'expired' }] }));

    writeFileSync(exc, JSON.stringify({ knownBroken: [{ id: 'gone-one', reason: 'was broken once', declaredAt: '2026-10-12' }] }));
    const gone = run(store, exc);
    assert.equal(gone.code, 2, `a declaration for a record that is not here must be stale, not ignored:\n${gone.out}`);
    assert.match(gone.out, /STALE DECLARATION/, gone.out);
    assert.match(gone.out, /no record with this id exists in this store/, gone.out);

    writeFileSync(exc, JSON.stringify({ knownBroken: [{ id: 'expired-one', reason: 'was broken once', declaredAt: '2026-10-12' }] }));
    const inert = run(store, exc);
    assert.equal(inert.code, 2, `a declaration for a record that is not held to account must be stale:\n${inert.out}`);
    assert.match(inert.out, /not held to account/, inert.out);

    writeFileSync(exc, JSON.stringify({ knownBroken: [{ id: 'expired-one' }] }));
    const noReason = run(store, exc);
    assert.equal(noReason.code, 2, `an exception with no stated reason is a silencing, not a declaration:\n${noReason.out}`);
    assert.match(noReason.out, /no id or no reason/, noReason.out);

    writeFileSync(exc, '{ not json');
    const unreadable = run(store, exc);
    assert.equal(unreadable.code, 2, `a declarations file that cannot be read is not "no declarations":\n${unreadable.out}`);
    assert.match(unreadable.out, /not valid JSON/, unreadable.out);

    assert.match(SRC, /the record NOW verifies/,
      'the branch that catches a REPAIRED record must exist -- otherwise a stale exception could hide a recovery');
    assert.match(SRC, /process\.exit\(2\);\n\}\n\nif \(broken\)/,
      'stale declarations must exit 2 before any pass/fail counting');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
