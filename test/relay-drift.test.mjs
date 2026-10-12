// Guards for tools/relay-drift.mjs -- the check that keeps "the deploy is behind this tree" a
// re-derivable fact instead of a remembered one.
//
// The comparison itself is pure, so it is tested directly and exhaustively (no network, no fixture
// server, and nothing that breaks when a legitimate field is added). The one process-level case is
// the negative control that matters most: a relay that cannot be reached must end as COULD NOT
// COMPARE, never as "no drift" -- the same defect family as reporting an unreadable queue as an
// empty one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { shapeOf, diffShape, emptyArrayPaths, splitByComparability, typeOnlyPairs } from '../tools/relay-drift.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(ROOT, 'tools', 'relay-drift.mjs');

test('a missing field, an extra field and a changed type are each reported', () => {
  const repo = shapeOf({ ok: true, requests: [], total: 0, unreadable: [], truncated: false });
  const deployed = shapeOf({ ok: true, requests: [] });
  const behind = diffShape(repo, deployed);
  assert.deepEqual(behind.missingLive,
    ['$.total:number', '$.truncated:boolean', '$.unreadable:array'],
    'the fields this tree sends and the deploy does not must be named individually');
  assert.deepEqual(behind.extraLive, [], 'the deploy is not sending anything extra here');

  const ahead = diffShape(shapeOf({ ok: true }), shapeOf({ ok: true, cache: 'hit' }));
  assert.deepEqual(ahead.extraLive, ['$.cache:string'],
    'a field the deploy sends that this tree does not is drift too -- in the other direction');
  assert.deepEqual(ahead.missingLive, []);

  const retyped = diffShape(shapeOf({ ok: true, total: 0 }), shapeOf({ ok: true, total: '0' }));
  assert.deepEqual(retyped.missingLive, ['$.total:number'], 'a changed type is a drift, not a match');

  // Nested objects and array elements are described too: the queue's entries carry fields a deploy
  // could add or drop without changing any top-level key.
  const nested = diffShape(
    shapeOf({ requests: [{ requestId: 'x', note: null, at: 1 }] }),
    shapeOf({ requests: [{ requestId: 'x' }] }),
  );
  assert.deepEqual(nested.missingLive, ['$.requests[].at:number', '$.requests[].note:null'],
    'a field missing from INSIDE a queue entry must be visible');
});

test('an identical shape reports no drift, and an empty array is not read as a missing field', () => {
  const a = shapeOf({ ok: true, messages: [], unreadable: [] });
  const b = shapeOf({ ok: true, messages: [], unreadable: [] });
  const same = diffShape(a, b);
  assert.deepEqual(same.missingLive, []);
  assert.deepEqual(same.extraLive, []);
  // The local side is empty by construction, so `[]` must still be described as an array -- reading
  // an empty array as "nothing to compare" would make every empty local response look like a match.
  assert.ok(a.has('$.unreadable:array'), 'an empty array still carries its type');
});

test('a difference caused by an EMPTY side is a stated limit, not drift', () => {
  // Measured the first time this tool ran against the live relay: because the local side runs on an
  // empty mock KV, the deploy's REAL queue entries made every entry field look like "the deploy sends
  // extra" -- fifteen noisy lines standing over three real ones, which is exactly where a genuine
  // difference goes to hide. The rule is the one this program applies everywhere else: state what
  // could not be compared instead of asserting something confident about it.
  const repo = shapeOf({ ok: true, requests: [], total: 0 });
  const live = shapeOf({ ok: true, requests: [{ requestId: 'x', note: null }] });
  const split = splitByComparability(diffShape(repo, live),
    emptyArrayPaths({ requests: [] }), emptyArrayPaths({ requests: [{ requestId: 'x' }] }));
  assert.deepEqual(split.missingLive, ['$.total:number'], 'the real difference must survive');
  assert.deepEqual(split.extraLive, [], 'the deploy is not "sending extra" anything');
  assert.deepEqual(split.notComparable.map((n) => n.path).sort(),
    ['$.requests[].note:null', '$.requests[].requestId:string', '$.requests[]:object'],
    'every entry-level difference must be listed as a stated limit');
  assert.match(split.notComparable[0].why, /NO entries/);

  // The other direction: the RELAY returned nothing, so a field this tree emits inside an entry
  // cannot be compared either -- and must not be reported as "the deploy dropped it".
  const other = splitByComparability(
    diffShape(shapeOf({ requests: [{ requestId: 'x' }] }), shapeOf({ requests: [] })),
    emptyArrayPaths({ requests: [{ requestId: 'x' }] }), emptyArrayPaths({ requests: [] }));
  assert.deepEqual(other.missingLive, []);
  assert.deepEqual(other.notComparable.map((n) => n.path).sort(),
    ['$.requests[].requestId:string', '$.requests[]:object']);
  assert.match(other.notComparable[0].why, /relay returned NO entries/);

  // And an empty array is never a blanket excuse: a top-level difference stays drift.
  const mixed = splitByComparability(
    diffShape(shapeOf({ ok: true, requests: [], total: 0 }), shapeOf({ ok: true, requests: [] })),
    emptyArrayPaths({ requests: [] }), emptyArrayPaths({ requests: [] }));
  assert.deepEqual(mixed.missingLive, ['$.total:number'],
    'an empty array elsewhere in the body must not excuse unrelated drift');

  // A path on both sides with different types is named as such, so the report can warn that it may be
  // a difference in STATE (an empty list answers cursor:null where a populated one answers a string)
  // rather than letting a reader conclude the deployed CODE differs.
  assert.deepEqual(typeOnlyPairs(['$.cursor:null'], ['$.cursor:string']),
    [{ path: '$.cursor', here: 'null', relay: 'string' }]);
  assert.deepEqual(typeOnlyPairs(['$.total:number'], []), [], 'a one-sided difference is not a type pair');
  assert.deepEqual(typeOnlyPairs(['$.a:number'], ['$.b:string']), [], 'different paths are not a type pair');
});

test('a relay that cannot be reached is COULD NOT COMPARE, never a clean bill', () => {
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [TOOL, '--relay', 'http://127.0.0.1:1'], {
      encoding: 'utf8', cwd: ROOT,
    });
  } catch (err) {
    code = err.status ?? 1;
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  assert.equal(code, 2, `an unreachable relay must exit 2, not report success:\n${out}`);
  assert.match(out, /COULD NOT COMPARE/, 'it must say plainly that no comparison happened');
  assert.match(out, /must not be read as one/, 'and that this is not a pass');
  assert.doesNotMatch(out, /No shape drift/, 'the success line must be unreachable when nothing was compared');
});
