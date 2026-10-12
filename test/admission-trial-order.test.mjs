/**
 * Catches the rot that cost this project a live write to discover.
 *
 * `tools/live-remote-trial.mjs` claims to walk "the whole agents-only gate over the live relay". It
 * did not: it went request -> challenge -> ANSWER -> verdict, skipping the bind entirely. The relay
 * refuses to grant an unbindable request (409 no_binding_yet, because a grant issued before the bind
 * names nobody and strands the applicant for good), so THE TRIAL COULD NEVER PASS. Nobody noticed,
 * because writing trials are excluded from the npm test chain by design -- they cost KV writes and
 * leave a trail on a public relay. That exclusion is still correct. The mistake was having NO cheap
 * check in its place.
 *
 * This is that check, and it is free: the relay documents its own HARD ORDER, so a trial that claims
 * to walk the gate can be held to it statically.
 *
 * What it does NOT do: it cannot tell whether a trial's assertions are any good, and it cannot see
 * whether the ROUTES still behave as the trial expects. It only catches a trial that has stopped
 * covering the steps it claims to cover -- which is precisely the failure that survived unnoticed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TRIAL = join(ROOT, 'tools', 'live-remote-trial.mjs');
const RELAY = join(ROOT, 'worker', 'worker.js');

/**
 * The relay's documented hard order. Bind is third and it is the one step that cannot be done late --
 * the relay says so itself. Ordering is asserted, not just presence: answering before binding is a
 * different bug from not binding at all, and both are wrong.
 */
const HARD_ORDER = ['request', 'challenge', 'bind', 'answer', 'verdict'];

/**
 * Index of the route `/admission/<name>`, matching that name EXACTLY. The trailing lookahead matters:
 * without it `request` would also match inside `/admission/requests`, and the queue-listing call at
 * the top of the trial would be mistaken for the joiner opening a request.
 */
function routeIndex(src, name) {
  const m = new RegExp(`/admission/${name}(?=['"\`?])`).exec(src);
  return m ? m.index : -1;
}

function coveredRoutes(src) {
  return HARD_ORDER.map((name) => ({ name, at: routeIndex(src, name) }));
}

test('the relay really does document this order (so the guard is not inventing a rule)', () => {
  const relay = readFileSync(RELAY, 'utf8');
  assert.match(relay, /POST \/admission\/bind/, 'the relay must document the bind step');
  assert.match(relay, /no_binding_yet/, 'the relay must refuse an unbound grant');
  assert.match(relay, /THAT IS A HARD ORDER/, 'the relay states the order is hard; the guard relies on that');
  assert.match(relay, /bind BEFORE an admin decides/i);
});

test('the flagship gate trial covers every step of the hard order', () => {
  const src = readFileSync(TRIAL, 'utf8');
  const missing = coveredRoutes(src).filter((r) => r.at < 0).map((r) => r.name);
  assert.deepEqual(missing, [], `the trial never calls /admission/{${missing.join(', ')}}`);
});

test('and it covers them IN ORDER, because the relay says the order is hard', () => {
  const src = readFileSync(TRIAL, 'utf8');
  const seq = coveredRoutes(src);
  for (let i = 1; i < seq.length; i++) {
    assert.ok(
      seq[i - 1].at < seq[i].at,
      `/admission/${seq[i].name} appears BEFORE /admission/${seq[i - 1].name}; the relay requires ` +
      `${HARD_ORDER.join(' -> ')}`,
    );
  }
});

test('the bind is signed over the exact bytes the relay specifies, not canonical JSON', () => {
  const src = readFileSync(TRIAL, 'utf8');
  assert.match(src, /agent-commons\/relay-bind\/v1/, 'the bind must sign the versioned claim string');
  assert.match(src, /\[.*relay-bind\/v1.*, requestId, joiner\.agentId\]\.join\('\\n'\)/,
    'the claim must be the three parts joined by newlines, in that order');
});

test('RED ARM: this guard FAILS on the trial exactly as it was when it was broken', () => {
  const src = readFileSync(TRIAL, 'utf8');
  // Remove the section that performs the bind, reproducing the original defect faithfully.
  const broken = src.replace(/── 5b\. JOINER BINDS[\s\S]*?── 6\. JOINER derives/, '── 6. JOINER derives');
  assert.notEqual(broken, src, 'the red arm must actually change the source, or it proves nothing');
  assert.equal(routeIndex(broken, 'bind'), -1, 'the mutation must remove the bind route');
  const missing = coveredRoutes(broken).filter((r) => r.at < 0).map((r) => r.name);
  assert.deepEqual(missing, ['bind'], 'the guard must report exactly the missing step');
});

test('RED ARM: an out-of-order trial is caught, not just a missing route', () => {
  const src = readFileSync(TRIAL, 'utf8');
  const bindAt = routeIndex(src, 'bind');
  const answerAt = routeIndex(src, 'answer');
  assert.ok(bindAt >= 0 && answerAt >= 0 && bindAt < answerAt, 'the real trial is correctly ordered');
  // Swap them: move the bind call text to AFTER the answer call, which the relay would reject.
  const swapped = src.slice(0, bindAt) + src.slice(answerAt) + src.slice(bindAt, answerAt);
  const seq = coveredRoutes(swapped);
  const bindStep = seq.find((s) => s.name === 'bind');
  const answerStep = seq.find((s) => s.name === 'answer');
  assert.ok(bindStep.at > answerStep.at, 'the mutation must actually reorder them');
});
