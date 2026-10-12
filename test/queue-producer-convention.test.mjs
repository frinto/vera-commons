/**
 * THE MARKER CONVENTION IS ENFORCED HERE, NOT REMEMBERED.
 *
 * src/queue-classify.mjs sorts the operator's admission queue into TRIAL debris and REAL
 * applicants, and it fails toward the human: anything it cannot positively identify as a trial is
 * shown as a possible applicant. That judgement is only as good as the markers the WRITERS emit.
 * On 2026-10-12 the live queue held 22 pending requests and every one was this repository's own
 * debris -- 6 marked `[trial]`, 16 predating the convention and recognised only because
 * queue-classify.mjs carries their labels in LEGACY_TRIAL_NOTES. The sixteen were a recurrence,
 * not an accident: nothing in the chain failed when a generator wrote an unmarked request.
 *
 * This is that missing check. It enumerates the files that actually POST to /admission/request and
 * requires each to be one of exactly three things, each with a reason recorded in code:
 *
 *   MARKED   the file carries a `[trial] ` note, so the operator sees debris as debris.
 *   ENTRANT  the applicant's own path. It MUST NOT be marked: the note is the applicant's free
 *            text, and marking it would show a genuine entrant as debris -- the expensive
 *            direction of error, and the reason both directions are pinned here, not just trials.
 *   LOCAL    it writes into an in-process or loopback relay (evidence asserted, not asserted-in-
 *            prose: the file must actually drive worker.fetch() or a loopback host). Its queue is
 *            a fake KV, never the operator's, so a marker would be noise.
 *
 * Anything else FAILS. Two false-positive classes are excluded on purpose, because a detector that
 * counts them would demand markers from documentation: a file that merely MENTIONS the route
 * (tools/mcp-trial.mjs asserts the join guide contains the string) is not a writer, and neither is
 * a code SAMPLE inside a string literal (test/admission-trial-order.test.mjs keeps one as fixture
 * data for its own static analysis). Both are pinned as negatives below.
 *
 * The direction of error for THIS check is deliberate and it is the cheap one: a new writer that
 * this file misreads as live-facing must be classified, which costs one allow-list line; a writer
 * it misses could put an unmarked request in front of the human admin. Static checks may cry wolf
 * cheaply; they may not stay quiet cheaply.
 *
 * Zero dependencies. Node 24. Run: node test/queue-producer-convention.test.mjs
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { classifyNote, TRIAL, LEGACY_TRIAL_NOTES } from '../src/queue-classify.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let failures = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` -- ${detail}`}`);
}

/** A real POST to the join endpoint: a fetch or call whose argument is the join route itself. */
const POST_CALL = /(?:fetch|call)\(\s*(?:[A-Za-z_$][\w$]*\s*\+\s*)?'\/admission\/request'/;

/** The applicant path. Marking it would bin real applicants. */
const ENTRANT_PRODUCERS = {
  'tools/join-apply.mjs':
    'the applicant path: its note is the applicant\'s own words (--note), so a marker here would make a genuine entrant look like debris and it would never be reviewed',
};

/** Writers whose queue is a fake KV inside a test process, never the operator's. */
const LOCAL_PRODUCERS = {
  'test/admission-flow.test.mjs':
    'drives worker.fetch() against a synthetic host with an injected kv, so its requests land in a fake store',
};

function walkMjs(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkMjs(path, out);
    else if (entry.name.endsWith('.mjs')) out.push(path);
  }
  return out;
}

/**
 * Every file under `root` that POSTs a join request. Pure and reusable: the fixture control below
 * runs through THIS function, so both verdicts are exercised by the same code the real tree uses.
 */
