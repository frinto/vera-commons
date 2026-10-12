// The relay's error vocabulary, pinned.
//
// Measured on the LIVE relay (tools/relay-actions-live.mjs, 2026-10-12): a requestId the worker does
// not know at all answers **400**; a requestId it knows but has nothing for yet answers **404**. The
// console originally mapped only the 404, so a stale click on the panel -- exactly the case the panel
// creates, since the queue is live -- reported "The relay answered 400" as a RELAY_ERROR. That sends
// the operator hunting for an outage when the honest answer is "that entry is gone".
//
// The mapping lives in ONE function, tested here by EXTRACTING and RUNNING it rather than grepping
// for its name. The behavioural authority is the live probe; this is the cheap guard on every run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../console/app.mjs', import.meta.url), 'utf8');

// Count only in CODE. The helper's own comment quotes the call pattern it tells callers to write, so
// counting raw text found five call sites out of four -- the doc explaining a rule is not an instance
// of it. Whole-line comments are dropped; nothing here matches a URL's `//`.
const code = page.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** Pull `function relayGone(...) { ... }` out of the module and run it with a recording `json`. */
function loadRelayGone() {
  const at = page.indexOf('function relayGone(');
  assert.ok(at > 0, 'relayGone is gone from console/app.mjs -- the relay vocabulary is unmapped again');
  const end = page.indexOf('\n}\n', at);
  assert.ok(end > at, 'could not find the end of relayGone');
  const src = page.slice(at, end + 2);
  const calls = [];
  const json = (res, code_, body) => { calls.push({ res, code: code_, body }); };
  return { fn: new Function('json', `${src}\nreturn relayGone;`)(json), calls, src };
}

test('a requestId the relay does not know is reported as GONE, not as a relay fault', () => {
  const { fn, calls } = loadRelayGone();
  assert.equal(fn({}, { status: 400 }), true, 'a 400 from the relay must produce an answer');
  assert.equal(calls.length, 1, 'exactly one response may be written');
  assert.equal(calls[0].code, 404, 'the console answers 404, matching the challenge route');
  assert.equal(calls[0].body.code, 'NOT_QUEUED');
  assert.match(calls[0].body.error, /no longer in the relay queue/);
});

test('every other status falls through to the route\'s own handling, and writes NOTHING', () => {
  const { fn, calls } = loadRelayGone();
  for (const status of [200, 201, 401, 403, 404, 409, 500, 502]) {
    assert.equal(fn({}, { status }), false,
      `status ${status} must not be swallowed as "gone" -- 404 in particular means "not YET"`);
  }
  assert.equal(calls.length, 0, 'a status this helper does not own must leave the socket alone');
});

test('relayGone reports a BOOLEAN, so a caller cannot fail open', () => {
  const { fn, src } = loadRelayGone();
  assert.equal(typeof fn({}, { status: 400 }), 'boolean');
  assert.equal(typeof fn({}, { status: 200 }), 'boolean');
  // Load-bearing: `json()` is a block-bodied arrow with no return, so it yields undefined. A helper
  // that returned the RESPONSE would be falsy, and the caller `if (g) return g;` would fall through
  // and write a second response onto a socket already ended -- which does not raise a catchable
  // error, it kills the console mid-session, leaving the operator with a correct-looking answer and
  // a dead process. Measured live: exit code 1, reproduced by tools/relay-actions-live.mjs.
  assert.ok(!/return json\(res, 404/.test(src), 'relayGone must not hand back the response object');
  assert.match(src, /return true;/, 'relayGone must say whether it answered');
});

test('all four pull routes consult the mapping', () => {
  const uses = [...code.matchAll(/if \(relayGone\(res, \w+\)\) return;/g)].length;
  assert.equal(uses, 4,
    'collect, bind, interview and verdict must each map a 400; a route that skips it reports the '
    + 'wrong reason to the operator');
});

test('each route maps the response IT fetched, not another route\'s', () => {
  // The lookahead excludes the definition `function relayGone(res, r) {`, which has the same shape
  // and is how an earlier version of this test counted five routes out of four.
  const mapped = [...code.matchAll(/relayGone\(res, (\w+)\)(?!\s*\{)/g)].map((m) => m[1]);
  assert.deepEqual(mapped.sort(), ['a', 'bnd', 'itv', 'vres']);
});

test('each pull route still names its own "not yet" reason', () => {
  for (const code of ['NO_ANSWERS_YET', 'NO_BINDING_YET', 'NO_INTERVIEW_YET', 'NO_VERDICT_YET']) {
    assert.ok(page.includes(`code: '${code}'`), `${code} is no longer raised anywhere`);
  }
});
