// NOTHING RUNS IT.
//
// Six live trials are the strongest end-to-end evidence this project has. None of them run in
// `npm test` -- correctly, because they spend KV writes against a free tier and leave labelled probe
// debris on a public relay. But the separation was undocumented, there was no single command that
// ran them, and two of them (`vendor-gate-trial`, `console-relay-trial`) had no npm script at all.
// So ~44KB of live-trial code could only be executed by remembering a path, and the project's
// characteristic failure -- `npm test` green while the live path is broken -- was one forgotten
// command away.
//
// The invariant this file enforces is the one that was missing:
//
//     every live trial must be EITHER in the registry (runnable by one command)
//     OR in the npm test chain. Never neither.
//
// That is the statement that turns "someone should run the trials sometimes" into something a build
// can check. It is deliberately about COVERAGE, not about passing: whether a trial passes is the
// trial's business, but whether anything can run it at all is this file's business.
//
// The second invariant is the safety-critical one: a trial declared read-only must not POST to an
// admission or message route. Without it, a new trial could join the "safe, run it every time" set
// while quietly writing to the public relay -- the opposite of what the label promises.

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const TEST_CHAIN = pkg.scripts.test;

// The registry speaks for itself: it is asked, not parsed. If the aggregator cannot list its own
// contents, everything below is measuring a file nobody can run -- which is the defect itself.
const listed = spawnSync(process.execPath, [join(ROOT, 'tools', 'trial-all.mjs'), '--list'], { cwd: ROOT, encoding: 'utf8' });
check('the registry can describe itself', listed.status === 0, `exit ${listed.status}`);
const listOut = listed.stdout || '';

const registryFiles = [...listOut.matchAll(/(tools\/[a-z0-9-]+\.mjs)/g)].map((m) => m[1]);
const registryIds = [...listOut.matchAll(/^\s+(?:WRITES|safe)\s+(\S+)/gm)].map((m) => m[1]);
check('the registry is non-empty', registryIds.length >= 6, `${registryIds.length} entries`);

console.log('  --- every live trial is reachable from somewhere ---');

// A trial is any tool whose NAME says it is one. Matching on the name rather than on a hand-written
// list is the point: a trial added tomorrow is covered without anyone remembering to add it here.
// `trial-all.mjs` is excluded because it IS the registry -- the scan is asking whether something can
// run each trial, and the registry is the answer, not one of the questions.
const trialFiles = readdirSync(join(ROOT, 'tools'))
  .filter((f) => /trial|journey/.test(f) && f.endsWith('.mjs') && f !== 'trial-all.mjs')
  .map((f) => `tools/${f}`);

check('CONTROL: the scan actually finds trials', trialFiles.length >= 6, `${trialFiles.length} found`);

const unreachable = trialFiles.filter((f) => !registryFiles.includes(f) && !TEST_CHAIN.includes(f));
check('every trial is either in the registry or in npm test',
  unreachable.length === 0,
  unreachable.length ? `NOTHING RUNS: ${unreachable.join(', ')}` : '');

// And the converse, so a registry entry cannot point at a file that does not exist: a registry that
// lists phantom trials would make the coverage above look satisfied while running nothing.
const phantom = registryFiles.filter((f) => {
  try { readFileSync(join(ROOT, f)); return false; } catch { return true; }
});
check('no registry entry points at a missing file', phantom.length === 0, phantom.join(', '));

console.log('  --- a read-only label must be earned ---');

// Ask the registry which of its entries claim to write nothing, by reading the marker it prints.
const safeIds = [...listOut.matchAll(/^\s+safe\s+(\S+)/gm)].map((m) => m[1]);
check('CONTROL: some entries are claimed read-only', safeIds.length >= 1, `${safeIds.length}`);

// Map id -> file by walking the printed block, since the id and the path are on the same line.
const idToFile = {};
for (const m of listOut.matchAll(/^\s+(?:WRITES|safe)\s+(\S+)\s+(tools\/[a-z0-9-]+\.mjs)/gm)) idToFile[m[1]] = m[2];