export function producersIn(root) {
  const producers = [];
  for (const file of walkMjs(root)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const calls = lines.filter((line) => {
      if (!POST_CALL.test(line)) return false;
      const first = line.trimStart()[0];
      return !(first === "'" || first === '"' || first === '`'); // a code SAMPLE, not a call
    });
    if (calls.length === 0) continue;
    const text = lines.join('\n');
    producers.push({
      rel: relative(root, file).replace(/\\/g, '/'),
      marked: /['"`]\[trial\] /.test(text),
      localEvidence: /worker\.fetch\(|127\.0\.0\.1|localhost/.test(text),
    });
  }
  return producers.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Classify every producer. Returns data; deciding what is acceptable is the caller's job. */
export function judge(producers) {
  const trials = [], entrants = [], locals = [], violations = [], badEvidence = [];
  for (const p of producers) {
    if (p.marked) {
      trials.push(p.rel);
      if (ENTRANT_PRODUCERS[p.rel]) violations.push(`${p.rel}: the applicant path is MARKED, so real applicants would show as debris`);
      continue;
    }
    if (ENTRANT_PRODUCERS[p.rel]) { entrants.push(p.rel); continue; }
    if (LOCAL_PRODUCERS[p.rel]) {
      locals.push(p.rel);
      if (!p.localEvidence) badEvidence.push(`${p.rel}: claimed local-only but shows no in-process or loopback evidence`);
      continue;
    }
    violations.push(`${p.rel}: a queue writer that neither declares itself [trial] nor is an allow-listed applicant/local path`);
  }
  const stale = [...Object.keys(ENTRANT_PRODUCERS), ...Object.keys(LOCAL_PRODUCERS)]
    .filter((rel) => !producers.some((p) => p.rel === rel));
  // `stale` describes the REAL tree's allow-list, not the judgement: a fixture legitimately has none.
  return { ok: violations.length === 0 && badEvidence.length === 0, trials, entrants, locals, violations, badEvidence, stale };
}

console.log('queue producer convention');

// --- the real tree -------------------------------------------------------------------------------
const producers = producersIn(ROOT);
const verdict = judge(producers);
const names = producers.map((p) => p.rel);

check('producers are found at all (a detector that finds none proves nothing)', producers.length === 5, names.join(', '));
check('every queue producer is marked, the applicant path, or a local fake-KV writer', verdict.ok,
  [...verdict.violations, ...verdict.badEvidence].join(' | '));
check('no allow-list entry names a file that stopped being a producer', verdict.stale.length === 0, verdict.stale.join(', '));
check('three trials declare themselves', verdict.trials.length === 3 && verdict.trials.every((r) => /trial/.test(r)), verdict.trials.join(', '));
check('the applicant path is present and UNMARKED, so a real entrant classifies as REAL',
  verdict.entrants.length === 1 && verdict.entrants[0] === 'tools/join-apply.mjs', verdict.entrants.join(', '));
check('a local fake-KV writer is exempt, with its evidence asserted', verdict.locals.length === 1 && verdict.locals[0] === 'test/admission-flow.test.mjs', verdict.locals.join(', '));
check('NEGATIVE: tools/mcp-trial.mjs only MENTIONS the route in a guide assertion', !names.includes('tools/mcp-trial.mjs'));
check('NEGATIVE: test/admission-trial-order.test.mjs keeps a call-shaped STRING as fixture data', !names.includes('test/admission-trial-order.test.mjs'));
check('NEGATIVE: tools/admission-queue-review.mjs READS the queue', !names.includes('tools/admission-queue-review.mjs'));

// --- the classifier half: a marker must be POSITIVE, never absence of evidence --------------------
check('the [trial] marker classifies as TRIAL', classifyNote('[trial] anything').kind === TRIAL);
check('a MISSING note is REAL (a genuine entrant who followed the instructions)', classifyNote(undefined).kind !== TRIAL);
check('an EMPTY note is REAL', classifyNote('').kind !== TRIAL);
check('an applicant\'s own words are REAL', classifyNote('I run a small research agent; may I join?').kind !== TRIAL);
check('a note that merely CONTAINS the marker mid-sentence is REAL', classifyNote('see [trial] notes for my method').kind !== TRIAL);
check('every archived legacy label is still recognised as debris', LEGACY_TRIAL_NOTES.every((label) => classifyNote(label).kind === TRIAL), LEGACY_TRIAL_NOTES.join(', '));

// --- self-control: the detector must FAIL on an unmarked writer, or it is a rubber stamp ---------
const fixture = mkdtempSync(join(tmpdir(), 'queue-producer-'));
try {
  mkdirSync(join(fixture, 'tools'));
  writeFileSync(join(fixture, 'tools', 'marked.mjs'),
    "const b = { note: '[trial] fixture trial' };\nawait call('/admission/request', { method: 'POST', body: b });\n");
  writeFileSync(join(fixture, 'tools', 'silent.mjs'),
    "const b = { note: 'fixture trial' };\nawait call('/admission/request', { method: 'POST', body: b });\n");
  writeFileSync(join(fixture, 'tools', 'mentions.mjs'),
    "check('the guide names the route', guide.includes('/admission/request'));\n");
  writeFileSync(join(fixture, 'tools', 'sample.mjs'),
    'const fixture = [\n  "await call(\'/admission/request\', { body });",\n];\n');

  const broken = judge(producersIn(join(fixture, 'tools')));
  check('CONTROL: an unmarked writer FAILS the check', broken.ok === false && broken.violations.some((v) => v.startsWith('silent.mjs')), JSON.stringify(broken.violations));
  check('CONTROL: the marked writer is still counted as a trial', broken.trials.includes('marked.mjs'));
  check('CONTROL: a file that only mentions the route is not a producer', !producersIn(join(fixture, 'tools')).some((p) => p.rel === 'mentions.mjs'));
  check('CONTROL: a call-shaped string literal is not a producer', !producersIn(join(fixture, 'tools')).some((p) => p.rel === 'sample.mjs'));
  check('CONTROL: a stale allow-list entry is reported', broken.stale.length === 2, broken.stale.join(', '));

  writeFileSync(join(fixture, 'tools', 'silent.mjs'),
    "const b = { note: '[trial] fixture trial, fixed' };\nawait call('/admission/request', { method: 'POST', body: b });\n");
  const fixed = judge(producersIn(join(fixture, 'tools')));
  check('CONTROL: both verdicts are reachable -- the same fixture now PASSES', fixed.ok === true, JSON.stringify(fixed.violations));
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log(failures === 0 ? 'queue producer convention: all checks passed' : `queue producer convention: ${failures} FAILED`);
assert.equal(failures, 0);
