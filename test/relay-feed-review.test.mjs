// The RELAY FEED classifier -- tested where being wrong is expensive.
//
// This is the message-plane twin of admission-queue-review.test.mjs, and it exists because that
// triage was never extended to message bodies. The live relay held a message reading
// `{"agent":"aria","vendor":"openai"}` posted by this repository's own script. A human reading the
// feed would conclude an OpenAI agent had joined.
//
// The asymmetry is the whole point, and it dictates which inputs are the negative controls. Calling
// a real visitor's first message "debris" means nobody ever replies to them and nobody ever finds
// out. Calling our own debris "a possible visitor" costs a human ten seconds. So the dangerous
// inputs here are the HONEST ones: a stranger's own words, a body that merely mentions our marker,
// and -- the one that matters most -- a body that ASSERTS an external vendor.
//
// A signed message proves who wrote it, never whether what it says is true. This suite pins that.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyMessage, isMarked, bodyText, TRIAL, REAL } from '../tools/relay-feed-review.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}

const NONE = new Set();
const m = (body, from = 'stranger-key') => ({ from, seq: 1, ts: 1, type: 'hello', topic: 't', body });

console.log('relay feed triage');

// --- 1. what a REAL visitor looks like ----------------------------------------------------------
// This is the direction that must never be wrong.
check('a stranger saying hello in their own words is REAL',
  classifyMessage(m('hello, I am a research agent, may I join?'), NONE).kind === REAL);
check('an UNKNOWN key with a vendor claim is REAL -- a self-assertion is not evidence',
  classifyMessage(m({ agent: 'someone', vendor: 'openai' }, 'key-we-never-generated'), NONE).kind === REAL,
  'this is the aria case: the claim must not buy credibility');
check('a body that merely CONTAINS the marker mid-sentence is REAL',
  classifyMessage(m('I ran a [trial] of my own harness today'), NONE).kind === REAL,
  'a substring matcher would have binned this one');
check('a body with no body at all is REAL', classifyMessage(m(undefined), NONE).kind === REAL);
check('an empty body is REAL', classifyMessage(m(''), NONE).kind === REAL);
check('a whitespace-only body is REAL', classifyMessage(m('   '), NONE).kind === REAL);
check('a message with no from is REAL', classifyMessage({ seq: 1, body: 'x' }, NONE).kind === REAL);
check('a null message is REAL', classifyMessage(null, NONE).kind === REAL);
check('a differently-cased vendor word buys nothing',
  classifyMessage(m({ vendor: 'Anthropic', note: 'genuine' }, 'unknown'), NONE).kind === REAL);

// --- 2. what OUR debris looks like --------------------------------------------------------------
check('the marker at the start of a string body is ours', classifyMessage(m('[trial] probe'), NONE).kind === TRIAL);
check('the marker is case-insensitive', classifyMessage(m('[TRIAL] x'), NONE).kind === TRIAL);
check('leading whitespace before the marker is tolerated', classifyMessage(m('  [trial] x'), NONE).kind === TRIAL);
check('a structured trial flag is ours', classifyMessage(m({ trial: true, probe: 'x' }), NONE).kind === TRIAL);
check('a LOCAL signing key is ours even with no marker',
  classifyMessage(m('probe body', 'our-key'), new Set(['our-key'])).kind === TRIAL);

// --- 3. an unmarked local-key message is a RECURRENCE, not a real visitor ------------------------
{
  const r = classifyMessage(m('probe body', 'our-key'), new Set(['our-key']));
  check('local key without marker is TRIAL', r.kind === TRIAL);
  check('...and is flagged as a recurrence', r.recurrence === true, 'the generator forgot the marker');
  const marked = classifyMessage(m('[trial] probe body', 'our-key'), new Set(['our-key']));
  check('a marked local message is NOT a recurrence', marked.recurrence === false);
  const foreign = classifyMessage(m('[trial] probe body', 'unknown-key'), new Set(['our-key']));
  check('a marked message from an unknown key is ours by declaration, and not a recurrence',
    foreign.kind === TRIAL && foreign.recurrence === false);
}

// --- 4. THE REAL CASE: the aria message, both ways ----------------------------------------------
// Recorded in the live relay at 2026-10-12T03:00:24Z. Its body claims an external vendor and its key
// is this repository's own .tmp/aria/identity.json. Key provenance is what settles it.
{
  const aria = { from: 'aria-local-pubkey', seq: 1, ts: 1, type: 'announce', topic: 'introduction', body: { agent: 'aria', vendor: 'openai' } };
  const asLocal = classifyMessage(aria, new Set(['aria-local-pubkey']));
  const asUnknown = classifyMessage(aria, NONE);
  check('aria WITH the local key is accounted for as ours', asLocal.kind === TRIAL && asLocal.localKey === true);
  check('aria WITHOUT the local key would be reported for a human', asUnknown.kind === REAL,
    'the same bytes, and the only thing that changed is whether the key exists here');
  check('...and neither verdict consults the body', !isMarked(aria.body), 'unmarked, so the KEY decided it');
}

// --- 5. bodyText/ isMarked do not over-reach -----------------------------------------------------
check('bodyText renders an object without throwing', bodyText({ a: 1 }) === '{"a":1}');
check('bodyText of null is empty', bodyText(null) === '');
check('isMarked is false for a mid-sentence marker', isMarked('see [trial] notes') === false);
check('isMarked is true only when the marker leads', isMarked('[trial] notes') === true);

// --- 6. NEGATIVE CONTROL: the classifier must be able to say REAL at all -------------------------
{
  const kinds = new Set([classifyMessage(m('hi'), NONE).kind, classifyMessage(m('[trial] x'), NONE).kind]);
  check('NEGATIVE CONTROL: both verdicts are reachable', kinds.size === 2, `saw ${[...kinds].join(', ')}`);
}

// --- 7. an unreachable relay must NEVER look like an empty one -----------------------------------
// Reporting "could not read" as "nothing there" is the one wrong answer, because it silently denies
// every real visitor while looking like a clean bill of health.
{
  const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'relay-feed-review.mjs'), 'http://127.0.0.1:9'], {
    encoding: 'utf8', timeout: 30000,
  });
  check('an unreachable relay exits 2', r.status === 2, `status=${r.status}`);
  check('...and says so rather than printing a clean feed', /cannot reach/.test(r.stderr ?? ''), (r.stderr ?? '').slice(0, 80));
  const bad = spawnSync(process.execPath, [join(ROOT, 'tools', 'relay-feed-review.mjs')], { encoding: 'utf8', timeout: 30000 });
  check('a missing URL exits 3', bad.status === 3, `status=${bad.status}`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
