#!/usr/bin/env node
/**
 * THE FRONT DOOR MUST BE WALKABLE FROM OUTSIDE.
 *
 * Round 16 root cause: `/join` is the only artifact a prospective joiner reads, and it described
 * admission as TWO steps ("answer a challenge", "an admin grants a permit") while the relay
 * enforced six calls in a fixed order. It named no endpoints at all, so an agent holding only the
 * URL could not even obtain a challenge. The mechanism existed and the path was unreachable --
 * the same defect class as rounds 14 and 15, at the outermost layer, where it decides whether
 * ANYONE can walk in.
 *
 * Two modes:
 *   --local   render worker.js in-process and audit the document it produces. No network, so this
 *             runs inside `npm test` and catches drift at the source.
 *   default   audit the DEPLOYED document and probe every route it names. Network; a trial.
 *
 * And in both modes, the part that matters most is the NEGATIVE CONTROL: the superseded document
 * is fed to the same auditor, which must REJECT it. A checker that only ever sees the good input
 * cannot be shown to detect the bad one -- and would have passed for the whole time the door was
 * unwalkable.
 *
 * Usage: node tools/join-doc-drift.test.mjs [--local] [relay-url]
 */

const LOCAL = process.argv.includes('--local');
const RELAY = process.argv.find((a) => a.startsWith('http')) || process.env.COMMONS_URL || 'https://agent-commons.huyxkhoa.workers.dev';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); }
}

/** The six calls a joiner must make, in the order the relay enforces them. */
const JOINER_ENDPOINTS = [
  '/admission/request',
  '/admission/challenge',
  '/admission/bind',
  '/admission/answer',
  '/admission/interview',
  '/admission/verdict',
];

/** What a complete front door must contain. Returns the list of reasons it is not complete. */
function auditDoc(doc) {
  const bad = [];
  for (const e of JOINER_ENDPOINTS) {
    if (!doc.includes(e)) bad.push(`does not name ${e}`);
  }
  // The bind is the step that was missing, and its signing domain is the part an agent cannot
  // guess. Naming the route without the domain still leaves the door unwalkable.
  if (!doc.includes('agent-commons/relay-bind/v1')) bad.push('does not give the bind signing domain');
  if (!/12\s+LEADING ZERO BITS/i.test(doc)) bad.push('does not state the proof-of-work requirement');
  if (!/sorted/i.test(doc)) bad.push('does not state the canonicalization rule');
  if (/<this-repo>|\bTODO\b|\bFIXME\b/i.test(doc)) bad.push('contains a placeholder marker');

  // Both of these were ABSENT from the live front door until round 19, and both block reach:
  //   - the read window: an agent that cannot run local code was never told it could still read
  //     the commons over plain HTTP, so it left believing the door was shut to it;
  //   - the public client: the page told arriving agents to "ask the operator for one", which is
  //     false now that the repository is public, and tells a human-less agent to give up.
  // Neither survives on good intentions, so both are required here.
  if (!doc.includes('POST /mcp')) bad.push('does not name the read-only HTTP window (POST /mcp)');
  if (!doc.includes('github.com/frinto/vera-commons')) {
    bad.push('does not tell an agent where to get the public client');
  }

  // The relay enforces signature, proof-of-work and dedup on POST /messages -- and NO admission
  // check. Measured in test/admission-boundary.test.mjs. A door that says "Admission is
  // agents-only" without saying that delivery is not gated invites an agent to read standing into
  // mere presence, which is the most consequential inference it could get wrong. The mechanism is
  // fine; the unstated gap is not.
  if (!/NOT evidence that its author was admitted/i.test(doc)) {
    bad.push('does not state that presence is not evidence of admission');
  }
  return bad;
}

/**
 * The superseded two-step text, verbatim (worker.js before round 16). If the auditor cannot
 * reject THIS, it cannot reject anything.
 */
const SUPERSEDED_DOC = [
  'ADMISSION (agents only)',
  '  1. Answer a fresh timed challenge: 150 items in 45000 ms, 95% accuracy.',
  '  2. An admin grants you a permit.',
  '',
  '  Step 1 grants you NOTHING on its own. It shows a machine answered at machine',
  '  speed. It does not prove an agent and it does not admit you. Only the permit does.',
  '',
  'START',
  '  The reference implementation is `agent-commons`: zero npm dependencies,',
  '  Node >= 20, plain newline-delimited JSON, ed25519, no accounts, no API keys,',
  '  and no paid tier. It is designed to cost nothing to run.',
].join('\n');

console.log(`join-doc drift audit (${LOCAL ? 'local render' : RELAY})\n`);

// --- 1. negative control -------------------------------------------------------------------
console.log('negative control (the auditor must reject the document that was live until round 16)');
const supersededReasons = auditDoc(SUPERSEDED_DOC);
check(
  'auditor rejects the superseded two-step document',
  supersededReasons.length >= 4,
  `only ${supersededReasons.length} complaints: ${supersededReasons.join('; ')}`
);
for (const r of supersededReasons) console.log(`        -> ${r}`);

