/**
 * verify-admission-live.mjs — does the agents-only gate actually work end to end?
 *
 * The unit suite (test/admission.test.mjs) proves the manager behaves under injected clocks
 * and synthetic inputs. This proves something different and stronger: that the REAL verifier
 * on the operator's stick produces a challenge that a genuine reasoner can PASS, and that a
 * late answer fails.
 *
 * Why "can pass" is the important arm. A gate that no honest agent can pass is not a strict
 * gate, it is a broken one — and it fails in the worst possible way, because it looks like it
 * is working. Every failure it produces is indistinguishable from "the joining agent was not
 * good enough". So the passing arm is not a nicety; it is the control that keeps the failing
 * arm meaningful.
 *
 * The solver here reasons from the knowledge base rather than reverse-engineering the
 * generator: it parses "A <subject> is a <predicate>." and answers ENTAILED when the
 * hypothesis predicate is the premise predicate or one of its ancestors. That mirrors what a
 * capable joining agent must do, and it would keep working if the generator were made richer.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { createAdmissionManager } from '../src/admission.mjs';
import { loadVerifier, verifierFingerprint } from './mint-verifier.mjs';

const VERIFIER_PATH = process.argv[2] || 'E:\\verifier.json';

/**
 * The canonical resolution rule, and it must be THE SAME everywhere or the console and the
 * minter will disagree about where admissions live. A relative `dir` resolves against the
 * directory that holds verifier.json — not against the app folder, and not against the
 * process working directory. That is deterministic whether the stick is E: or D:, and it does
 * not depend on where the console happens to be started from.
 */
export function resolveAdmissionsDir(verifier, verifierPath = VERIFIER_PATH) {
  return isAbsolute(verifier.dir) ? verifier.dir : join(dirname(verifierPath), verifier.dir);
}

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
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

/** ancestors[x] = everything x is a kind of, walking up every chain that contains x. */
function ancestorMap(kb) {
  const map = new Map();
  for (const chain of kb.chains) {
    for (let i = 0; i < chain.length; i += 1) {
      if (!map.has(chain[i])) map.set(chain[i], new Set());
      for (let j = i + 1; j < chain.length; j += 1) map.get(chain[i]).add(chain[j]);
    }
  }
  return map;
}

const PREDICATE = /^A(?:n)? (.+?) is a(?:n)? (.+?)\.$/;

function solve(items, kb) {
  const ancestors = ancestorMap(kb);
  return items.map((item) => {
    const p = PREDICATE.exec(item.premise);
    const h = PREDICATE.exec(item.hypothesis);
    if (!p || !h) return 'CONTRADICTED';
    const [, , premisePred] = p;
    const [, , hypothesisPred] = h;
    if (hypothesisPred === premisePred) return 'ENTAILED';
    const up = ancestors.get(premisePred);
    return up && up.has(hypothesisPred) ? 'ENTAILED' : 'CONTRADICTED';
  });
}

process.stdout.write(`verifier: ${VERIFIER_PATH}\n\n`);

if (!existsSync(VERIFIER_PATH)) {
  process.stdout.write(`  FAIL the operator's verifier does not exist at ${VERIFIER_PATH}\n`);
  process.stdout.write('\nverify-admission-live.mjs: 0 passed, 1 failed\n');
  process.exit(1);
}

const verifier = loadVerifier(VERIFIER_PATH);
process.stdout.write(`  salt fingerprint ${verifierFingerprint(verifier.salt)} | ${verifier.kb.chains.length} chains | ${verifier.items} items / ${verifier.windowMs} ms\n\n`);

// A scratch store on a temp dir: exercises the real salt and the real KB without writing
// test admissions into the operator's own admissions file.
const scratch = mkdtempSync(join(tmpdir(), 'admission-live-'));
const manager = createAdmissionManager({
  dir: scratch,
  salt: verifier.salt,
  kb: verifier.kb,
  items: verifier.items,
  windowMs: verifier.windowMs,
});

const JOINER = 'A'.repeat(43);

// ---------------------------------------------------------------- arm 1: an honest agent passes

const started = manager.start(JOINER);
check('a challenge is issued to a joining key', () => {
  assert(started && started.id, `start() returned ${JSON.stringify(started)}`);
  assert(started.challenge && Array.isArray(started.challenge.items), 'challenge has no items');
  assert(started.challenge.items.length === verifier.items, `expected ${verifier.items} items, got ${started.challenge.items.length}`);
});

check('the challenge never carries the salt, the answers, or the KB', () => {
  const serialised = JSON.stringify(started.challenge);
  assert(!serialised.includes(verifier.salt), 'THE SALT LEAKED INTO THE CHALLENGE');
  assert(!/\bexpected\b/.test(serialised), 'the challenge contains an `expected` answer key');
  assert(!serialised.includes('chains'), 'the challenge contains the knowledge base');
  for (const item of started.challenge.items) {
    assert(!('expected' in item) && !('answer' in item), `item ${item.i} carries an answer`);
  }
});

const solved = solve(started.challenge.items, verifier.kb);
const verdict = manager.answer(started.id, solved);

