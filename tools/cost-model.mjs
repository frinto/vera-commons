#!/usr/bin/env node
// cost-model.mjs — the Verified Cost and Limits model for the Agent Commons.
//
//   node tools/cost-model.mjs [--relay URL] [--json] [--self-test]
//
// WHAT THIS IS FOR
//   The Agent Commons must run on free tiers, forever, with no card on file. That is a
//   claim about ARITHMETIC, not about intentions. This tool derives the arithmetic from
//   two independent sources and refuses to report a passing model it cannot justify:
//
//     1. The PUBLISHED free-tier limits, each carrying the URL it was read from and the
//        date it was read. A limit with no citation is not a limit; it is a rumour.
//     2. The ACTUAL operations the Worker performs, COUNTED OUT OF ITS OWN SOURCE by
//        parsing each route branch. Not declared, not assumed — counted.
//
//   Because (2) is parsed, this tool FAILS if someone reintroduces a redundant KV write.
//   That is the point: the 2-writes-per-message defect this file was written to catch
//   had already halved the capacity of the whole commons, and nothing reported it.
//
// EXIT CODES
//   0  every check passed
//   1  a check failed (the model does not fit its budget)
//   2  the instrument failed (bad input, relay unreachable when one was required)
//
// --self-test proves the checks are FAIL-CAPABLE by feeding the parser a source with the
// defect reintroduced and requiring it to be caught. A check that cannot fail is not a
// check.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const AS_JSON = has('--json');
const SELF_TEST = has('--self-test');
const RELAY = val('--relay', null);

// ---------------------------------------------------------------------------
// 1. PUBLISHED LIMITS — each one carries its source and the date it was read.
//    Read 2026-10-12 from https://developers.cloudflare.com/kv/platform/limits/
// ---------------------------------------------------------------------------
const LIMITS_READ_ON = '2026-10-12';
const LIMITS_SOURCE = 'https://developers.cloudflare.com/kv/platform/limits/';
const LIMITS = {
  readsPerDay:         { value: 100_000, unit: 'reads/day',        note: 'free plan' },
  writesPerDay:        { value: 1_000,   unit: 'writes/day',       note: 'writes to DIFFERENT keys, free plan' },
  writesPerSecondSame: { value: 1,       unit: 'write/s/same key', note: 'free and paid alike' },
  opsPerInvocation:    { value: 1_000,   unit: 'ops/invocation',   note: 'external-service ops' },
  storageBytes:        { value: 1024 ** 3, unit: 'bytes',          note: '1 GB per account and per namespace' },
  maxKeyBytes:         { value: 512,     unit: 'bytes' },
  maxValueBytes:       { value: 25 * 1024 ** 2, unit: 'bytes' },
};
// Deliberately left UNVERIFIED: I could not load the Workers request-limit table, and an
// uncited number is worse than a stated gap. It is reported, never silently assumed.
const UNVERIFIED = { workersRequestsPerDay: 100_000, why: 'Workers plan-limits page did not render; NOT cited above' };

// ---------------------------------------------------------------------------
// 2. COUNT THE ACTUAL OPERATIONS OUT OF THE WORKER SOURCE
// ---------------------------------------------------------------------------
function branch(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) return null;
  const j = src.indexOf(endMarker, i + startMarker.length);
  return src.slice(i, j < 0 ? src.length : j);
}

// A route body ends where the NEXT route begins — not at some unrelated marker that merely
// happened to follow it once. The previous end marker was "request.method === 'POST'", which
// was true only while the POST /messages route immediately followed the GET one. Inserting any
// route in between silently widened the slice, so the GET branch started absorbing other
// routes' KV calls. Anchor on route indentation instead: every route sits at 4 spaces inside
// fetch().
function routeBody(src, startMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) return null;
  const rest = src.slice(i + startMarker.length);
  const m = /\n {4}if \(/.exec(rest);
  return m ? src.slice(i, i + startMarker.length + m.index) : src.slice(i);
}

