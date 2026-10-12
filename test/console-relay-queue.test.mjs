// The console can now SHOW the relay queue. Until it could, a remote applicant was invisible in the
// human admin's only interface -- the difference between "waiting for you" and "silently never
// admitted". These tests lock the two things that make the panel worth having:
//
//   1. ONE home for the convention. The review tool and the console must use the SAME classifier
//      FUNCTIONS, not two implementations that agree today. Identity, not equal behaviour: a copy
//      that happens to match now is exactly the copy that drifts later.
//   2. The page never re-derives the rule. It renders the server's verdict. If the page ever grows
//      its own copy of the [trial] marker, this test fails.
//
// Plus the asymmetry itself: a real applicant sorts above trial debris, and an UNREACHABLE relay is
// never reported as an empty queue -- "cannot see" and "nobody is there" are different facts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { classifyNote, triage, LEGACY_TRIAL_NOTES, TRIAL, REAL } from '../src/queue-classify.mjs';
import * as reviewTool from '../tools/admission-queue-review.mjs';

const root = new URL('../', import.meta.url);
const page = readFileSync(fileURLToPath(new URL('console/public/index.html', root)), 'utf8');
const app = readFileSync(fileURLToPath(new URL('console/app.mjs', root)), 'utf8');

// --- 1. one home for the convention --------------------------------------------------------------

test('the review tool and the console import the SAME classifier functions', () => {
  assert.equal(reviewTool.classifyNote, classifyNote,
    'the tool has its own copy of classifyNote again -- the two will drift');
  assert.equal(reviewTool.triage, triage, 'the tool has its own copy of triage again');
  assert.equal(reviewTool.LEGACY_TRIAL_NOTES, LEGACY_TRIAL_NOTES,
    'the legacy label list is duplicated; the lists will diverge');
});

test('the console server annotates the queue with that same classifier', () => {
  assert.match(app, /import \{[^}]*classifyNote[^}]*\} from '\.\/src\/queue-classify\.mjs'/,
    'the console server does not import the shared classifier');
  assert.match(app, /\.\.\.classifyNote\(/, 'the relay queue route does not annotate rows with kind/why');
  assert.match(app, /real: waiting\.filter\(/, 'the route does not report its own real count');
});

// --- 2. the rules, including the deliberate asymmetry --------------------------------------------

test('an empty or missing note is REAL -- the most applicant-like thing there is', () => {
  for (const note of [null, undefined, '', '   ']) {
    assert.equal(classifyNote(note).kind, REAL, `note ${JSON.stringify(note)} must be treated as a real applicant`);
  }
});

test('the [trial] marker and every documented legacy label are TRIAL', () => {
  assert.equal(classifyNote('[trial] anything').kind, TRIAL);
  assert.equal(classifyNote('  [TRIAL] capitalised').kind, TRIAL);
  for (const legacy of LEGACY_TRIAL_NOTES) {
    assert.equal(classifyNote(legacy).kind, TRIAL, `legacy label "${legacy}" must still be recognised`);
  }
});

test('anything else is REAL -- the classifier fails toward the human', () => {
  assert.equal(classifyNote('hello, I would like to join').kind, REAL);
  assert.equal(classifyNote('trial').kind, REAL, 'the bare word "trial" is not a marker we wrote');
});

test('triage reports the whole queue, so an empty one cannot be confused with a clean one', () => {
  const { rows, trials, real } = triage([{ note: '[trial] x' }, { note: null }, { note: 'hi' }]);
  assert.equal(rows.length, 3);
  assert.equal(trials.length, 1);
  assert.equal(real.length, 2);
  assert.equal(triage([]).rows.length, 0);
});

// --- 3. the page renders the server's verdict, and never its own ---------------------------------

function extract(name) {
  const at = page.indexOf(`function ${name}(`);
  assert.ok(at > -1, `the page no longer defines ${name}() -- the panel is gone`);
  const start = page.lastIndexOf('\n', at) + 1;
  const end = page.indexOf('\n}\n', at);
  assert.ok(end > start, `could not find the end of ${name}()`);
  return page.slice(start, end + 3);
}

