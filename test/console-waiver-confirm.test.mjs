// THE WAIVER THE ADMIN HAD TO ANSWER TWICE.
//
// `decideAdmission` refuses to grant a failed challenge by default. That refusal is the gate working,
// and the admin is still the root of authority, so the page offers a second, explicit gesture.
//
// Measured in a real browser on 2026-10-11 against a synthetic admission store (E:\ui-lab, `answer`
// called with an empty answer list, so a genuine 0/10 failure): waiving a failed challenge fired
// THREE dialogs. The retry re-entered `decideAdmission`, which asked its own question again, so the
// operator answered the same thing twice in two different wordings -- "Override and admit them
// anyway?" immediately followed by "Admit them anyway?". The dangerous path is the one place where
// dialog fatigue has a cost, and a confirm that the operator has already answered is not a second
// guard; it is a rubber stamp that trains them to click through.
//
// This test does not grep the HTML for the recursion -- a grep would pass on code that is never
// called. It EXTRACTS the shipped functions out of the shipped file and RUNS them against stubs, so
// what is measured is behaviour: how many questions the admin is asked, and what the two requests
// actually carry. The red arm restores the old recursion and shows the count going back to three,
// because a test that cannot fail is not evidence.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, '..', 'console', 'public', 'index.html'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}

// Pull `async function <name>(...) {...}` out of a source text by matching braces. Naive, and
// deliberately so: the extracted text is immediately handed to `new Function`, so a bad extraction
// shows up as a parse error rather than as a silently weakened test.
function extractFn(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

const apiSrc = extractFn(HTML, 'api');
const sendSrc = extractFn(HTML, 'sendDecision');
const decideSrc = extractFn(HTML, 'decideAdmission');

check('the shipped page defines api, sendDecision and decideAdmission',
  Boolean(apiSrc && sendSrc && decideSrc),
  `api=${Boolean(apiSrc)} sendDecision=${Boolean(sendSrc)} decideAdmission=${Boolean(decideSrc)}`);

const REFUSAL = {
  ok: false,
  status: 409,
  json: async () => ({
    error: 'challenge_not_passed',
    reason: 'challenge_not_passed',
    code: 'challenge_not_passed',
    message: 'challenge_not_passed',
  }),
};
const OK = { ok: true, status: 200, json: async () => ({ ok: true, decision: 'grant' }) };

/**
 * Run the shipped decision path over stub IO.
 * `confirmAnswers` is consumed in order; the last value repeats, so `[true, false]` means
 * "yes to the decision, no to the waiver".
 */
function makeClient({ decide = decideSrc, responses, confirmAnswers = [true] }) {
  const calls = [];
  const prompts = [];
  let ri = 0;
  let ci = 0;
  const fetchStub = async (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
    const r = responses[Math.min(ri++, responses.length - 1)];
    return { ok: r.ok, status: r.status, json: async () => r.json() };
  };
  const confirmStub = (msg) => {
    prompts.push(String(msg));
    return confirmAnswers[Math.min(ci++, confirmAnswers.length - 1)];
  };
  const factory = new Function('fetch', 'confirm', 'TOKEN', 'lock', 'toast', 'loadAdmissions', `
    let ADM_SEL = 'the-admission-id';
    let ADM_ROWS = [];
    ${apiSrc}
    ${sendSrc}
    ${decide}
    return { decideAdmission };
  `);
  const client = factory(fetchStub, confirmStub, 'tok', () => {}, () => {}, async () => {});
  return { calls, prompts, client };
}

// --- 1. the waiver path: exactly two questions, and only the second carries the override ---------
{
  const { calls, prompts, client } = makeClient({ responses: [REFUSAL, OK] });
  await client.decideAdmission('grant');
  check('a failed challenge takes two requests (refused, then admitted)', calls.length === 2, `${calls.length} requests`);
  check('  ...and asks the admin exactly TWO questions', prompts.length === 2, `${prompts.length} questions`);
  check('  ...which are two DIFFERENT questions', prompts.length === 2 && prompts[0] !== prompts[1]);
  check('  ...the first request carries no override', calls[0] && calls[0].body.overrideFailedChallenge === undefined);
  check('  ...the retry carries overrideFailedChallenge:true', calls[1] && calls[1].body.overrideFailedChallenge === true);
  check('  ...and both name the same admission', calls[0].body.id === calls[1].body.id);
}

// --- 2. the CONTROL: a grant that passed must stay a ONE-question path ---------------------------
{
  const { calls, prompts, client } = makeClient({ responses: [OK] });
  await client.decideAdmission('grant');
  check('a passing grant asks ONE question and sends ONE request',
    prompts.length === 1 && calls.length === 1, `${prompts.length} questions, ${calls.length} requests`);
  check('  ...and carries no override', calls[0].body.overrideFailedChallenge === undefined);
}

// --- 3. declining the waiver must admit nobody ---------------------------------------------------
{
  const { calls, prompts, client } = makeClient({ responses: [REFUSAL, OK], confirmAnswers: [true, false] });
  await client.decideAdmission('grant');
  check('declining the waiver sends no second request', calls.length === 1, `${calls.length} requests`);
  check('  ...and never carries an override', calls.every((c) => c.body.overrideFailedChallenge === undefined));
}

// --- 4. RED ARM: restore the recursion and the third dialog comes back ---------------------------
{
  const broken = decideSrc.replace('await sendDecision("grant", true);', 'return decideAdmission("grant", true);');
  check('RED ARM: the mutation actually changed the source', broken !== decideSrc);

  const { calls, prompts, client } = makeClient({ decide: broken, responses: [REFUSAL, OK] });
  await client.decideAdmission('grant');
  check('RED ARM: the old recursion asks the waiver question TWICE', prompts.length === 3, `${prompts.length} questions`);
  check('RED ARM: ...so the operator answers the same thing twice',
    prompts.length === 3 && /did not pass/i.test(prompts[1] || '') && /did NOT pass/i.test(prompts[2] || ''),
    `${JSON.stringify((prompts[1] || '').slice(0, 40))} then ${JSON.stringify((prompts[2] || '').slice(0, 40))}`);
  check('RED ARM: ...while the requests themselves were never the problem', calls.length === 2);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