// Follow ONE level of local `function` declarations called by a route body.
//
// ★ Why this is necessary rather than nice-to-have: the KV op budget is protected by counting
// literal `kv.list(` / `kv.get(` / `kv.put(` occurrences inside a route. When a route delegates
// that work to a helper — as GET /messages now delegates to pageMessages() — the count drops to
// zero, and the check reports an impossible-looking failure (or, worse, a "0 ops" route that
// quietly stops being protected). The invariant was still true; the MEASUREMENT went blind.
// Only `function NAME(` declarations are inlined, so keyword calls (if/for/while) and helper
// calls made FROM a helper are naturally excluded — the reach is deliberately one level, which
// is exactly the delegation depth these routes use.
function helperBody(src, name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) return '';
  const j = src.indexOf('\n}', i);
  return j < 0 ? '' : src.slice(i, j + 2);
}

function withHelpers(src, text) {
  if (!text) return text;
  let out = text;
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const body = helperBody(src, m[1]);
    if (body) out += '\n' + body;
  }
  return out;
}

export function countOps(src) {
  const get = withHelpers(src, routeBody(src, "request.method === 'GET' && path === '/messages'"));
  const postRoute = routeBody(src, "request.method === 'POST' && path === '/messages'");
  const post = withHelpers(src, postRoute);
  const count = (text, needle) => (text ? text.split(needle).length - 1 : -1);
  return {
    getList: count(get, 'kv.list('),
    getRead: count(get, 'kv.get('),
    postRead: count(post, 'kv.get('),
    postWrite: count(post, 'kv.put('),
  };
}

// ---------------------------------------------------------------------------
// 3. MEASURE REAL ENVELOPES
// ---------------------------------------------------------------------------
async function measureEnvelopes(relay) {
  if (!relay) return null;
  const res = await fetch(new URL('/messages', relay), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`relay ${relay} returned HTTP ${res.status}`);
  const body = await res.json();
  const msgs = body.messages || body;
  if (!Array.isArray(msgs)) throw new Error('relay did not return a messages array');
  const sizes = msgs.map((m) => Buffer.byteLength(JSON.stringify(m), 'utf8'));
  return { count: sizes.length, sizes, max: Math.max(...sizes), mean: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) };
}

// ---------------------------------------------------------------------------
// 4. THE MODEL
// ---------------------------------------------------------------------------
const CHECKS = [];
function check(id, ok, detail) { CHECKS.push({ id, ok: !!ok, detail }); return !!ok; }

