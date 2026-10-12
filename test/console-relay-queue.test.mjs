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
  // The route must COUNT the real rows itself, from the row list, rather than leaving the page to
  // derive it. Pinned as an intent rather than a spelling: the row list was renamed (waiting -> rows)
  // when the route began joining each row against the relay's published verdict, and a test that
  // insists on the old variable name fails on a refactor that preserved the behaviour exactly.
  assert.match(app, /real:\s*(waiting|rows)\.filter\(/,
    'the route does not report its own real count');
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
  const n = { tag, className: cls ?? null, textContent: text === undefined || text === null ? '' : String(text), children: [], style: {}, handlers: {} };
  n.append = (...cs) => { n.children.push(...cs); };
  n.addEventListener = (ev, fn) => { n.handlers[ev] = fn; };
  return n;
}
function buttonsIn(node, out = []) {
  for (const c of node.children || []) {
    if (c.tag === 'button') out.push(c);
    buttonsIn(c, out);
  }
  return out;
}

/** Run the page's own functions, with the page's own $ / el / toast replaced by the stubs. */
function runPage(apiImpl) {
  const dom = makeDom();
  const toasts = [];
  let admissionsReloads = 0;
  const factory = new Function('$', 'api', 'el', 'toast', 'loadAdmissions',
    `${extract('renderRelayQueue')}\n${extract('loadRelayQueue')}\n${extract('relayActionDone')}\n`
    + `${extract('relayAction')}\nreturn { loadRelayQueue, renderRelayQueue, relayAction, relayActionDone };`);
  return {
    ...factory((id) => dom[id], apiImpl, fakeEl, (m) => toasts.push(String(m)), async () => { admissionsReloads++; }),
    dom,
    toasts,
    admissionsReloads: () => admissionsReloads,
  };
}
function textOf(node) {
  let out = node.textContent || '';
  for (const c of node.children || []) out += ' ' + textOf(c);
  return out;
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
  // The ONLY body that licenses the flat sentence: a row list that is present and empty, AND a
  // console that says the list was complete. An empty list ALONE is not enough, because that is
  // exactly what an unread queue looks like too -- see the next test.
  const { loadRelayQueue, dom } = runPage(async () => ({
    waiting: [], real: 0, relay: 'https://example.invalid',
    completeness: 'page complete', caveats: [],
  }));
  await loadRelayQueue();
  assert.match(dom['relay-status'].textContent, /Nobody is waiting/);
});

test('an empty list whose completeness was NOT reported can never say "nobody is waiting"', async () => {
  const { loadRelayQueue, dom } = runPage(async () => ({ waiting: [], real: 0, relay: 'https://example.invalid' }));
  await loadRelayQueue();
  assert.ok(!/Nobody is waiting/.test(dom['relay-status'].textContent),
    'rows that arrived without the relay saying whether they were the whole queue are not proof that nobody is waiting');
  assert.match(dom['relay-status'].textContent, /NOT proof that nobody is waiting/);
});

test('a 200 with NO row list is not an empty queue (the console refuses; the page does not assume)', async () => {
  const { loadRelayQueue, dom } = runPage(async () => ({
    counts: { waiting: 0, real: 0 }, relay: 'https://example.invalid',
  }));
  await loadRelayQueue();
  assert.match(dom['relay-status'].textContent, /Could NOT read the relay queue/);
  assert.ok(!/Nobody is waiting/.test(dom['relay-status'].textContent),
    'a missing row list must never be counted as zero rows -- the server now answers 502 for it, and this is the page half of the same rule');
});

