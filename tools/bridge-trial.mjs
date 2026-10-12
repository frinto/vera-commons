// End-to-end proof of the relay -> permit bridge, against a console the trial starts itself.
//
// Round 12 ended with a claim that was true but narrower than it sounded: vendor #2 walked the whole
// gate over the relay and scored 150/150, and the LOCAL admission store still had no row for it — so
// it could never be given a permit. The gate worked and nobody could get through it. This trial proves
// the bridge that closes that seam actually closes it, through the real HTTP route on the real
// console code.
//
// WHY A STAND-IN RELAY INSTEAD OF THE LIVE ONE:
// the thing that must hold is that the relay is untrusted infrastructure. Testing against the live
// relay can only show that an honest relay works. A local stand-in can LIE — substitute the grantee,
// present an untrusted operator, invent a decision — and those are the arms that matter. It also keeps
// the live commons and the live relay free of test traffic.
//
// Every arm uses its OWN requestId. Reusing one would make the second arm collide with the record the
// first arm created (`already_decided`), and the arms would stop being independent observations.
//
// AC_FROM_STICK=1 runs this against the DEPLOYED code on the stick. A fix that passes against the
// working tree proves only that the working tree is right; the stick is what the admin actually runs.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startConsole, stopAndVerify } from './console-runner.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STICK = process.env.AC_STICK || 'E:\\';
const PORT = Number(process.env.AC_PORT || 8811);
const FAKE_PORT = PORT + 1;

const { generateIdentity, sign } = await import(new URL('../src/identity.mjs', import.meta.url).href);
const { canonicalize } = await import(new URL('../src/message.mjs', import.meta.url).href);
const { relayBindBytes } = await import(new URL('../src/admission.mjs', import.meta.url).href);

let failures = 0;
function check(ok, label, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' :: ' + detail : ''}`);
}

for (const f of ['console/app.mjs', 'trust.json', 'user-admin.json', 'verifier.json']) {
  if (!existsSync(join(STICK, f.replace('/', '\\')))) { console.error(`missing on stick: ${f}`); process.exit(2); }
}

// --- the cast -----------------------------------------------------------------------------------
const joiner = generateIdentity();
const operator = generateIdentity();
const stranger = generateIdentity();
const victim = generateIdentity();
// A second honest joiner, so the closing success arm is about THIS route and not about the
// one-live-permit-per-key rule that reusing the first joiner would have tripped instead.
const latecomer = generateIdentity();

// --- the stand-in relay -------------------------------------------------------------------------
// Keyed by requestId so each arm is an independent request, and so the relay can be made to LIE about
// any one of them without disturbing the others.
const served = new Map();

const fakeRelay = createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${FAKE_PORT}`);
  const entry = served.get(u.searchParams.get('requestId')) || {};
  const body = u.pathname === '/admission/verdict' ? entry.verdict : (u.pathname === '/admission/bind' ? entry.bind : null);
  if (!body) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"ok":false,"reason":"not_found"}'); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
});
await new Promise((r) => fakeRelay.listen(FAKE_PORT, '127.0.0.1', r));

const bindFor = (id, who = joiner) => ({
  requestId: id, agentId: who.agentId,
  sig: sign(who, relayBindBytes({ requestId: id, agentId: who.agentId })),
});
const signVerdict = (id, decision, by) => {
  const claim = { requestId: id, decision, by: by.agentId };
  return { ...claim, sig: sign(by, Buffer.from(canonicalize(claim), 'utf8')) };
};
const serve = (id, { verdict = null, bind = null } = {}) => served.set(id, { verdict, bind });
// An honest request: a genuine bind from the joiner and a genuine verdict from a trusted operator.
const honest = (id, decision = 'granted', who = joiner) =>
  serve(id, { bind: bindFor(id, who), verdict: signVerdict(id, decision, operator) });

// --- an isolated console ------------------------------------------------------------------------
const WORK = mkdtempSync(join(tmpdir(), 'ac-bridge-'));
const FROM_STICK = process.env.AC_FROM_STICK === '1';
const SRC_CONSOLE = FROM_STICK ? join(STICK, 'console') : join(ROOT, 'console');
const SRC_SRC = FROM_STICK ? join(STICK, 'console', 'src') : join(ROOT, 'src');
cpSync(SRC_CONSOLE, join(WORK, 'console'), { recursive: true });
cpSync(SRC_SRC, join(WORK, 'console', 'src'), { recursive: true });
cpSync(join(STICK, 'user-admin.json'), join(WORK, 'user-admin.json'));
for (const extra of ['relay-operator-secret.txt']) {
  const src = join(STICK, extra);
  if (existsSync(src)) cpSync(src, join(WORK, extra));
}