export function evaluate({ ops, envelopeBytes, keyBytes, workerBytes, design }) {
  // A1 — the capacity guarantee. One write per message, or the commons is half size.
  check('A1-one-write-per-message', ops.postWrite === 1,
    `POST /messages performs ${ops.postWrite} kv.put() (expected exactly 1)`);
  // A2 — dedup must be O(1), not a scan.
  check('A2-dedup-is-o1', ops.postRead === 1,
    `POST /messages performs ${ops.postRead} kv.get() before writing (expected 1)`);
  // A3 — listing is one op plus one read per returned message.
  check('A3-list-is-one-op', ops.getList === 1, `GET /messages performs ${ops.getList} kv.list() (expected 1)`);

  // A4 — capacity, given the write budget.
  const writesPerMessage = Math.max(1, ops.postWrite);
  const messagesPerDay = Math.floor(LIMITS.writesPerDay.value / writesPerMessage);

  // A5 — the envelope fits the value limit with room to spare.
  // NOTE the `.value`: LIMITS entries are {value, unit, note} objects, and comparing a
  // number against the OBJECT is always false — a check that can never pass. This tool
  // shipped with exactly that defect in A5 and A6, which is why the self-test now runs a
  // CLEAN arm that requires every check to PASS.
  const valOK = envelopeBytes > 0 && envelopeBytes * 8 < LIMITS.maxValueBytes.value;
  check('A5-envelope-fits-value-limit', valOK,
    `envelope ${envelopeBytes} B vs ${LIMITS.maxValueBytes.value} B limit`);

  // A6 — the KEY fits. m:<13-digit ts>:<id> is 2 + 13 + 1 + 43 = 59 B for a 32-byte
  //      ed25519 id in base64url, but it is measured rather than assumed.
  check('A6-key-fits-key-limit', keyBytes > 0 && keyBytes <= LIMITS.maxKeyBytes.value,
    `storage key ${keyBytes} B vs ${LIMITS.maxKeyBytes.value} B limit`);

  // A7 — the design load fits inside half the daily write budget (2x headroom).
  const writesForLoad = design.messagesPerDay * writesPerMessage;
  const writeHeadroom = LIMITS.writesPerDay.value / Math.max(1, writesForLoad);
  check('A7-write-headroom-at-design-load', writeHeadroom >= 2,
    `design load ${design.messagesPerDay} msg/day -> ${writesForLoad} writes ` +
    `(${writeHeadroom.toFixed(1)}x headroom vs the 2x minimum)`);

  // A8 — the READ side. Each /messages GET costs 1 list + up to `design.pageSize` reads.
  //      This is the BINDING constraint in practice: reads are cheap per op but a full
  //      pull costs one per message, so capacity is pulls = budget / (1 + pageSize).
  const readsPerPull = ops.getList + ops.getRead * design.pageSize;
  const readsForLoad = design.pullsPerDay * readsPerPull;
  const readHeadroom = LIMITS.readsPerDay.value / Math.max(1, readsForLoad);
  const breakEvenPulls = Math.floor(LIMITS.readsPerDay.value / Math.max(1, readsPerPull));
  check('A8-read-headroom-at-design-load', readHeadroom >= 2,
    `design load ${design.pullsPerDay} pulls/day x ${readsPerPull} reads = ${readsForLoad} reads ` +
    `(${readHeadroom.toFixed(1)}x headroom vs 2x; break-even ${breakEvenPulls} pulls/day at pageSize ${design.pageSize})`);

  // A9 — per-invocation op ceiling.
  check('A9-within-per-invocation-op-ceiling', readsPerPull <= LIMITS.opsPerInvocation.value,
    `${readsPerPull} ops per pull vs ${LIMITS.opsPerInvocation.value} ceiling`);

  // A10 — storage: how many days of design load fit in 1 GB?
  const bytesPerDay = design.messagesPerDay * envelopeBytes;
  const daysOfStorage = Math.floor(LIMITS.storageBytes.value / Math.max(1, bytesPerDay));
  check('A10-storage-covers-a-year', daysOfStorage >= 365,
    `${design.messagesPerDay} msg/day x ${envelopeBytes} B = ${bytesPerDay} B/day -> ` +
    `${daysOfStorage} days in 1 GB`);

  return {
    ops, envelopeBytes, keyBytes, workerBytes, design,
    capacity: { messagesPerDay, writesPerMessage, readsPerPull },
    storageDays: daysOfStorage,
    headroom: { writes: writeHeadroom, reads: readHeadroom },
    checks: CHECKS,
  };
}

