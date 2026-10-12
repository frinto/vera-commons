// The invariant that keeps docs/TOOLS.md honest.
//
// WHY THIS EXISTS. For two rounds the answer to "which tools does nothing run?" had to be re-derived
// by hand, and the answer changed depending on how you counted: counting *mentions* anywhere found 11
// orphans; counting *invocations* found 28. Both numbers were produced by a script that looked
// authoritative. This test makes the question answerable once, in a file, and makes the answer fail
// loudly when it goes stale.
//
// The census is checked TWO ways, because either one alone can pass while the other is wrong:
//   - forward: every tools/*.mjs on disk appears in the document (nothing sneaks in unremarked)
//   - backward: every entry in the document names a file that exists (nothing is documented that is gone)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCensus, renderCensus } from '../tools/tool-census.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = join(ROOT, 'docs', 'TOOLS.md');

test('docs/TOOLS.md matches a fresh regeneration (it cannot go stale)', () => {
  const onDisk = readFileSync(DOC, 'utf8');
  const fresh = renderCensus(buildCensus());
  if (onDisk !== fresh) {
    const a = onDisk.split('\n'), b = fresh.split('\n');
    const firstDiff = a.findIndex((l, i) => l !== b[i]);
    assert.fail(`docs/TOOLS.md is stale at line ${firstDiff + 1}.\n`
      + `  on disk: ${a[firstDiff]}\n  fresh  : ${b[firstDiff]}\n`
      + 'Run: node tools/tool-census.mjs --write');
  }
});

test('every tool on disk is accounted for, and nothing is documented that does not exist', () => {
  // Read the DOCUMENT's rows, not buildCensus(). The first version of this test compared
  // buildCensus() against readdirSync(tools/) -- but buildCensus() builds its rows FROM tools/, so it
  // was comparing the disk with itself and passed for any newly added file. A red arm that dropped a
  // new tool into tools/ showed the assertion could not fail. The invariant is about the document.
  const doc = readFileSync(DOC, 'utf8');
  const documented = [...doc.matchAll(/^\| `([^`]+\.mjs)` \|/gm)].map(m => m[1]).sort();
  const onDisk = readdirSync(join(ROOT, 'tools')).filter(f => f.endsWith('.mjs')).sort();

  const undocumented = onDisk.filter(n => !documented.includes(n));
  assert.deepEqual(undocumented, [],
    `these tools exist but appear nowhere in docs/TOOLS.md: ${undocumented.join(', ')}`);
  const phantom = documented.filter(n => !onDisk.includes(n));
  assert.deepEqual(phantom, [],
    `docs/TOOLS.md documents tools that are not on disk: ${phantom.join(', ')}`);
  const dupes = documented.filter((n, i) => documented.indexOf(n) !== i);
  assert.deepEqual([...new Set(dupes)], [],
    `these tools appear more than once in the census, which double-counts them: ${[...new Set(dupes)].join(', ')}`);

  // And separately, the source files themselves must explain what they are.
  const rows = buildCensus();

  // A tool with no header comment cannot be judged by a reader, and every consumer of this document
  // (including the next round's author) has to open the source to find out what it is.
  //
  // HISTORY, kept because it is the reason this list is empty: the first census run reported 16
  // headerless tools. All 15 of the difference were files starting with `#!/usr/bin/env node` -- the
  // extractor treated the shebang as the end of the header and never read line 2. The number was a
  // property of the measuring tool, not of the repository, and it would have been committed as a fact
  // about the codebase. Any name added here must be checked by opening the file first.
  const KNOWN_HEADERLESS = [];
  const headerless = rows.filter(r => !r.purpose).map(r => r.name);
  const newlyHeaderless = headerless.filter(n => !KNOWN_HEADERLESS.includes(n));
  assert.deepEqual(newlyHeaderless, [],
    `these tools were added without a header comment, so the census can only report their name: ${newlyHeaderless.join(', ')}`);
  const fixed = KNOWN_HEADERLESS.filter(n => !headerless.includes(n));
  assert.deepEqual(fixed, [],
    `these tools now HAVE a header comment -- remove them from KNOWN_HEADERLESS so the debt list stays true `
    + `(remaining debt: ${headerless.length}): ${fixed.join(', ')}`);

  // Both sections must exist even when one of them is empty: a missing "Unwired" heading would make
  // the document silently claim everything is wired.
  assert.match(doc, /^## Wired \(\d+\)/m, 'the Wired section heading disappeared');
  assert.match(doc, /^## Unwired \(\d+\)/m, 'the Unwired section heading disappeared');
});

test('the census sees invocations from .ps1 callers, not just from JavaScript', () => {
  // Regression pin for the bug the first census run had: the corpus was built from .mjs/.js/.json/
  // .md/.html only, so tools invoked from verify-worker-local.ps1 were reported UNWIRED. That is the
  // dangerous direction of error -- the document asserted confidently that nothing ran them.
  const byName = Object.fromEntries(buildCensus().map(r => [r.name, r]));
  for (const name of ['verify-feed.mjs', 'make-message.mjs']) {
    assert.ok(byName[name], `${name} vanished from the census entirely`);
    assert.equal(byName[name].wired, true,
      `${name} is invoked by verify-worker-local.ps1 but the census calls it unwired -- `
      + 'the corpus has stopped reading a file type it needs');
  }
});

test('a shebang does not hide a header comment', () => {
  // Regression pin: the first extractor stopped at line 1 of any executable script, so every tool
  // starting with `#!/usr/bin/env node` was reported as having no header comment even when it had one.
  // verify-store.mjs was the instance that exposed it. The census must READ the file it describes.
  const byName = Object.fromEntries(buildCensus().map(r => [r.name, r]));
  assert.ok(byName['verify-store.mjs'], 'verify-store.mjs vanished from the census');
  assert.ok(byName['verify-store.mjs'].purpose,
    'verify-store.mjs has a header comment on line 2; reporting none means the extractor stopped at the shebang');
});

test('invocation detection sees execFileSync, the call this repository actually uses', () => {
  // Regression pin. The detector spelled out spawn|execFile|execSync|exec, and `execFileSync` matches
  // none of them -- `execFile` is followed by `Sync`, `exec` by `File`. tools/verify-relay-verdict.mjs
  // is spawned by tools/verify-relay-verdicts.mjs with execFileSync and was reported as invoked by
  // nothing. The answer here was known before the census ran, which is the only reason it was caught.
  const byName = Object.fromEntries(buildCensus().map(r => [r.name, r]));
  assert.equal(byName['verify-relay-verdict.mjs']?.wired, true,
    'verify-relay-verdict.mjs is spawned by verify-relay-verdicts.mjs; reporting it unwired means '
    + 'execFileSync is not being recognised as an invocation');
});

test('the census itself is wired, so the document cannot be orphaned by its own author', () => {
  const self = buildCensus().find(r => r.name === 'tool-census.mjs');
  assert.ok(self, 'tool-census.mjs is missing from its own census');
  assert.equal(self.wired, true,
    'nothing invokes tool-census.mjs: it must be reachable from package.json or a test, or the census '
    + 'is a document nobody can reproduce');
});