// Writing to the PUBLIC relay needs TWO things at once, and a check that looks at only one of them
// gets it wrong in a different direction each time:
//   * the route must be state-changing. `remote-mcp` POSTs to /mcp, but /mcp is the read-only
//     window and its one writable tool must REFUSE -- which that trial asserts. Route alone would
//     wrongly condemn it.
//   * the host must be the live relay. `bridge-trial` POSTs /admission/bind and /admission/verdict,
//     but at a LOCAL stand-in relay it starts itself so that relay can lie. Host alone would wrongly
//     condemn that one instead.
// Both dimensions, or the label means nothing in one direction or the other.
const LIVE_HOST = 'agent-commons.huyxkhoa.workers.dev';
const STATE_CHANGING = /['"`](\/admission[a-z/]*|\/messages)['"`]/;
const writesToPublicRelay = (src) =>
  /method:\s*'POST'/.test(src) && STATE_CHANGING.test(src) && src.includes(LIVE_HOST);

for (const id of safeIds) {
  const file = idToFile[id];
  if (!file) { check(`read-only entry ${id} names a file`, false); continue; }
  const src = readFileSync(join(ROOT, file), 'utf8');
  check(`read-only '${id}' does not write to the PUBLIC relay`,
    !writesToPublicRelay(src),
    src.includes(LIVE_HOST) ? `POSTs a state-changing route on ${LIVE_HOST}` : '');
}

// CONTROL: the predicate must be capable of returning true, or every green result above is vacuous.
// A writing trial that names the live host and POSTs is proof the detection works.
const detectedWriter = registryIds
  .filter((i) => !safeIds.includes(i))
  .map((i) => idToFile[i])
  .filter(Boolean)
  .find((f) => writesToPublicRelay(readFileSync(join(ROOT, f), 'utf8')));
check('CONTROL: the predicate CAN detect a writer', Boolean(detectedWriter),
  'if no writing trial trips it, the read-only checks prove nothing');
// ...and every trial the registry calls a writer must actually be one, or the split is decorative.
// One case cannot be settled by reading source at all: `stranger-live` writes from a CHILD PROCESS it
// spawns over stdio, so its own file contains no POST to find. Static analysis is honestly incapable
// here, and the fix is to make the exception DECLARED rather than to loosen the guard until it stops
// complaining. A new trial of that shape must say so out loud; it cannot slip in by being invisible.
const declaredInvisible = new Set(
  [...listOut.matchAll(/^\s+WRITES\s+(\S+)\s+\S+\s+\[writes via ([a-z-]+)/gm)].map((m) => m[1])
);
check('CONTROL: the list reports at least one declared-invisible writer',
  declaredInvisible.size >= 1, `found ${[...declaredInvisible].join(', ') || 'none'}`);

for (const id of registryIds.filter((i) => !safeIds.includes(i))) {
  const f = idToFile[id];
  if (!f) continue;
  const visible = writesToPublicRelay(readFileSync(join(ROOT, f), 'utf8'));
  if (visible) {
    check(`writer '${id}' is genuinely detected as a writer`, true);
  } else {
    check(`writer '${id}' is invisible to static analysis, and SAYS SO`,
      declaredInvisible.has(id),
      'an undetectable writer must declare why, or the read-only label above cannot be trusted');
  }
}

// The inverse guard: a writing trial must NOT be in the default gate. That is the actual harm --
// debris and KV cost on every commit -- so it is asserted rather than left to care.
for (const id of registryIds.filter((i) => !safeIds.includes(i))) {
  const file = idToFile[id];
  if (!file) continue;
  check(`writing trial '${id}' is kept OUT of npm test`, !TEST_CHAIN.includes(file),
    'a trial that writes to the public relay must not run on every regression');
}

console.log('  --- the aggregator fails loudly, not quietly ---');

const bogus = spawnSync(process.execPath, [join(ROOT, 'tools', 'trial-all.mjs'), '--only', 'no-such-trial'], { cwd: ROOT, encoding: 'utf8' });
check('an unknown trial name exits 2 rather than running nothing silently', bogus.status === 2, `exit ${bogus.status}`);

// The default run must be the SAFE set. If the default ever became the full set, `npm run trial:all`
// would start spending KV writes and leaving debris the first time a human typed it casually.
// Exercised with the offline negative control, so this check itself touches nothing.
const safeRun = spawnSync(process.execPath, [join(ROOT, 'tools', 'trial-all.mjs'), '--only', 'stranger-offline'], { cwd: ROOT, encoding: 'utf8' });
const safeOut = `${safeRun.stdout || ''}${safeRun.stderr || ''}`;
check('CONTROL: a named trial actually runs and passes', safeRun.status === 0, `exit ${safeRun.status}`);
check('  ...and reports what it did', /1 trial\(s\) passed/.test(safeOut), safeOut.trim().split('\n').slice(-3).join(' / '));
// A --only run skipped the rest for an unrelated reason. Claiming it skipped "trials that write to
// the public relay" would put a false statement into the output of the command whose entire job is
// to stop false statements about coverage.
check('a --only run does not claim to be skipping writers',
  !/Skipping \d+ trial\(s\) that write/.test(safeOut),
  'the skip reason must match the actual reason');
// And the safe path must still advertise how to reach the rest, or a reader takes it as full cover.
check('the registry tells a reader how to reach the writing trials', /trial:all:live/.test(listOut));

// A trial whose precondition is absent must be reported as NOT RUN, in its own category: never a
// pass (that would claim evidence that does not exist) and never a failure (that would blame the
// code for a missing stick).
const notRunRun = spawnSync(process.execPath, [join(ROOT, 'tools', 'trial-all.mjs'), '--only', 'permit-bridge'], { cwd: ROOT, encoding: 'utf8' });
const nrOut = `${notRunRun.stdout || ''}${notRunRun.stderr || ''}`;
if (!process.env.AC_STICK) {
  check('a trial needing a stick is NOT RUN, not silently passed', /NOT RUN/.test(nrOut), nrOut.trim().split('\n').slice(-4).join(' / '));
  check('  ...and says why', /AC_STICK/.test(nrOut));
  check('  ...and is carried into the summary', /does NOT cover/.test(nrOut), 'a not-run trial that vanishes from the summary is the hole this file exists to close');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