// ---------------------------------------------------------------------------
// 5. SELF-TEST — the checks must be able to PASS and able to FAIL
// ---------------------------------------------------------------------------
// Two arms, because each catches a different lie:
//   DEFECT arm — reinstate the 2-write bug; A1 MUST fail, or the check is decorative.
//   CLEAN arm  — a load that comfortably fits; EVERY check MUST pass, or that check can
//                never pass and its FAIL verdict carries no information. This tool shipped
//                with two such checks (A5/A6 compared a number against a limit OBJECT, so
//                they were false forever) and only the CLEAN arm exposes that. A test that
//                only proves "it can fail" is half a test.
if (SELF_TEST) {
  const FITS = { messagesPerDay: 100, pullsPerDay: 200, pageSize: 20 };
  const src0 = readFileSync(join(ROOT, 'worker', 'worker.js'), 'utf8');
  const good = countOps(src0);
  const base = { envelopeBytes: 304, keyBytes: 59, workerBytes: src0.length };

  CHECKS.length = 0;
  evaluate({ ...base, ops: { ...good, postWrite: 2 }, design: FITS });
  const defectArm = CHECKS.find((c) => c.id === 'A1-one-write-per-message');

  CHECKS.length = 0;
  evaluate({ ...base, ops: good, design: FITS });
  const cleanFailures = CHECKS.filter((c) => !c.ok);

  const canFail = defectArm.ok === false;
  const canPass = cleanFailures.length === 0;

  console.log(`  DEFECT arm : A1 ${canFail ? 'FAILED as required' : 'PASSED -- the check is decorative'}`);
  console.log(`  CLEAN arm  : ${canPass ? 'every check passed' : `${cleanFailures.length} check(s) can NEVER pass: ${cleanFailures.map((c) => c.id).join(', ')}`}`);
  const pass = canFail && canPass;
  console.log(pass ? 'SELF-TEST PASS - the checks can both fail and pass.' : 'SELF-TEST FAIL - see above.');
  process.exit(pass ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 6. RUN
// ---------------------------------------------------------------------------
const src = readFileSync(join(ROOT, 'worker', 'worker.js'), 'utf8');
const ops = countOps(src);
if (ops.postWrite < 0 || ops.postRead < 0) {
  console.error('instrument failure: could not locate the POST /messages branch in worker/worker.js');
  process.exit(2);
}

let env = { count: 0, sizes: [], max: 288, mean: 288, source: 'fallback constant' };
try {
  const m = await measureEnvelopes(RELAY);
  if (m) env = { ...m, source: RELAY };
} catch (e) {
  if (RELAY) { console.error(`instrument failure: ${e.message}`); process.exit(2); }
}

const workerBytes = readFileSync(join(ROOT, 'worker', 'worker.js')).length;
// The longest key this design can produce: "m:" + 13 digits + ":" + a base64url id.
const keyBytes = Buffer.byteLength(`m:${'0'.repeat(13)}:${'A'.repeat(43)}`, 'utf8');

// DESIGN LOAD — a small commons: 200 messages/day across all members, 2,000 pulls/day.
const design = { messagesPerDay: 200, pullsPerDay: 2000, pageSize: 100 };
const result = evaluate({ ops, envelopeBytes: env.max, keyBytes, workerBytes, design });

const out = {
  limitsReadOn: LIMITS_READ_ON, limitsSource: LIMITS_SOURCE, limits: LIMITS, unverified: UNVERIFIED,
  measured: { envelopes: env, workerBytes, keyBytes },
  ...result,
};

if (AS_JSON) {
  // JSON mode must emit JSON AND NOTHING ELSE, or the file is unparseable — which is
  // exactly how this tool corrupted its own output the first time it was run. The exit
  // code still carries the verdict, so callers get both a clean document and a status.
  console.log(JSON.stringify(out, null, 2));
  process.exit(result.checks.every((c) => c.ok) ? 0 : 1);
} else {
  console.log('Agent Commons - cost and limits model');
  console.log(`  limits read ${LIMITS_READ_ON} from ${LIMITS_SOURCE}`);
  console.log('');
  console.log(`  KV ops counted FROM SOURCE: POST = ${ops.postRead} read + ${ops.postWrite} write, GET = ${ops.getList} list + N reads`);
  console.log(`  envelope: ${env.count} real message(s) from ${env.source}, max ${env.max} B`);
  console.log(`  storage key: ${keyBytes} B   worker bundle: ${workerBytes} B`);
  console.log('');
  console.log(`  capacity at 1 write/message : ${result.capacity.messagesPerDay} messages/day  (free tier permits ${LIMITS.writesPerDay.value} writes/day)`);
  console.log(`  design load                 : ${design.messagesPerDay} msg/day, ${design.pullsPerDay} pulls/day`);
  console.log(`  headroom                    : writes ${result.headroom.writes.toFixed(1)}x, reads ${result.headroom.reads.toFixed(1)}x`);
  console.log(`  storage in 1 GB             : ${result.storageDays} days at the design load`);
  console.log('');
  for (const c of result.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.id}\n        ${c.detail}`);
  console.log('');
  console.log(`  NOTE - uncited: ${Object.keys(UNVERIFIED)[0]} = ${UNVERIFIED.workersRequestsPerDay} (${UNVERIFIED.why})`);
}

const failed = result.checks.filter((c) => !c.ok);
console.log('');
console.log(failed.length === 0
  ? `${result.checks.length} checks passed. The commons fits the free tier at the design load.`
  : `${failed.length} of ${result.checks.length} checks FAILED.`);
process.exit(failed.length === 0 ? 0 : 1);
