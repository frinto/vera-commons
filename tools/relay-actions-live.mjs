#!/usr/bin/env node
// Live acceptance for the RELAY ACTIONS -- run against the DEPLOYED console and the REAL relay.
//
// Three questions this answers, and a fourth it deliberately does not:
//   1. Does the page an operator actually receives offer the four pipeline steps? (unit tests read
//      the repo; this reads what the STICK serves.)
//   2. Do the routes those buttons call answer on the real relay, with the codes the page reports?
//   3. Do the probes leave the store EXACTLY as they found it? This is the one that matters: a probe
//      that quietly mints an admission is not a probe, it is a change to the system under test.
//   4. It does NOT adopt a verdict or decide anything. Adopting a decision is the admin's act; this
//      tool must not take it, even as a test.
//
// The probes are chosen so that a CORRECT server refuses them for a stated reason:
//   - a requestId that is not in the relay queue  -> 404 NOT_QUEUED (checked BEFORE anything is minted)
//   - a collect for a request nobody answered     -> 409 NO_ANSWERS_YET
// A refusal with a named code is positive evidence the route is reachable and gated. A 200 would be
// the alarming outcome here.
//
// usage: node tools/relay-actions-live.mjs [--stick E:\] [--port 7813] [--relay <url>]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const STICK = arg('--stick', 'E:\\');
const PORT = Number(arg('--port', '7813'));
const RELAY = arg('--relay', 'https://agent-commons.huyxkhoa.workers.dev');
const BASE = `http://127.0.0.1:${PORT}`;
const APP = join(STICK, 'console', 'app.mjs');

let pass = 0;
let fail = 0;
const ok = (m) => { pass += 1; console.log('  PASS ' + m); };
const bad = (m) => { fail += 1; console.log('  FAIL ' + m); };
const info = (m) => console.log('       ' + m);

if (!existsSync(APP)) {
  console.log(`\n  Nothing to test: ${APP} does not exist. Deploy first (tools/deploy-stick.mjs).\n`);
  process.exit(2);
}

console.log(`\n--- live relay actions, as the STICK serves them (${RELAY}) ---`);