// The temp trust file is the STICK's, plus the one thing this trial is entitled to decide: which
// operator keys this node trusts. Trust is a local judgement, so a test may make it; the code under
// test may not read it off the wire.
const trust = JSON.parse(readFileSync(join(STICK, 'trust.json'), 'utf8'));
trust.operators = [operator.agentId];
writeFileSync(join(WORK, 'trust.json'), JSON.stringify(trust, null, 2));

const verifier = JSON.parse(readFileSync(join(STICK, 'verifier.json'), 'utf8'));
verifier.dir = 'data/admissions';
writeFileSync(join(WORK, 'verifier.json'), JSON.stringify(verifier, null, 2));

// THE COPY MUST BE FAITHFUL, and the run must SAY which tree it is a copy OF -- otherwise every arm
// below is a statement about an artifact nobody named. The seam files are also compared between the
// working tree and the deployment, so a green run against the source tree can never quietly stand in
// for a deployment that is behind (AC_FROM_STICK=1 tests the deployed bytes directly).
const hashOf = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12) : '(missing)');
check(hashOf(join(WORK, 'console', 'app.mjs')) === hashOf(join(SRC_CONSOLE, 'app.mjs')),
  'the console under test is byte-identical to its named source', hashOf(join(WORK, 'console', 'app.mjs')));
check(hashOf(join(WORK, 'console', 'src', 'admission.mjs')) === hashOf(join(SRC_SRC, 'admission.mjs')),
  'and so is the admission library it imports', hashOf(join(WORK, 'console', 'src', 'admission.mjs')));
const drift = ['console/app.mjs', 'src/admission.mjs', 'src/message.mjs']
  .map((rel) => ({ rel, repo: hashOf(join(ROOT, rel)), stick: hashOf(join(STICK, rel)) }))
  .filter((d) => d.repo !== d.stick);
console.log(drift.length
  ? `  (DRIFT: the deployment differs from the source tree -- ${drift.map((d) => `${d.rel} repo=${d.repo} stick=${d.stick}`).join('; ')}. This run tests the ${FROM_STICK ? 'DEPLOYED' : 'SOURCE'} tree.)`
  : '  (drift check: console/app.mjs, src/admission.mjs and src/message.mjs match between the source tree and the deployment)');

console.log(`  (console under test: ${FROM_STICK ? 'THE DEPLOYED STICK' : 'the source tree'})`);
// The console is started THROUGH THE RUNNER: it refuses a port that is already served (naming the
// holder out of .tmp/console-locks/<port>.json) instead of racing it, and it can prove the release.
// A bare spawn could report arms as passing while the HTTP answers came from someone else's build.
const startCopy = (args, readyTimeoutMs) => startConsole({
  app: join(WORK, 'console', 'app.mjs'), port: PORT, args, cwd: join(WORK, 'console'),
  tool: 'bridge-trial.mjs', readyTimeoutMs,
});

// THE OVERRIDE IS PROVEN TO BE AN OVERRIDE OF A WORKING GATE. Without this arm, --allow-fixed-disk
// would be a flag that might be hiding a media gate which quietly stopped working. Measured
// 2026-10-12, and this is why the arm exists: this trial had NEVER started its console -- it passed no
// flag, the console refused, and the harness reported "the console never printed a token" only after
// its full 20s timeout. The census entry blamed a kill with no proof of release; the real defect was
// that the trial could not run at all, and a debt reason written from the code's SHAPE had hidden it.
let gateRefusal = '';
try {
  const leaked = await startCopy([], 8000);
  gateRefusal = '(the console STARTED without --allow-fixed-disk: the media gate is OPEN)';
  try { await stopAndVerify(leaked); } catch { /* reported below regardless */ }
} catch (e) {
  gateRefusal = e && e.message ? e.message : String(e);
}
check(/never printed a token/.test(gateRefusal) && !/Refusing to start/.test(gateRefusal),
  'the console REFUSES to run from a copy when it is not told otherwise',
  gateRefusal.split('\n')[0].slice(0, 120));
check(/allow-fixed-disk/.test(gateRefusal),
  'the refusal names the override, so an operator can act on it',
  gateRefusal.split('\n').filter((l) => l.includes('allow-fixed-disk')).join(' ').trim().slice(0, 110));

let out = '';
const readTrustNow = () => JSON.parse(readFileSync(join(WORK, 'trust.json'), 'utf8'));

