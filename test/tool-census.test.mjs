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
import { buildCensus, renderCensus, wiresTool, inTrialRegistry } from '../tools/tool-census.mjs';

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

test('an invocation that spans lines, or goes through a variable, is still an invocation', () => {
  // FIFTH instance of one family. The detector required the spawn token and the file name on the SAME
  // line, so it reported as "nothing invokes it" two tools that run on every `npm test`:
  // verify-admission.mjs -- spawned by tools/verify-store.mjs, whose call spans two lines -- and
  // verify-seed.mjs, spawned by test/verify-seed.test.mjs through a `const TOOL`. The dangerous
  // direction of error is this one: the document asserted confidently that nothing ran a verifier.
  const byName = Object.fromEntries(buildCensus().map(r => [r.name, r]));
  for (const name of ['verify-admission.mjs', 'verify-seed.mjs']) {
    assert.ok(byName[name], `${name} vanished from the census entirely`);
    assert.equal(byName[name].wired, true,
      `${name} IS invoked by this repository; reporting it unwired is a false "nothing runs this" `
      + 'about a real verifier');
  }
});

test('the invocation detector can say NO -- driven by synthetic sources, not by this repository', () => {
  // A detector whose only inputs are this repository's own files cannot be shown failing, so these
  // inputs have answers known before the detector ran. The spawn token is assembled at run time
  // because a literal one would be read by this very detector -- and this file necessarily contains
  // the tool names below, in the assertion messages.
  const SPAWN = 'exec' + 'FileSync' + '(';
  const multiLine = [
    SPAWN + 'process.execPath, [',
    "  join(HERE, 'verify-admission.mjs'),",
    "  '--id', id], { stdio: 'pipe' });",
  ].join('\n');
  assert.equal(wiresTool(multiLine, 'verify-admission.mjs'), true,
    'a call split across lines is an invocation -- this is tools/verify-store.mjs\'s shape');

  const viaVariable = [
    "const TOOL = join(HERE, '../tools/verify-seed.mjs');",
    ...Array(20).fill('// filler, so the call sits far from the assignment'),
    SPAWN + 'process.execPath, [TOOL, ...args]);',
  ].join('\n');
  assert.equal(wiresTool(viaVariable, 'verify-seed.mjs'), true,
    'a path held in a variable and passed to a spawner is an invocation -- the test\'s own shape');

  const commentedOut = multiLine.split('\n').map(l => '// ' + l).join('\n');
  assert.equal(wiresTool(commentedOut, 'verify-admission.mjs'), false,
    'a commented-out call runs nothing, however many spawn tokens its text contains');

  assert.equal(wiresTool(multiLine, 'verify-admission.mjs', 'docs/DECISION-note.md'), false,
    'a markdown document RECORDS an invocation, it does not perform one -- two trial tools were '
    + 'briefly reported wired because a decision note listed them in a table');
  assert.equal(wiresTool(multiLine, 'verify-admission.mjs', 'docs/TOOLS.md'), false,
    'the generated census document must never wire the tools it describes, or every row becomes wired');

  const importOnly = "import { triage } from '../tools/admission-queue-review.mjs';\nconsole.log(triage);";
  assert.equal(wiresTool(importOnly, 'admission-queue-review.mjs', 'test/admission-queue-review.test.mjs'), true,
    'a test that IMPORTS a tool runs its code; requiring a spawn call here unwired two real tools');

  const proseOnly = "// tools/verify-admission.mjs is a real verifier\nconsole.log('see verify-admission.mjs');";
  assert.equal(wiresTool(proseOnly, 'verify-admission.mjs'), false,
    'a name in prose, in a file with no spawn call at all, is not an invocation');

  const farMention = [
    SPAWN + "process.execPath, ['node'], { stdio: 'pipe' });",
    ...Array(30).fill('const filler = 1;'),
    "console.log('verify-admission.mjs is not run from here');",
  ].join('\n');
  assert.equal(wiresTool(farMention, 'verify-admission.mjs'), false,
    'a name 30 lines away from any spawn call is a mention, not an invocation');
});

test('the trial registry counts as a caller -- the entry AND the call that consumes it', () => {
  // tools/trial-all.mjs holds `{ file: 'tools/x.mjs' }` entries and runs each one through a path built
  // from the entry, so a listed tool IS invoked even though its path and the call never share a line.
  // Controls use names that do not exist on disk, and the call token is assembled at run time: this
  // file necessarily names real tools, and a literal call here would wire them from their own test.
  const SPAWN_SYNC = 'spawn' + 'Sync';
  const runs = `const REGISTRY = [{ id: 'x', file: 'tools/example-tool.mjs' }];\n${SPAWN_SYNC}(process.execPath, [abs]);`;
  assert.equal(inTrialRegistry(runs, 'example-tool.mjs'), true,
    'an entry plus the call that runs it is a caller');
  assert.equal(inTrialRegistry(runs, 'other-tool.mjs'), false,
    'a tool the registry does not list is not wired by it');
  assert.equal(inTrialRegistry('| `example-tool.mjs` | a table row in a note |\n' + SPAWN_SYNC + '(process.execPath, [abs]);', 'example-tool.mjs'), false,
    'a prose row about a trial is not a registry entry');
  assert.equal(inTrialRegistry("const REGISTRY = [{ id: 'x', file: 'tools/example-tool.mjs' }];", 'example-tool.mjs'), false,
    'an entry in a file that never runs anything is not a caller');

  // And the real registry: a tool it lists must never be reported as unwired.
  const byName = Object.fromEntries(buildCensus().map(r => [r.name, r]));
  assert.equal(byName['stranger-journey.mjs']?.wired, true,
    'stranger-journey.mjs is entry one of the trial registry; reporting it unwired is the false '
    + '"nothing runs this" this census exists to prevent');
});