const child = spawn(process.execPath, [APP, '--port', String(PORT), '--no-browser', '--relay', RELAY], {
  cwd: join(STICK, 'console'), stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '', err = '', exited = null;
child.stdout.on('data', (c) => { out += String(c); });
child.stderr.on('data', (c) => { err += String(c); });
child.on('exit', (code) => { exited = code; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => { try { child.kill(); } catch { /* already gone */ } };
process.on('exit', cleanup);

await sleep(4500);

if (exited !== null) {
  bad(`the deployed console EXITED immediately (code ${exited})`);
  for (const l of (err || out).split('\n').filter(Boolean).slice(0, 8)) info('| ' + l);
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(1);
}
ok('the deployed console is running');

const tm = /\?t=([A-Za-z0-9_-]{10,})/.exec(out);
const TOKEN = tm ? tm[1] : null;
if (!TOKEN) {
  bad('no per-run token was printed; every route would answer 401');
  for (const l of (out || err).split('\n').filter(Boolean).slice(0, 6)) info('| ' + l);
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(1);
}
ok('the console issued a per-run token');

// One retry on a network error, and -- this is the part that matters -- when the retry also fails,
// say what the CONSOLE said. A bare ECONNRESET cannot be told apart from "the server died", and the
// difference decides whether the finding is a flaky socket or a crash.
async function send(url, opts, label) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await sleep(300);
    }
  }
  info(`network error on ${label}: ${lastErr?.cause?.code ?? lastErr?.message}`);
  if (exited !== null) bad(`the console EXITED (code ${exited}) while handling ${label}`);
  else info('(the console is still running, so this was a socket-level failure at the probe)');
  for (const l of (err || out).split('\n').filter(Boolean).slice(-6)) info('| ' + l);
  throw lastErr;
}

const get = async (path, t = TOKEN) => {
  const res = await send(`${BASE}${path}${path.includes('?') ? '&' : '?'}t=${t}`, {}, `GET ${path}`);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* the page is HTML */ }
  return { status: res.status, body, text };
};
const post = async (path, payload) => {
  const res = await send(`${BASE}${path}?t=${TOKEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, `POST ${path}`);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, body, text };
};

// --- the page the operator actually receives --------------------------------------------------
const page = await get('/');
if (page.status !== 200) {
  bad(`GET / returned ${page.status}, expected 200`);
} else {
  const wanted = ['async function relayAction', 'Issue challenge', 'Collect answers',
    'Pull identity claim', 'Pull interview', 'Waiting to join over the relay'];
  const missing = wanted.filter((m) => !page.text.includes(m));
  if (missing.length) bad('the served page is missing: ' + missing.join(', '));
  else ok(`the served page offers all four pipeline steps (${page.text.length} bytes)`);
  // The route the page must NEVER reach from this panel. Named in a comment on purpose.
  if (/["']\/api\/relay\/verdict/.test(page.text)) bad('the served page WIRES the verdict-adopting route');
  else ok('the served page does not wire the verdict-adopting route');
}

// --- the queue, read from the live relay ------------------------------------------------------
const before = await get('/api/state');
if (before.status !== 200) bad(`GET /api/state returned ${before.status}`);
const q = await get('/api/relay/queue');
if (q.status !== 200) {
  bad(`GET /api/relay/queue returned ${q.status} (the relay may be unreachable)`);
} else {
  const rows = Array.isArray(q.body.waiting) ? q.body.waiting : [];
  const unclassified = rows.filter((r) => r.kind !== 'real' && r.kind !== 'trial');
  if (unclassified.length) bad(`${unclassified.length} row(s) reached the page with no kind`);
  else ok(`the live relay queue answered: ${q.body.counts?.waiting ?? '?'} waiting, ${q.body.real} need a human`);
  const noWhy = rows.filter((r) => !r.why);
  if (noWhy.length) bad(`${noWhy.length} row(s) carry no reason`);
  else ok('every row carries the server-side reason');

  // The relay's list is its MEMORY of every request it still holds (24-hour TTL), not a waiting list.
  // Measured 2026-10-12: 22 listed, 17 already decided, and this panel said "22 waiting". So the counts
  // must add up, and the label must be checked against the relay rather than taken on trust.
  const c = q.body.counts;
  if (!c || c.listed !== rows.length || c.waiting + c.resolved + c.unknown !== c.listed) {
    bad(`counts do not add up: ${JSON.stringify(c)} against ${rows.length} row(s)`);
  } else {
    ok(`counts add up: ${c.listed} listed = ${c.waiting} waiting + ${c.resolved} decided + ${c.unknown} unchecked`);
  }
  if (rows.some((r) => !r.resolution || !['waiting', 'resolved', 'unknown'].includes(r.resolution.state))) {
    bad('a row reached the page with no resolution state -- the page cannot tell decided from pending');
  } else {
    ok('every row carries a resolution state from the known set');
  }
  // THE FALSIFIABLE PART. The console labels each row; the relay is asked independently, in this file,
  // and the two must agree on every row. A self-reported label that nothing cross-checks is how the
  // panel came to call decided handshakes "waiting" in the first place.
  const disagreements = [];
  for (const r of rows) {
    let relaySays;
    try {
      // Asked of the RELAY directly, not of the console: a console that cross-checked itself would
      // agree with itself no matter what it said.
      const v = await fetch(`${RELAY}/admission/verdict?requestId=${encodeURIComponent(r.requestId)}`,
        { signal: AbortSignal.timeout(15000) });
      relaySays = v.status === 200 ? 'resolved' : v.status === 404 ? 'waiting' : 'unknown';
    } catch { relaySays = 'unknown'; }
    if (r.resolution.state !== relaySays) {
      disagreements.push(`${r.short}: console says ${r.resolution.state}, relay says ${relaySays}`);
    }
  }
  if (disagreements.length) bad(`${disagreements.length} row(s) mislabelled: ` + disagreements.slice(0, 3).join(' | '));
  else ok(`the relay itself confirms every one of the ${rows.length} label(s) (no row called "waiting" that is already decided)`);
}

// --- probes: a CORRECT server refuses each of these, by name -----------------------------------
//
// The SHAPE of the id decides which refusal is correct. An earlier version of this file probed only
// with `probe-<hex>` -- not a valid 32-char id -- and recorded the relay's 400 as "it does not know
// this request", which is FALSE: the relay says 400 for MALFORMED and 404 for WELL-FORMED-BUT-UNKNOWN.
// Both shapes are probed below, so the distinction is measured here rather than assumed, and a
// regression to the old reading fails in this file instead of in production.
const malformed = `probe-${Date.now().toString(36)}`;   // deliberately NOT a 32-char id
const unknown32 = 'Z'.repeat(32);                        // well formed, and certainly never queued

const ch = await post('/api/relay/challenge', { requestId: unknown32 });
if (ch.status === 404 && ch.body?.code === 'NOT_QUEUED') {
  ok(`challenge refuses a well-formed but queueless requestId before minting anything (404 ${ch.body.code})`);
} else {
  bad(`challenge with a well-formed unknown requestId returned ${ch.status} ${ch.body?.code ?? ''} — expected 404 NOT_QUEUED`);
}
if (ch.status === 200) bad('*** the probe MINTED a challenge; the store is no longer untouched ***');

const co = await post('/api/relay/collect', { id: malformed, requestId: malformed });
if (co.status === 400 && co.body?.code === 'MALFORMED_REQUEST_ID') {
  ok(`collect reports a MALFORMED request id as malformed, not as a missing entry (400 ${co.body.code})`);
} else {
  bad(`collect with a malformed requestId returned ${co.status} ${co.body?.code ?? ''} — expected 400 MALFORMED_REQUEST_ID`);
}

const co2 = await post('/api/relay/collect', { id: malformed, requestId: unknown32 });
if (co2.status === 409 && co2.body?.code === 'NO_ANSWERS_YET') {
  ok(`collect reports a well-formed unknown request as "not answered yet" (409 ${co2.body.code})`
    + ' — the relay cannot tell "never queued" from "queued, nothing filed", so that is the most specific true answer');
} else {
  bad(`collect with a well-formed unknown requestId returned ${co2.status} ${co2.body?.code ?? ''} — expected 409 NO_ANSWERS_YET`);
}

const bad400 = await post('/api/relay/challenge', {});
if (bad400.status === 400) ok('challenge with no requestId at all is a 400, not a crash');
else bad(`challenge with no body returned ${bad400.status}, expected 400`);

const noTok = await fetch(`${BASE}/api/relay/challenge`, { method: 'POST' });
if (noTok.status === 401) ok('the same route without a token is 401 (the page is not the boundary)');
else bad(`challenge without a token returned ${noTok.status}, expected 401`);

// --- did any of that change the system under test? --------------------------------------------
const after = await get('/api/state');
if (before.status !== 200 || after.status !== 200) {
  bad('could not read /api/state on both sides, so "nothing changed" is UNPROVEN');
} else {
  const keys = [...new Set([...Object.keys(before.body ?? {}), ...Object.keys(after.body ?? {})])];
  const changed = keys.filter((k) => JSON.stringify(before.body?.[k]) !== JSON.stringify(after.body?.[k]));
  if (!changed.length) ok('the store is byte-identical before and after every probe');
  else {
    // A moving clock field is not a mutation. Anything else is.
    const suspicious = changed.filter((k) => !/^(now|at|time|uptime|started|ts)$/i.test(k));
    if (!suspicious.length) ok(`only clock field(s) moved (${changed.join(', ')}); no state was written`);
    else bad('the probes CHANGED state: ' + suspicious.join(', '));
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