test('the page does not re-derive the trial rule', () => {
  const renderer = extract('renderRelayQueue');
  const loader = extract('loadRelayQueue');
  for (const [name, src] of [['renderRelayQueue', renderer], ['loadRelayQueue', loader]]) {
    assert.ok(!/\[trial\]/i.test(src), `${name}() re-implements the [trial] marker instead of using the server's kind`);
    assert.ok(!/LEGACY_TRIAL_NOTES/.test(src), `${name}() carries its own copy of the legacy labels`);
  }
  assert.match(renderer, /r\.kind === "real"/, 'renderRelayQueue() must use the server-provided kind');
});

/** A DOM stub just large enough to run the page's renderer and read back what it produced. */
function makeDom() {
  const nodes = {};
  for (const id of ['relay-status', 'relay-list']) {
    nodes[id] = {
      id, innerHTML: '', textContent: '', children: [], style: {},
      append(...cs) { this.children.push(...cs); },
    };
  }
  return nodes;
}
function fakeEl(tag, cls, text) {
  const n = { tag, className: cls ?? null, textContent: text === undefined || text === null ? '' : String(text), children: [], style: {} };
  n.append = (...cs) => { n.children.push(...cs); };
  return n;
}
function textOf(node) {
  let out = node.textContent || '';
  for (const c of node.children || []) out += ' ' + textOf(c);
  return out;
}

/** Run the page's own functions, with the page's own $ / el replaced by the stubs. */
function runPage(apiImpl) {
  const dom = makeDom();
  const $ = (id) => dom[id];
  const api = apiImpl;
  const factory = new Function('$', 'api', 'el',
    `${extract('renderRelayQueue')}\n${extract('loadRelayQueue')}\nreturn { loadRelayQueue, renderRelayQueue };`);
  return { ...factory($, api, fakeEl), dom };
}

test('a real applicant is rendered ABOVE trial debris', () => {
  const { renderRelayQueue, dom } = runPage(async () => ({ waiting: [] }));
  renderRelayQueue([
    { requestId: 'd1', short: 'debris01', note: '[trial] x', kind: 'trial', why: 'carries the [trial] marker', stage: 'new' },
    { requestId: 'r1', short: 'real0001', note: null, kind: 'real', why: 'no note -- a human should look at this', stage: 'new' },
  ]);
  const rendered = dom['relay-list'].children.map(textOf);
  assert.equal(rendered.length, 2);
  assert.match(rendered[0], /real0001/, 'the real applicant must be first');
  assert.match(rendered[0], /NEEDS YOUR DECISION/);
  assert.match(rendered[1], /debris01/);
  assert.match(rendered[1], /trial debris/);
});

test('an unreachable relay is NEVER reported as an empty queue', async () => {
  const { loadRelayQueue, dom } = runPage(async () => { throw new Error('relay answered 502'); });
  await loadRelayQueue();
  assert.match(dom['relay-status'].textContent, /Could NOT read the relay queue/);
  assert.ok(!/Nobody is waiting/.test(dom['relay-status'].textContent),
    'an error must not be dressed up as an empty queue -- that is how an applicant gets lost');
});

test('an empty queue is reported as empty, and it is distinguishable from the error above', async () => {
  const { loadRelayQueue, dom } = runPage(async () => ({ waiting: [], real: 0, relay: 'https://example.invalid' }));
  await loadRelayQueue();
  assert.match(dom['relay-status'].textContent, /Nobody is waiting/);
});

test('the status line counts the rows that need a human', async () => {
  const { loadRelayQueue, dom } = runPage(async () => ({
    waiting: [{ requestId: 'r1', kind: 'real' }, { requestId: 'd1', kind: 'trial' }],
    real: 1,
    relay: 'https://example.invalid',
  }));
  await loadRelayQueue();
  assert.match(dom['relay-status'].textContent, /2 waiting/);
  assert.match(dom['relay-status'].textContent, /1 need a human/);
});
