// RED TEAM the admin console over HTTP, as an attacker who has the URL and nothing else.
//
// Why this exists: the console page has confirms on every dangerous control, but the page is NOT the
// security boundary. Measured by hand on 2026-10-12, the boundary is the server, and these are the
// properties that have to keep holding:
//
//   1. The per-run token authorises TRANSPORT only. Without it: 401. With a wrong one: 401.
//   2. Authority is a SEPARATE check. With a valid token but a key that resolves to observer, every
//      mutating endpoint answers 403 and the store does not change -- proven by pointing a lab
//      console at a trust file whose root is a key the stick does not hold.
//   3. The decide() seam cannot be talked past:
//        - an UNBOUND admission is refused with cannot_grant_unbound_admission, and
//          overrideFailedChallenge does NOT get past it (the unbound rule is checked first);
//        - a failed challenge is refused with challenge_not_passed unless the override is EXACTLY
//          the boolean true ("true" and 1 are both refused -- no truthy coercion);
//        - a decided admission is already_decided for grant, for refuse, and for a re-grant;
//        - a bogus decision word is 400; an unknown id is 409.
//
// Usage (phase 1, safe anywhere -- only 401 probes):
//   node tools/console-attack.mjs --url http://127.0.0.1:7806 --token <per-run token>
//
// Usage (phase 2, writes to a LAB store only -- requires both flags on purpose):
//   node tools/console-attack.mjs --url ... --token ... --lab-dir E:/ui-lab --confirm-write
//
// It seeds its OWN records, named attack-*, and never touches a record it did not create.
// Exit 0 = every property held. Exit 1 = a property broke (the interesting outcome). Exit 2 = could
// not run the attack at all (unreachable console, missing lab files).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAdmissionManager, bindBytes } from '../src/admission.mjs';
import { generateIdentity, sign } from '../src/identity.mjs';

const argv = process.argv.slice(2);
function flag(name) { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? true) : null; }
const url = flag('--url');
const token = flag('--token');
const labDir = flag('--lab-dir');
const confirmWrite = argv.includes('--confirm-write');

if (!url || !token) {
  console.error('usage: node tools/console-attack.mjs --url <console url> --token <per-run token> [--lab-dir <dir> --confirm-write]');
  process.exit(2);
}
if (labDir && !confirmWrite) {
  console.error('refusing to seed: --lab-dir writes admissions into that directory. Add --confirm-write if it is a LAB, not the stick.');
  process.exit(2);
}

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
  results.push({ name, ok, detail });
}

async function hit(label, method, path, body, headers = {}) {
  const target = `${url}${path}`;
  try {
    const res = await fetch(target, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON is fine, the status is what matters */ }
    return { status: res.status, json, text };
  } catch (err) {
    console.error(`  cannot reach ${target}: ${err.message}`);
    process.exit(2);
  }
}

console.log(`attacking ${url}\n`);

// --- 1. the token authorises transport, nothing more ---------------------------------------------
console.log('token gate:');
{
  const noToken = await hit('decide', 'POST', '/api/admissions/decide', { id: 'x', decision: 'grant' });
  check('decide without a token is 401', noToken.status === 401, `got ${noToken.status}`);

  const wrong = await hit('decide', 'POST', '/api/admissions/decide?t=not-the-token', { id: 'x', decision: 'grant' });
  check('decide with a wrong token is 401', wrong.status === 401, `got ${wrong.status}`);

  const readNoToken = await hit('read', 'GET', '/api/admissions');
  check('reading the queue without a token is 401', readNoToken.status === 401, `got ${readNoToken.status}`);
}

// --- 2. authority is a SEPARATE check (only meaningful against an observer lab) -------------------
if (argv.includes('--nonadmin')) {
  console.log('\nauthority (console key resolves to a non-admin):');
  const holder = generateIdentity().agentId;
  const g = await hit('grant', 'POST', `/api/grant?t=${token}`, { agent: holder, level: 'admin' });
  check('cannot mint a permit', g.status === 403, `got ${g.status}`);
  const r = await hit('revoke', 'POST', `/api/revoke?t=${token}`, { agent: holder });
  check('cannot revoke a key', r.status === 403, `got ${r.status}`);
  const d = await hit('decide', 'POST', `/api/admissions/decide?t=${token}`, { id: 'x', decision: 'refuse' });
  check('cannot decide an admission', d.status === 403, `got ${d.status}`);
  const st = await hit('state', 'GET', `/api/state?t=${token}`);
  check('but reading state still works', st.status === 200, `got ${st.status}`);
}