test('the stated limits are printed WITH the counts, not left in a field nobody renders', async () => {
  const { loadRelayQueue, dom } = runPage(async () => ({
    waiting: [{ requestId: 'r1', kind: 'real' }], real: 1, relay: 'https://example.invalid',
    counts: { waiting: 1, real: 1, resolved: 0, unknown: 0 },
    completeness: 'completeness NOT REPORTED by this relay',
    caveats: ['this relay does not report completeness (`truncated` is absent), so whether everyone waiting is listed here cannot be confirmed from this answer'],
  }));
  await loadRelayQueue();
  assert.match(dom['relay-status'].textContent, /1 waiting/);
  assert.match(dom['relay-status'].textContent, /cannot be confirmed from this answer/);
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

// --- 4. the actions advance the remote pipeline, and CANNOT mint authority ------------------------
// These four steps publish a test, publish a score, fix which key the record names, and record free
// text. None of them admits anybody, so none of them asks a confirmation -- and the point of that
// choice is that the confirmations which DO exist (decide, permit, revoke) keep their weight.

test('a row with no local record offers exactly one action: issue the challenge', () => {
  const { renderRelayQueue, dom } = runPage(async () => ({}));
  renderRelayQueue([{ requestId: 'req-1', localId: null, short: 'abc', note: 'hi', kind: 'real', why: 'w', stage: 'new' }]);
  assert.deepEqual(buttonsIn(dom['relay-list']).map((b) => b.textContent), ['Issue challenge']);
});

test('a row that has a local record offers the three pull actions', () => {
  const { renderRelayQueue, dom } = runPage(async () => ({}));
  renderRelayQueue([{ requestId: 'req-2', localId: 'local-2', short: 'd', note: 'x', kind: 'trial', why: 'w', stage: 'answered' }]);
  assert.deepEqual(buttonsIn(dom['relay-list']).map((b) => b.textContent),
    ['Collect answers', 'Pull identity claim', 'Pull interview']);
});

test('issuing a challenge sends ONLY the requestId', async () => {
  const calls = [];
  const { relayAction } = runPage(async (path, opts) => { calls.push([path, JSON.parse(opts.body)]); return { published: true }; });
  await relayAction('challenge', { requestId: 'req-1', localId: null });
  assert.equal(calls[0][0], '/api/relay/challenge');
  assert.deepEqual(calls[0][1], { requestId: 'req-1' });
});

test('the pull steps send BOTH ids, because the server needs the local record and the relay request', async () => {
  const calls = [];
  const { relayAction } = runPage(async (path, opts) => { calls.push([path, JSON.parse(opts.body)]); return {}; });
  await relayAction('collect', { requestId: 'req-2', localId: 'local-2' });
  assert.equal(calls[0][0], '/api/relay/collect');
  assert.deepEqual(calls[0][1], { id: 'local-2', requestId: 'req-2' });
});

test('a refusal is reported the way the server stated it, not rewritten', async () => {
  const { relayAction, toasts } = runPage(async () => { throw new Error('That agent has not answered yet.'); });
  await relayAction('collect', { requestId: 'r', localId: 'l' });
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /the server refused: That agent has not answered yet\./);
});

test('the relay panel cannot reach an authority route', () => {
  const src = extract('relayAction') + extract('relayActionDone') + extract('renderRelayQueue');
  for (const forbidden of ['/api/admissions/decide', '/api/grant', '/api/revoke', '/api/relay/verdict']) {
    assert.ok(!src.includes(forbidden), `the relay panel must not reach ${forbidden}`);
  }
  assert.match(extract('relayAction'), /api\("\/api\/relay\/" \+ kind/, 'relay paths must be built from the one prefix');
});

test('the page offers exactly the four pipeline steps and never "verdict"', () => {
  // Two shapes carry a step name: the direct call (challenge) and the button table (the three pull
  // steps). Collect BOTH -- an earlier version of this test read only the first shape and so silently
  // proved nothing about three of the four steps.
  const direct = [...page.matchAll(/relayAction\("([a-z]+)"/g)].map((m) => m[1]);
  const table = [...page.matchAll(/\n\s*\["([a-z]+)", "[^"]+"\],/g)].map((m) => m[1]);
  const steps = [...direct, ...table].sort();
  assert.deepEqual(steps, ['bind', 'challenge', 'collect', 'interview'],
    'a step was added or removed; adopting a decision must stay a deliberate act, not a button');
  // The route may be NAMED in a comment explaining why it is absent -- it must never be a literal.
  assert.ok(!/["']\/api\/relay\/verdict/.test(page), 'the verdict-adopting route is wired into the page');
});

test('both panels are refreshed after an action, because either can have changed', async () => {
  const { relayAction, admissionsReloads } = runPage(async () => ({}));
  await relayAction('bind', { requestId: 'r', localId: 'l' });
  assert.equal(admissionsReloads(), 1, 'a challenge creates a local admission row; the list must reload');
});
