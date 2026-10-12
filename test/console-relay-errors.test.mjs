// The relay's error vocabulary, pinned.
//
// Measured on the LIVE relay (tools/relay-actions-live.mjs, 2026-10-12), the relay has TWO ways of
// saying "I have nothing for that requestId", and they mean different things:
//
//   400  the requestId is MISSING or MALFORMED -- not a 32-char id at all
//   404  the requestId is WELL FORMED but the relay has nothing for it (never queued, or nothing
//        filed against it yet)
//
// An earlier version of this file pinned the OPPOSITE reading -- that a 400 meant "that entry is
// gone" -- and this file is the reason a wrong reading survives: the probe that produced it used
// `probe-<hex>`, which is not a valid id shape, so the relay's "malformed" was recorded as "absent"
// and then written down as a measurement. What caught it was a PASSING check elsewhere, in
// tools/console-relay-trial.mjs: a well-formed but never-seen id ('Z' x 32) answers NO_BINDING_YET,
// i.e. 404, not 400. The reading now encoded here is: a status code is evidence only together with
// the SHAPE of the id that produced it.
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

/** Pull `function relayMalformedId(...) { ... }` out of the module and run it with a recording `json`. */
function loadRelayMalformedId() {
  const at = page.indexOf('function relayMalformedId(');
  assert.ok(at > 0,
    'relayMalformedId is gone from console/app.mjs -- the relay\'s error vocabulary is unmapped again');
  const end = page.indexOf('\n}\n', at);
  assert.ok(end > at, 'could not find the end of relayMalformedId');
  const src = page.slice(at, end + 2);
  const calls = [];
  const json = (res, code_, body) => { calls.push({ res, code: code_, body }); };
  return { fn: new Function('json', `${src}\nreturn relayMalformedId;`)(json), calls, src };
}

test('a MALFORMED requestId is reported as malformed, not as a missing entry', () => {
  const { fn, calls } = loadRelayMalformedId();
  assert.equal(fn({}, { status: 400 }), true, 'a 400 from the relay must produce an answer');
  assert.equal(calls.length, 1, 'exactly one response may be written');
  assert.equal(calls[0].code, 400, 'the relay said the QUESTION was bad, so the answer is 400 too');
  assert.equal(calls[0].body.code, 'MALFORMED_REQUEST_ID');
  assert.match(calls[0].body.error, /malformed/);
  // The wording the live relay falsified. Pinned as a NEGATIVE so the old reading cannot creep back:
  // "gone" would send the operator hunting for an entry that never existed.
  assert.doesNotMatch(calls[0].body.error, /gone|no longer in the relay queue/);
});

test('the "not yet" statuses are left alone', () => {
  const { fn, calls } = loadRelayMalformedId();
  for (const status of [404, 409, 500, 502, 200, 201]) {
    assert.equal(fn({}, { status }), false,
      `status ${status} must not be swallowed as a bad id -- 404 in particular means "well formed, `
      + 'nothing filed yet", which each route names with its own NO_*_YET code');
  }
  assert.equal(calls.length, 0, 'a status this helper does not own must leave the socket alone');
});

test('the helper returns a boolean, never the response', () => {
  const { fn, src } = loadRelayMalformedId();
  assert.equal(typeof fn({}, { status: 400 }), 'boolean');
  assert.equal(typeof fn({}, { status: 200 }), 'boolean');
  // Load-bearing: `json()` is a block-bodied arrow with no return, so it yields undefined. A helper
  // that returned the RESPONSE would be falsy, and the caller `if (g) return g;` would fall through
  // and write a SECOND response onto a socket this one already ended -- measured live as the console
  // dying mid-session (exit 1) while the operator saw a correct-looking first answer.
  assert.doesNotMatch(src, /return json\(/,
    'relayMalformedId must not return the (undefined) result of json() -- that kills the console');
  assert.match(src, /return true;/, 'relayMalformedId must say whether it answered');
});

test('all four pull routes consult the mapping', () => {
  const uses = [...code.matchAll(/if \(relayMalformedId\(res, \w+\)\) return;/g)].length;
  assert.equal(uses, 4,
    'collect, bind, interview and verdict must each map a 400; a route that skips it reports the '
    + 'wrong reason to the operator');
});

test('each route maps the response IT fetched, not another route\'s', () => {
  // The lookahead excludes the definition `function relayMalformedId(res, r) {`, which has the same
  // shape and is how an earlier version of this test counted five routes out of four.
  const mapped = [...code.matchAll(/relayMalformedId\(res, (\w+)\)(?!\s*\{)/g)].map((m) => m[1]);
  assert.deepEqual(mapped.sort(), ['a', 'bnd', 'itv', 'vres']);
});

test('each pull route still names its own "not yet" reason', () => {
  for (const code of ['NO_ANSWERS_YET', 'NO_BINDING_YET', 'NO_INTERVIEW_YET', 'NO_VERDICT_YET']) {
    assert.ok(page.includes(`code: '${code}'`), `${code} is no longer raised anywhere`);
  }
});
