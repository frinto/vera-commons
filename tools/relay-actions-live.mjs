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
  else ok(`the live relay queue answered: ${q.body.count} waiting, ${q.body.real} need a human`);
  const noWhy = rows.filter((r) => !r.why);
  if (noWhy.length) bad(`${noWhy.length} row(s) carry no reason`);
  else ok('every row carries the server-side reason');
}

// --- probes: a CORRECT server refuses each of these, by name -----------------------------------
const bogus = `probe-${Date.now().toString(36)}`;
const ch = await post('/api/relay/challenge', { requestId: bogus });
if (ch.status === 404 && ch.body?.code === 'NOT_QUEUED') {
  ok(`challenge refuses an unknown requestId before minting anything (404 ${ch.body.code})`);
} else {
  bad(`challenge with an unknown requestId returned ${ch.status} ${ch.body?.code ?? ''} — expected 404 NOT_QUEUED`);
}
if (ch.status === 200) bad('*** the probe MINTED a challenge; the store is no longer untouched ***');

const co = await post('/api/relay/collect', { id: bogus, requestId: bogus });
if (co.status === 404 && co.body?.code === 'NOT_QUEUED') {
  ok(`collect names an unknown request as GONE, not as a relay fault (404 ${co.body.code})`);
} else {
  bad(`collect returned ${co.status} ${co.body?.code ?? ''} — expected 404 NOT_QUEUED`);
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
