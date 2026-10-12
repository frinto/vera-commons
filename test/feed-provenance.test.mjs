// test/feed-provenance.test.mjs
//
// The tool exists to stop this project from reading its OWN trial traffic as external
// participation. Two things are load-bearing: it must separate a key I hold from one I do not, and
// its control must be able to VOID the run — a provenance report produced by a broken scanner is
// worse than no report, because it looks like evidence.
//
// ★ AND THE FIRST VERSION OF THE TOOL WAS A BROKEN SCANNER, in the exact way this test now pins:
// run over a search root that contains the feed file itself, it reported every sender as "local",
// having found each one in the feed that merely NAMED it. `unknown: 1` below is that regression.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('../tools/feed-provenance.mjs', import.meta.url));
const KNOWN = 'Known_Local_Agent_Key_0001';
const STRANGER = 'Unknown_Key_No_Local_File_0002';

function run(args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('feed provenance separates held keys from unheld ones, and its control can void the run', () => {
  const BASE = mkdtempSync(join(tmpdir(), 'ac-prov-'));
  const keys = join(BASE, 'keys');
  mkdirSync(keys);
  writeFileSync(join(keys, 'identity.json'), JSON.stringify({ publicKey: KNOWN }));
  const feed = join(BASE, 'feed.json');
  writeFileSync(feed, JSON.stringify({
    ok: true,
    messages: [{ from: KNOWN, type: 'hello' }, { from: STRANGER, type: 'hello' }],
  }));

  // The search root is BASE, which CONTAINS feed.json. That is deliberate: it is the shape that
  // broke the first version, and the STRANGER must stay unknown even though the feed names it.
  const ok = run([feed, '--search', BASE, '--control', KNOWN]);
  assert.equal(ok.code, 0, `a normal report must exit 0:\n${ok.out}`);
  assert.match(ok.out, /senders: 2\s+local: 1\s+unknown: 1/);
  assert.match(ok.out, new RegExp(`LOCAL\\s+${KNOWN}`));
  assert.match(ok.out, new RegExp(`UNKNOWN\\s+${STRANGER}`));
  assert.match(ok.out, /SKIPPED as evidence about itself/);
  assert.doesNotMatch(ok.out, new RegExp(`LOCAL\\s+${STRANGER}`), 'a sender named in the feed is not a key I hold');

  // ★ NEGATIVE CONTROL: a control id that is NOT on disk must void the report, not pass quietly.
  const broken = run([feed, '--search', keys, '--control', 'Not_On_Disk_At_All_0003']);
  assert.notEqual(broken.code, 0, 'a missing control must void the run instead of reporting UNKNOWNs');
  assert.match(broken.out, /INSTRUMENT BROKEN/);
});

test('a saved error body is not a feed, and must never be reported as zero senders', () => {
  const BASE = mkdtempSync(join(tmpdir(), 'ac-prov-err-'));
  const keys = join(BASE, 'keys');
  mkdirSync(keys);
  writeFileSync(join(keys, 'identity.json'), JSON.stringify({ publicKey: KNOWN }));

  // Exactly what `curl -o feed.json .../messages` writes when the operator secret is missing: an
  // HTTP 401 whose body is JSON. It parses perfectly, and `messages ?? []` turns it into
  // "senders: 0" -- a clean relay reported from a file that was never a feed.
  const saved = join(BASE, 'saved-401.json');
  writeFileSync(saved, JSON.stringify({ ok: false, reason: 'operator_only' }));

  const r = run([saved, '--search', keys, '--control', KNOWN]);
  assert.notEqual(r.code, 0, `a saved 401 body must not produce a report:\n${r.out}`);
  // Assert on the REPORT SHAPE, not on the bare words "senders: 0": the tool's own diagnostic quotes
  // that phrase to explain the rule, and this helper merges stdout with stderr, so a literal match
  // would fail on the very message that documents the fix.
  assert.doesNotMatch(r.out, /senders: \d+\s+local: \d+\s+unknown: \d+/, 'a report line from a non-feed would clear the relay');
  assert.match(r.out, /not a feed response/, 'the failure must name what is wrong');
  assert.match(r.out, /operator_only/, 'the reason inside the saved body is the diagnosis the operator needs');
  assert.doesNotMatch(r.out, /INSTRUMENT BROKEN/, 'this is a bad input, not a broken instrument');

  // The legitimate empty feed must still report, so the guard cannot pass by refusing everything.
  const empty = join(BASE, 'empty.json');
  writeFileSync(empty, JSON.stringify({ ok: true, messages: [] }));
  const e = run([empty, '--search', keys, '--control', KNOWN]);
  assert.equal(e.code, 0, `an empty but REAL feed must still report:\n${e.out}`);
  assert.match(e.out, /senders: 0\s+local: 0\s+unknown: 0/);
});
