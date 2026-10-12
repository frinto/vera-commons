/**
 * Controls for the detector that answers "is there a SECOND COPY of this project on the stick?".
 *
 * Why it exists: `deploy-stick.mjs --check` compared only the files it deploys, so a tree it never
 * wrote was invisible to it -- and a console started from exactly such a tree (E:\AgentCommons\)
 * held 127.0.0.1:7788 for 7h19m on 2026-10-12. Because Windows lets two processes hold one port, a
 * trial could have been answered by that build while every check reported the deployment healthy.
 *
 * A detector is only worth its output if it can be shown FAILING and shown STAYING SILENT, so both
 * arms are here: it must name a second copy in either layout, and it must NOT name the deployment's
 * own folders nor an unrelated Node application of the operator's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findStrayCopies, STRAY_SHAPE, STRAY_RUNNABLE } from '../tools/stick-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(ROOT, 'tools', 'deploy-stick.mjs');
const SCANNER = join(ROOT, 'tools', 'stick-scan.mjs');
const SRC = readFileSync(TOOL, 'utf8');
const SCAN_SRC = readFileSync(SCANNER, 'utf8');

// The deployed layout, exactly as deploy-stick.mjs declares it, plus the build-output rule.
const OPTS = { deployedTop: ['console', 'src', 'tools', 'docs', 'spec', 'test', 'worker', 'data'], skipDirs: ['.wrangler', 'node_modules'] };

const file = (p, body = '// fixture\n') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };
const names = (root) => findStrayCopies(root, OPTS).map((s) => s.name);

function fixture(build) {
  const dir = mkdtempSync(join(tmpdir(), 'stick-scan-'));
  build(dir);
  return dir;
}
function withFixture(build, fn) {
  const dir = fixture(build);
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the deployment\'s own layout is not reported as a second copy', () => {
  withFixture((d) => {
    // The deployed layout: the shape marker lives at the ROOT (never scanned) and console/ is the
    // tool's own folder, so the volume carries this project's files and no second copy of it.
    file(join(d, 'src', 'admission.mjs'));
    file(join(d, 'console', 'app.mjs'));
    file(join(d, 'console', 'src', 'admission.mjs'));
    file(join(d, 'package.json'), '{}\n');
    file(join(d, 'tools', 'x.mjs'));
    file(join(d, 'data', 'admissions', 'admissions.json'), '{}\n');
    file(join(d, 'START-HERE.cmd'), '@echo off\n');
    file(join(d, 'user-admin.json'), '{}\n');   // a secret at the root: not a directory, never a copy
  }, (d) => {
    assert.deepEqual(names(d), [], 'the deployment\'s own folders must not be reported');
  });
});

test('a stale second copy in the OLD layout is named, with its evidence', () => {
  withFixture((d) => {
    file(join(d, 'console', 'app.mjs'));
    file(join(d, 'AgentCommons', 'app.mjs'), '// stale\n');
    file(join(d, 'AgentCommons', 'src', 'admission.mjs'), '// stale\n');
    file(join(d, 'AgentCommons', 'START-HERE.cmd.disabled'), '@echo off\n');
  }, (d) => {
    const found = findStrayCopies(d, OPTS);
    assert.deepEqual(found.map((s) => s.name), ['AgentCommons'], 'the second copy must be named');
    assert.deepEqual(found[0].marks, [STRAY_SHAPE, 'app.mjs'],
      'the finding must carry WHICH markers proved it, so the operator can check the claim');
  });
});

test('NEGATIVE CONTROL: an unrelated Node app is not called a copy of this project', () => {
  withFixture((d) => {
    // This is the false positive that would make the detector useless: the operator's own code.
    // app.mjs + package.json + src/, but NOT this project's src/admission.mjs.
    file(join(d, 'mysite', 'app.mjs'));
    file(join(d, 'mysite', 'package.json'), '{}\n');
    file(join(d, 'mysite', 'src', 'index.mjs'));
  }, (d) => {
    assert.deepEqual(names(d), [], 'somebody else\'s application must not be reported as our copy');
  });
});

test('NEGATIVE CONTROL: a folder with the shape but no entry point cannot serve, so it is not reported', () => {
  withFixture((d) => {
    file(join(d, 'backup', 'src', 'admission.mjs'));
    file(join(d, 'notes', 'readme.txt'), 'old\n');
  }, (d) => {
    assert.deepEqual(names(d), [], 'a copy that cannot start a console is not a stale console');
  });
});

test('a second copy in the NEW nested layout is named too', () => {
  withFixture((d) => {
    file(join(d, 'Old', 'console', 'app.mjs'));
    file(join(d, 'Old', 'src', 'admission.mjs'));
  }, (d) => {
    assert.deepEqual(names(d), ['Old'], 'the newer layout left behind must be named as well');
  });
});

test('the deployment\'s own top-level names are skipped BY RULE, not by luck', () => {
  withFixture((d) => {
    // console/ carries app.mjs AND console/src/admission.mjs -- the full shape, inside a name the
    // deploy tool owns. It is skipped because it is declared, not because it happens to be empty.
    file(join(d, 'console', 'app.mjs'));
    file(join(d, 'console', 'src', 'admission.mjs'));
  }, (d) => {
    assert.deepEqual(names(d), []);
    assert.ok(OPTS.deployedTop.includes('console'), 'and the skip list is the deploy manifest\'s own');
  });
});

test('the detector cannot write: no write API appears in its source', () => {
  for (const api of ['writeFileSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'appendFileSync']) {
    assert.ok(!SCAN_SRC.includes(api), 'stick-scan.mjs must not call ' + api + ' -- deciding a tree is the operator\'s call');
  }
  assert.ok(!/\bprocess\.exit\(/.test(SCAN_SRC), 'the rule returns findings; the caller owns the verdict');
});

test('--check runs the scan before its early exit, and gives it its own exit code', () => {
  const scanAt = SRC.indexOf('// --- 2c.');
  const checkAt = SRC.indexOf('if (CHECK_ONLY) {');
  const preAt = SRC.indexOf('// --- 2b. THE PRECONDITION');
  assert.notEqual(scanAt, -1, 'the scan section must exist in the deploy tool');
  assert.ok(scanAt < checkAt, 'the scan must run BEFORE the --check early exit, or --check never answers it');
  assert.ok(checkAt < preAt, '--check must still exit before the precondition gate');
  // Distinct code, because the remedy differs from "the deployment drifted".
  assert.match(SRC, /^\/\/   4 {2}/m, 'the exit-code table must document code 4');
  assert.match(SRC, /process\.exit\(4\)/, 'the tool must actually exit 4 when a second copy is present');
  const checkBlock = SRC.slice(checkAt, preAt);
  assert.ok(checkBlock.includes('process.exit(4)'), '--check must exit 4 rather than reporting drift');
  assert.ok(checkBlock.indexOf('process.exit(1)') < checkBlock.indexOf('process.exit(4)'),
    'a drifted deployment (code 1) must outrank a second copy (code 4) when both are present');
  // The stray counter must be separate from `failures`, or code 1 and code 4 could not differ.
  assert.match(SRC, /let straysFound = 0;/);
  assert.ok(!/const stray = \(m\) => \{ failures\+\+/.test(SRC), 'a stray copy must NOT be counted as drift');
});

test('the rule the tool applies is this module\'s rule, not a second copy of it', () => {
  assert.match(SRC, /['"]\.\/stick-scan\.mjs['"]/, 'the deploy tool must import the shared rule');
  assert.ok(!SRC.includes("'src', 'admission.mjs'"), 'the marker must not be re-typed in the deploy tool');
  assert.deepEqual(STRAY_RUNNABLE, ['app.mjs', 'console/app.mjs', 'package.json']);
});