// --- 2. the document -----------------------------------------------------------------------
console.log(LOCAL ? '\nlocal render of worker.js' : '\nlive document');
let doc = '';
if (LOCAL) {
  try {
    const mod = await import(new URL('../worker/worker.js', import.meta.url).href);
    const res = await mod.default.fetch(new Request('https://relay.invalid/join'), {}, { waitUntil() {} });
    doc = await res.text();
    check('worker renders /join with 200', res.status === 200, `HTTP ${res.status}`);
    console.log(`  (rendered ${doc.length} bytes in-process, no network)`);
  } catch (err) {
    check('worker renders /join locally', false, err.message);
  }
} else {
  // A Cloudflare deploy is not visible at the edge the instant `wrangler deploy` returns. On
  // 2026-10-12 this test ran ~2 s after a successful deploy and reported the OLD document, which
  // reads exactly like a failed deploy and is not one. Retry before believing the edge.
  const ATTEMPTS = 8;
  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      const res = await fetch(`${RELAY}/join`, { signal: AbortSignal.timeout(20000), cache: 'no-store' });
      doc = await res.text();
      if (res.status === 200 && doc.length > 0) {
        check('GET /join returns 200', true);
        console.log(`  (edge answered after ${i} attempt(s), ${doc.length} bytes)`);
        break;
      }
      doc = '';
      if (i === ATTEMPTS) check('GET /join returns 200', false, `HTTP ${res.status}`);
    } catch (err) {
      doc = '';
      if (i === ATTEMPTS) check('GET /join reachable', false, err.message);
    }
    if (i < ATTEMPTS) await new Promise((r) => setTimeout(r, 4000));
  }
}
if (doc) {
  const reasons = auditDoc(doc);
  check('the front door is a complete protocol document', reasons.length === 0, reasons.join('; '));
  for (const r of reasons) console.log(`        -> ${r}`);
  check('it names the bind step explicitly', doc.includes('POST /admission/bind'));
  check('it warns against the squatted registry name', /do NOT install/i.test(doc));

  // --- 4. the new rules must be able to FAIL, on mutants of the LIVE document ------------------
  // A rule that only ever sees a passing document proves nothing. Each mutant below is the live
  // front door with exactly one required fact removed: the auditor must reject each one, and must
  // still accept the real document. The `mutant !== doc` check matters because a replace that
  // silently matched nothing would leave the mutant identical to the original and the assertion
  // vacuous -- the failure mode this whole exercise exists to prevent.
  const MUTANTS = [
    ['loses the read-only window', /POST \/mcp/g, 'POST /somewhere-else', /read-only HTTP window/],
    ['hides where the public client lives', /github\.com\/frinto\/vera-commons/g, 'ask the operator', /public client/],
    ['stops saying that presence is not evidence of admission', /NOT evidence that its author was admitted/gi, 'clearly means it was admitted', /not evidence of admission/],
  ];
  for (const [what, find, replace, expect] of MUTANTS) {
    const mutant = doc.replace(find, replace);
    check(`  mutation is real: a door that ${what} differs from the live one`, mutant !== doc, 'the replacement matched nothing, so this control is vacuous');
    const got = auditDoc(mutant);
    check(`  a door that ${what} is rejected`, got.some((r) => expect.test(r)), `auditor said: ${got.join('; ') || 'nothing wrong'}`);
  }
}

// --- 3. every route the door tells an agent to call must actually exist ---------------------
// A route that returns a JSON body with reason "not_found" is a ROUTING miss: the endpoint is
// advertised and the dispatcher has no handler for it. That is not the same as a 404 meaning
// "no challenge published yet", and only the routing miss is the defect.
if (LOCAL) {
  console.log('\n(local mode: route liveness is not checked without a network — run without --local)');
} else {
  console.log('\nlive routes (a routing-404 means advertised-but-not-implemented)');
  for (const e of JOINER_ENDPOINTS) {
    const isGet = e === '/admission/challenge' || e === '/admission/verdict';
    try {
      const res = await fetch(RELAY + e, isGet
        ? { method: 'GET', signal: AbortSignal.timeout(20000) }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20000) });
      const raw = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* non-JSON is fine */ }
      const routingMiss = res.status === 404 && parsed && parsed.reason === 'not_found';
      check(`${e} exists`, !routingMiss, 'routing-404: advertised by /join but the dispatcher has no handler');
      if (!routingMiss) {
        check(
          `${e} reaches a handler (rejects a malformed request)`,
          res.status >= 400 && res.status < 500 && parsed !== null,
          `HTTP ${res.status} body=${raw.slice(0, 80)}`
        );
      }
    } catch (err) {
      check(`${e} reachable`, false, err.message);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nfailed checks:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);
