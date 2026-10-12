// The admission queue classifier — tested where being wrong is expensive.
//
// The asymmetry is the whole point, and it is why the negative controls here are written the way
// they are. Calling a real applicant "trial debris" means they are never admitted and nobody ever
// notices. Calling trial debris a "possible applicant" costs a human ten seconds. So every test
// below asks the same question in a different way: can a genuine applicant be sorted into the bin?
//
// The dangerous inputs are the honest ones -- a real joiner following the door's instructions
// writes no note at all, or writes something in their own words. None of those may be classified
// as ours.

import { classifyNote, triage, LEGACY_TRIAL_NOTES, TRIAL, REAL } from '../tools/admission-queue-review.mjs';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}

console.log('admission queue triage');

// --- 1. what a REAL applicant looks like -------------------------------------------------------
// This is the direction that must never be wrong.
check('an entry with NO note is a real applicant', classifyNote(null).kind === REAL, classifyNote(null).kind);
check('an empty note is a real applicant', classifyNote('').kind === REAL, classifyNote('').kind);
check('whitespace-only note is a real applicant', classifyNote('   ').kind === REAL, classifyNote('   ').kind);
check('a note in the applicant\'s own words is real', classifyNote('I am a research agent, may I join?').kind === REAL);
check('a note that merely CONTAINS a trial word is real', classifyNote('I ran a trial of my own harness').kind === REAL,
  'substring matching would have binned this one');
check('a note mentioning "bridge trial" inside a sentence is real',
  classifyNote('hello, I am the console bridge trial maintainer').kind === REAL,
  'a real applicant who happens to describe our words must still be seen');
check('a differently-cased legacy label is real', classifyNote('Joiner-Path-Trial').kind === REAL,
  'only the exact recorded string is ours');
check('an undefined note is a real applicant', classifyNote(undefined).kind === REAL);

// --- 2. what OUR debris looks like -------------------------------------------------------------
check('the [trial] marker is recognised', classifyNote('[trial] joiner-path-trial').kind === TRIAL);
check('the marker is case-insensitive', classifyNote('[TRIAL] whatever').kind === TRIAL);
check('leading whitespace before the marker is tolerated', classifyNote('  [trial] x').kind === TRIAL);
for (const legacy of LEGACY_TRIAL_NOTES) {
  check(`legacy label is recognised: ${legacy}`, classifyNote(legacy).kind === TRIAL, classifyNote(legacy).kind);
}

// --- 3. the whole-queue verdict -----------------------------------------------------------------
{
  const q = triage([
    { requestId: 'a', note: 'joiner-path-trial', at: 1 },
    { requestId: 'b', note: null, at: 2 },
    { requestId: 'c', note: '[trial] operator-command-trial', at: 3 },
  ]);
  check('the queue is split correctly', q.trials.length === 2 && q.real.length === 1,
    `trials=${q.trials.length} real=${q.real.length}`);
  check('the real applicant is the one with no note', q.real[0].requestId === 'b');
  check('every row carries a reason', q.rows.every((r) => typeof r.why === 'string' && r.why.length > 0));
}

// --- 4. an empty queue is not an error, but must be distinguishable from a failed read ---------
{
  const q = triage([]);
  check('an empty queue triages to zero of each', q.trials.length === 0 && q.real.length === 0);
}

// --- 5. NEGATIVE CONTROL: the classifier must be able to say "real" at all ---------------------
// If classifyNote returned TRIAL unconditionally, every assertion in section 1 would have caught
// it -- but this states the requirement directly, so the intent survives future edits.
{
  const kinds = new Set([classifyNote(null).kind, classifyNote('[trial] x').kind]);
  check('NEGATIVE CONTROL: both verdicts are reachable', kinds.size === 2, `saw ${[...kinds].join(', ')}`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
