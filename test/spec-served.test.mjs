/**
 * spec-served.test.mjs — the digest the relay publishes must be checkable from the wire.
 *
 * tools/verify-discovery.mjs asserts the happy path against the worker's own fetch handler.
 * This test covers the two ways that guarantee rots, both of them silent:
 *
 *   1. the embedded copy drifts from spec/COMMONS-SPEC.md, so the relay serves bytes that
 *      fail the very digest it publishes; and
 *   2. the spec file moves without worker/spec-constants.js moving — the same failure seen
 *      from the other end, where the relay advertises a digest of a document that no longer
 *      exists.
 *
 * Both are exercised by mutating the real files and restoring them byte-for-byte. A guard
 * that has only ever been run against a healthy tree is not known to be a guard, and this
 * repository has already shipped one detector defect (the census `execFileSync` miss) that
 * survived precisely because nobody asked it a question whose answer was known.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = join(ROOT, 'spec', 'COMMONS-SPEC.md');
const BUNDLE = join(ROOT, 'worker', 'spec-bundle.js');
const GENERATOR = join(ROOT, 'tools', 'embed-spec.mjs');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    const result = fn();
    // An async check body is silently vacuous: fn() returns a promise, the harness counts a
    // pass immediately, and the assertion inside runs later where nothing is watching. That
    // is the defect class this repository keeps re-learning, so it is refused at the harness
    // rather than left to reviewer attention.
    if (result && typeof result.then === 'function') {
      throw new Error('check body returned a promise — await the work before check(), or the assertion is vacuous');
    }
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const runGenerator = (args) =>
  spawnSync(process.execPath, [GENERATOR, ...args], { cwd: ROOT, encoding: 'utf8' });

const specOriginal = readFileSync(SPEC);
const bundleOriginal = readFileSync(BUNDLE);

// Awaited here rather than inside a check body, so that a failure to reach the handler is a
// loud crash at load time instead of a check that quietly passes.
const worker = (await import(pathToFileURL(join(ROOT, 'worker', 'worker.js')).href)).default;
const specResponse = await worker.fetch(new Request('https://relay.example/spec.md'), {});
const servedBody = Buffer.from(await specResponse.arrayBuffer());

// ---------------------------------------------------------------- the healthy tree

check('the embedded spec bundle is current', () => {
  const r = runGenerator(['--check']);
  assert(r.status === 0, `exit ${r.status}: ${(r.stderr || r.stdout).trim()}`);
});

check('the served bytes are the file, and the digest is a digest of them', () => {
  assert(servedBody.equals(specOriginal), 'served bytes differ from spec/COMMONS-SPEC.md');
  assert(
    specResponse.headers.get('x-ac-sha256') === sha(servedBody),
    'x-ac-sha256 disagrees with the body it was sent with',
  );
});

// ------------------------------------------------- mutation 1: the embedded copy drifts

check('a drifted embedded copy is caught, and the tree is restored', () => {
  try {
    writeFileSync(BUNDLE, Buffer.concat([bundleOriginal, Buffer.from('\n// drift\n')]));
    const r = runGenerator(['--check']);
    assert(r.status === 1, `expected exit 1 on a stale bundle, got ${r.status}`);
    assert(
      /STALE/.test(r.stderr || ''),
      `failed for an unexpected reason: ${(r.stderr || r.stdout).trim().slice(0, 200)}`,
    );
  } finally {
    writeFileSync(BUNDLE, bundleOriginal);
  }
  assert(sha(readFileSync(BUNDLE)) === sha(bundleOriginal), 'the bundle was not restored byte-for-byte');
});

// ---------------------------------------- mutation 2: the spec moves, the constants do not

check('a spec that no longer matches the advertised digest is refused, not embedded', () => {
  try {
    writeFileSync(SPEC, Buffer.concat([specOriginal, Buffer.from('\n<!-- drift -->\n')]));
    const r = runGenerator([]);
    assert(r.status === 1, `expected exit 1 when the spec drifts from SPEC_SHA256, got ${r.status}`);
    assert(
      /advertises/.test(r.stderr || ''),
      `failed for an unexpected reason: ${(r.stderr || r.stdout).trim().slice(0, 200)}`,
    );
    assert(
      sha(readFileSync(BUNDLE)) === sha(bundleOriginal),
      'the generator rewrote the bundle with bytes that fail the published digest',
    );
  } finally {
    writeFileSync(SPEC, specOriginal);
  }
  assert(sha(readFileSync(SPEC)) === sha(specOriginal), 'the spec was not restored byte-for-byte');
});

// A test that restores a frozen document must prove it restored the FREEZE too, not just the
// bytes it happened to read: this is the digest every other check in the repository quotes.
check('the frozen spec and its digest are intact after the mutations', () => {
  assert(sha(readFileSync(SPEC)) === sha(specOriginal), 'spec digest changed');
  const r = runGenerator(['--check']);
  assert(r.status === 0, `the tree is not healthy again: exit ${r.status} ${(r.stderr || '').trim()}`);
});

process.stdout.write(`\nspec-served.test.mjs: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