let live = null;
let exitCode = 0;
try {
  live = await startCopy(['--no-browser', '--relay', `http://127.0.0.1:${FAKE_PORT}`, '--allow-fixed-disk'], 20000);
  out = live.out;   // the console's own output, kept so a failed arm can say why
  const more = (c) => { out += String(c); };
  live.child.stdout?.on('data', more);
  live.child.stderr?.on('data', more);
  const TOKEN = live.token;
  const BASE = `http://127.0.0.1:${PORT}`;
  const call = async (path, init = {}) => {
    const res = await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}t=${TOKEN}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers || {}) },
      signal: AbortSignal.timeout(25000),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const adopt = (id) => call('/api/relay/verdict', { method: 'POST', body: JSON.stringify({ requestId: id }) });
  const grant = (admissionId) => call('/api/grant', { method: 'POST', body: JSON.stringify({ admissionId, level: 'poster' }) });
  const permitsNow = () => (readTrustNow().permits || []);

  // --- 1. THE HAPPY PATH ----------------------------------------------------------------------
  console.log('');
  console.log('--- the bridge: a verdict reached over the relay becomes a grantable record ---');
  const ID1 = 'bridge-ok';
  honest(ID1);
  let r = await adopt(ID1);
  check(r.status === 200, 'a trusted operator + a signed bind is adopted', `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  check(r.body.id === `relay:${ID1}`, 'the local record is keyed by the request', `id=${r.body.id}`);
  check(r.body.grantee === joiner.agentId, 'and names the key that signed the bind', `grantee=${String(r.body.grantee).slice(0, 12)}`);
  check(r.body.decision === 'grant', 'the relay word "granted" bridged to "grant"', `decision=${r.body.decision}`);

  // --- 2. the record is visible to the admin's own review list ---------------------------------
  r = await call('/api/admissions');
  const row = (r.body.admissions || []).find((x) => x.id === `relay:${ID1}`);
  check(!!row, 'the adopted record appears in the console admission list', r.body.error ? JSON.stringify(r.body).slice(0, 120) : '');
  check(row?.via === 'relay', 'and says the decision came from the relay', `via=${row?.via}`);
  check(row?.bound === true, 'and reports itself bound, which is the fact the permit seam needs');
  check(row?.short === null && row?.joinKey === null,
    '★ and admits it has no local join key rather than inventing one', `short=${JSON.stringify(row?.short)}`);

  // --- 3. THE POINT: it can now actually hold a permit -----------------------------------------
  r = await grant(`relay:${ID1}`);
  check(r.status === 200, '★ the adopted admission can be GRANTED a permit', `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  const held = permitsNow().find((p) => p.type === 'grant' && p.grantee === joiner.agentId);
  check(!!held && held.level === 'poster', '★ and the key now holds a live poster permit', held ? `level=${held.level}` : 'no permit found');

  // --- 4. THE RELAY LIES: it substitutes who receives authority --------------------------------
  console.log('');
  console.log('--- the relay is not trusted: it may not choose the grantee ---');
  const ID2 = 'bridge-swap';
  serve(ID2, { bind: { ...bindFor(ID2), agentId: victim.agentId }, verdict: signVerdict(ID2, 'granted', operator) });
  r = await adopt(ID2);
  check(r.status === 409 && r.body.code === 'bind_bad_signature',
    '★ a relay that swaps the grantee is refused', `HTTP ${r.status} ${r.body.code}`);
  check(!permitsNow().some((p) => p.grantee === victim.agentId), '★ and the substituted key gained nothing');

  const ID3 = 'bridge-thirdparty';
  serve(ID3, {
    bind: { requestId: ID3, agentId: victim.agentId, sig: sign(stranger, relayBindBytes({ requestId: ID3, agentId: victim.agentId })) },
    verdict: signVerdict(ID3, 'granted', operator),
  });
  r = await adopt(ID3);
  check(r.status === 409 && r.body.code === 'bind_bad_signature',
    '★ a third party cannot bind a key that is not theirs', `HTTP ${r.status} ${r.body.code}`);

  // --- 5. THE RELAY LIES: it presents an untrusted operator ------------------------------------
  console.log('');
  console.log('--- the relay is not trusted: it may not name its own authority ---');
  const ID4 = 'bridge-untrusted-op';
  serve(ID4, { bind: bindFor(ID4), verdict: signVerdict(ID4, 'granted', stranger) });
  r = await adopt(ID4);
  check(r.status === 409 && r.body.code === 'operator_not_trusted',
    '★ a verdict from a key this node does not trust is refused', `HTTP ${r.status} ${r.body.code}`);

  const ID5 = 'bridge-forged-op';
  const forgedClaim = { requestId: ID5, decision: 'granted', by: operator.agentId };
  serve(ID5, {
    bind: bindFor(ID5),
    verdict: { ...forgedClaim, sig: sign(stranger, Buffer.from(canonicalize(forgedClaim), 'utf8')) },
  });
  r = await adopt(ID5);
  check(r.status === 409 && r.body.code === 'verdict_bad_signature',
    '★ naming a trusted operator is not the same as being one', `HTTP ${r.status} ${r.body.code}`);

  // --- 6. THE RELAY LIES: it invents a decision -------------------------------------------------
  console.log('');
  console.log('--- the relay is not trusted: the decision vocabulary is closed ---');
  for (const [i, d] of ['maybe', 'GRANTED', 'grant', ''].entries()) {
    const id = `bridge-decision-${i}`;
    serve(id, { bind: bindFor(id), verdict: signVerdict(id, d, operator) });
    const rr = await adopt(id);
    check(rr.status === 409 && rr.body.code === 'unknown_decision',
      `★ decision ${JSON.stringify(d)} refuses rather than guessing`, `HTTP ${rr.status} ${rr.body.code}`);
  }

  // --- 7. a REFUSAL bridges too, and still cannot become a permit -------------------------------
  console.log('');
  console.log('--- a refusal is decided, and must stay a refusal ---');
  const ID6 = 'bridge-refused';
  honest(ID6, 'refused');
  r = await adopt(ID6);
  check(r.status === 200, 'a refusal is adopted as a decided record', `HTTP ${r.status} ${r.body.code || ''}`);
  check(r.body.decision === 'refuse', 'bridged to the local word "refuse"', `decision=${r.body.decision}`);
  r = await grant(`relay:${ID6}`);
  check(r.status !== 200, '★ and granting from it is refused', `HTTP ${r.status} ${r.body.code}`);

  // --- 8. the relay has no verdict, or no bind --------------------------------------------------
  console.log('');
  console.log('--- absent halves are refused, not defaulted ---');
  const ID7 = 'bridge-noverdict';
  serve(ID7, { bind: bindFor(ID7) });
  r = await adopt(ID7);
  check(r.status === 409 && r.body.code === 'NO_VERDICT_YET', 'no verdict is reported as such', `HTTP ${r.status} ${r.body.code}`);
  const ID8 = 'bridge-nobind';
  serve(ID8, { verdict: signVerdict(ID8, 'granted', operator) });
  r = await adopt(ID8);
  check(r.status === 409 && r.body.code === 'NO_BINDING_YET',
    '★ a verdict with no bind names no key, so it is refused', `HTTP ${r.status} ${r.body.code}`);

  // --- 9. SUCCESS ARM, LAST ---------------------------------------------------------------------
  // Every refusal above would also be satisfied by a route that refuses everything, so the battery
  // ends by proving the route still works. A DIFFERENT key from arm 1 on purpose: a key may hold at
  // most one live permit, so reusing the first joiner would fail on `already_permitted` — correctly —
  // and that refusal would be about the one-grant rule rather than about this route.
  console.log('');
  console.log('--- the battery discriminates ---');
  const ID9 = 'bridge-final';
  honest(ID9, 'granted', latecomer);
  r = await adopt(ID9);
  check(r.status === 200, '★ an honest request still adopts after all the refusals', `HTTP ${r.status}`);
  r = await grant(`relay:${ID9}`);
  check(r.status === 200, '★ and still grants a permit', `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  check(permitsNow().some((p) => p.type === 'grant' && p.grantee === latecomer.agentId),
    '★ to the key that signed its bind, and not to the earlier joiner');
} catch (err) {
  failures++;
  console.error('  FAIL threw: ' + (err?.message || err));
} finally {
  // The release proof is a CHECK and it lands BEFORE the verdict line below: a run whose stop check
  // failed must not be able to print PASSED.
  if (live) {
    try {
      await stopAndVerify(live);
      check(true, `the console was stopped and port ${PORT} is free again`);
    } catch (e) {
      check(false, `the console was stopped and port ${PORT} is free again`, e && e.message ? e.message : String(e));
    }
  }
  try { fakeRelay.close(); } catch { /* already closed */ }
  try { rmSync(WORK, { recursive: true, force: true }); } catch { /* temp */ }
}

console.log('');
console.log(failures === 0 ? 'BRIDGE TRIAL PASSED' : `BRIDGE TRIAL FAILED: ${failures} arm(s)`);
process.exit(failures === 0 ? 0 : 1);