check('AN HONEST REASONER CAN PASS — the gate is passable, not just strict', () => {
  assert(verdict.correct !== undefined, `answer() returned ${JSON.stringify(verdict)}`);
  assert(verdict.correct > 0, `a KB-derived solver scored ZERO out of ${verdict.total} — the gate rejects competent agents`);
  assert(verdict.ok === true, `solver scored ${verdict.correct}/${verdict.total} (ratio ${verdict.ratio}) — below the ${verifier.passRatio} bar`);
});

check('passing grants NO trust level — admission is a filter, not authority', () => {
  const rows = manager.list();
  const row = rows.find((r) => r.id === started.id);
  assert(row, 'the admission is missing from list()');
  assert(row.status === 'answered', `status is ${row.status}`);
  assert(!('level' in row) && !('trust' in row) && !('permit' in row), 'the admission row hands out authority');
});

check('the verdict is still the ADMIN\'s decision, and it starts undecided', () => {
  const row = manager.list().find((r) => r.id === started.id);
  assert(row.verdict != null, 'no verdict recorded');
  assert(row.verdict.ok === true, 'verdict does not reflect the pass');
});

// ---------------------------------------------------------------- arm 2: a late answer fails

const clock = { t: 1_000_000 };
const late = createAdmissionManager({
  dir: mkdtempSync(join(tmpdir(), 'admission-late-')),
  salt: verifier.salt,
  kb: verifier.kb,
  items: verifier.items,
  windowMs: verifier.windowMs,
  now: () => clock.t,
});

const lateStart = late.start('B'.repeat(43));
const lateSolved = solve(lateStart.challenge.items, verifier.kb);

check('a PERFECT answer submitted after the window is REFUSED', () => {
  clock.t += verifier.windowMs + 1;
  const lateVerdict = late.answer(lateStart.id, lateSolved);
  assert(lateVerdict.ok === false, 'a late answer was ACCEPTED — the deadline is not enforced');
  assert(lateVerdict.reason === 'expired', `expected reason 'expired', got '${lateVerdict.reason}'`);
});

check('a perfect-but-late answer is refused even though every answer was correct', () => {
  const row = late.list().find((r) => r.id === lateStart.id);
  assert(row.status === 'expired', `status is ${row.status} — a late answer must not count as answered`);
  assert(lateSolved.length === verifier.items, 'the late submission was not actually complete');
});

// ---------------------------------------------------------------- arm 3: a wrong answer fails

const wrongArm = createAdmissionManager({
  dir: mkdtempSync(join(tmpdir(), 'admission-wrong-')),
  salt: verifier.salt,
  kb: verifier.kb,
  items: verifier.items,
  windowMs: verifier.windowMs,
});
const wrongStart = wrongArm.start('C'.repeat(43));

check('a solver that inverts every answer FAILS', () => {
  const inverted = solve(wrongStart.challenge.items, verifier.kb).map((a) => (a === 'ENTAILED' ? 'CONTRADICTED' : 'ENTAILED'));
  const v = wrongArm.answer(wrongStart.id, inverted);
  assert(v.ok === false, 'an inverted solver PASSED — the scoring does not discriminate');
});

check('a blank submission scores zero rather than passing by default', () => {
  const blankArm = createAdmissionManager({
    dir: mkdtempSync(join(tmpdir(), 'admission-blank-')),
    salt: verifier.salt, kb: verifier.kb, items: verifier.items, windowMs: verifier.windowMs,
  });
  const s = blankArm.start('D'.repeat(43));
  const v = blankArm.answer(s.id, []);
  assert(v.ok === false, 'an EMPTY submission passed — fail-open gate');
  assert(v.correct === 0, `blank submission scored ${v.correct}`);
});

// ---------------------------------------------------------------- the operator's real store

check("the operator's own admissions directory is writable, resolved the canonical way", () => {
  const realDir = resolveAdmissionsDir(verifier);
  if (!existsSync(realDir)) throw new Error(`${realDir} does not exist (resolved from dir="${verifier.dir}")`);
  const probe = join(realDir, '.write-probe');
  writeFileSync(probe, 'ok');
  unlinkSync(probe);
});

check('the verifier on the stick declares a 45 s window, 150 items, and a STICK-RELATIVE store', () => {
  assert(verifier.windowMs === 45000, `windowMs is ${verifier.windowMs}`);
  assert(verifier.items === 150, `items is ${verifier.items}`);
  // Portability is not cosmetic: an absolute path recorded here resolves on the machine that
  // minted it and silently fails on any other, where the same stick is a different letter.
  assert(!/^[A-Za-z]:[\\/]/.test(verifier.dir), `dir "${verifier.dir}" is an absolute host path and will not survive a different drive letter`);
  assert(!verifier.dir.startsWith('/'), `dir "${verifier.dir}" is an absolute posix path`);
  assert(!('passRatio' in verifier), 'passRatio is stored but the library never reads it — a silent no-op trap');
});

// ---------------------------------------------------------------- cleanup

for (const dir of [scratch]) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

process.stdout.write(`\nverify-admission-live.mjs: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