// --- 3. the decide() seam, with a valid token ----------------------------------------------------
if (labDir) {
  console.log(`\nseam (lab store at ${labDir}):`);
  const v = JSON.parse(readFileSync(join(labDir, 'verifier.json'), 'utf8'));
  const m = createAdmissionManager({
    dir: join(labDir, 'data', 'admissions'),
    salt: v.salt, kb: v.kb, items: v.items, windowMs: v.windowMs,
  });

  const mk = (joinKey, bind) => {
    const started = m.start(joinKey);
    const id = started.id ?? started.admission?.id ?? started.record?.id;
    m.answer(id, []);
    if (bind) {
      const who = generateIdentity();
      m.bind(id, { agentId: who.agentId, sig: sign(who, bindBytes({ id, agentId: who.agentId })) });
    }
    return id;
  };

  const unbound = mk('attack-unbound', false);
  const bound = mk('attack-bound', true);
  const decidedId = mk('attack-decided', true);
  m.decide(decidedId, 'refuse', generateIdentity().agentId);

  const T = `?t=${token}`;
  const j = (r) => (r.json && (r.json.code || r.json.error)) || r.status;

  const a1 = await hit('unbound', 'POST', `/api/admissions/decide${T}`, { id: unbound, decision: 'grant' });
  check('granting an UNBOUND admission is refused', a1.status === 409 && /cannot_grant_unbound/.test(String(j(a1))), `${a1.status} ${j(a1)}`);

  const a2 = await hit('unbound+override', 'POST', `/api/admissions/decide${T}`, { id: unbound, decision: 'grant', overrideFailedChallenge: true });
  check('...and the override does NOT get past the unbound rule', a2.status === 409 && /cannot_grant_unbound/.test(String(j(a2))), `${a2.status} ${j(a2)}`);

  const a3 = await hit('failed', 'POST', `/api/admissions/decide${T}`, { id: bound, decision: 'grant' });
  check('granting a FAILED challenge is refused', a3.status === 409 && /challenge_not_passed/.test(String(j(a3))), `${a3.status} ${j(a3)}`);

  const a4 = await hit('override string', 'POST', `/api/admissions/decide${T}`, { id: bound, decision: 'grant', overrideFailedChallenge: 'true' });
  check('the override as a STRING is refused (no truthy coercion)', a4.status === 409 && /challenge_not_passed/.test(String(j(a4))), `${a4.status} ${j(a4)}`);

  const a5 = await hit('override number', 'POST', `/api/admissions/decide${T}`, { id: bound, decision: 'grant', overrideFailedChallenge: 1 });
  check('the override as a NUMBER is refused', a5.status === 409 && /challenge_not_passed/.test(String(j(a5))), `${a5.status} ${j(a5)}`);

  const a6 = await hit('override boolean', 'POST', `/api/admissions/decide${T}`, { id: bound, decision: 'grant', overrideFailedChallenge: true });
  check('the override as the boolean true IS accepted', a6.status === 200 && a6.json?.decided === 'grant', `${a6.status} ${j(a6)}`);

  const a7 = await hit('re-grant', 'POST', `/api/admissions/decide${T}`, { id: bound, decision: 'grant', overrideFailedChallenge: true });
  check('re-granting a decided admission is already_decided', a7.status === 409 && /already_decided/.test(String(j(a7))), `${a7.status} ${j(a7)}`);

  const a8 = await hit('refuse decided', 'POST', `/api/admissions/decide${T}`, { id: decidedId, decision: 'refuse' });
  check('re-refusing a decided admission is already_decided', a8.status === 409 && /already_decided/.test(String(j(a8))), `${a8.status} ${j(a8)}`);

  const a9 = await hit('bogus word', 'POST', `/api/admissions/decide${T}`, { id: unbound, decision: 'admin' });
  check('a bogus decision word is 400', a9.status === 400, `got ${a9.status}`);

  const a10 = await hit('unknown id', 'POST', `/api/admissions/decide${T}`, { id: 'no-such-record', decision: 'grant' });
  check('an unknown admission id is 409', a10.status === 409, `got ${a10.status}`);

  console.log(`\n  (lab records attack-unbound / attack-bound / attack-decided were created and left in place)`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail > 0) console.log('  A PROPERTY BROKE. That is the interesting outcome -- read the FAIL lines above.');
process.exit(fail === 0 ? 0 : 1);
