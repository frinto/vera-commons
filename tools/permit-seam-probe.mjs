// Live probe: can the console turn an ADMISSION into a PERMIT?
//
// The console could always issue a permit, but only to a key typed in by hand; the CLI could issue
// one only from a decided admission. Two implementations of "who is being granted" is how a system
// hands posting rights to a key nobody examined — and the console would look healthy afterwards.
// This probe exercises the seam ON A RUNNING SERVER, not on the module.
//
// ISOLATION, deliberately: the whole console (plus src/, trust.json and the admin key) is copied
// into a temp directory and run from there. `USB_ROOT` is derived from the console's own location,
// so every write lands in the temp copy. The real stick is read once and never modified, and
// nothing is published to the relay. A probe that granted real permits to throwaway keys would
// pollute the only record of who is allowed to speak.
//
//   node tools/permit-seam-probe.mjs
import { mkdtempSync, rmSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STICK = process.env.AC_STICK || 'E:\\';
const PORT = Number(process.env.AC_PORT || 8801);
const LEVELS = ['observer', 'poster', 'moderator', 'admin'];

const { generateIdentity, sign } = await import(new URL('../src/identity.mjs', import.meta.url).href);
const { bindBytes, interviewBytes } = await import(new URL('../src/admission.mjs', import.meta.url).href);
const { permitBytes, levelOf } = await import(new URL('../src/permit.mjs', import.meta.url).href);

let failures = 0;
function check(ok, label, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' :: ' + detail : ''}`);
}

for (const f of ['console/app.mjs', 'trust.json', 'user-admin.json', 'verifier.json']) {
  if (!existsSync(join(STICK, f.replace('/', '\\')))) { console.error(`missing on stick: ${f}`); process.exit(2); }
}

const WORK = mkdtempSync(join(tmpdir(), 'ac-permit-'));
const TRUST = join(WORK, 'trust.json');
const ADMIN = JSON.parse(readFileSync(join(STICK, 'user-admin.json'), 'utf8'));

// The copy is what makes this safe to run: the console resolves its own USB root from its own path.
// `src/` sits INSIDE console/ because the console imports it as './src/...' — mirroring the stick.
//
// AC_FROM_STICK=1 copies the DEPLOYED code instead of the source tree. A fix that passes against the
// working copy proves only that the working copy is right; the stick is the thing the admin actually
// runs, and it is the artifact that can silently be stale.
const FROM_STICK = process.env.AC_FROM_STICK === '1';
const SRC_CONSOLE = FROM_STICK ? join(STICK, 'console') : join(ROOT, 'console');
const SRC_SRC = FROM_STICK ? join(STICK, 'console', 'src') : join(ROOT, 'src');
cpSync(SRC_CONSOLE, join(WORK, 'console'), { recursive: true });
cpSync(SRC_SRC, join(WORK, 'console', 'src'), { recursive: true });
console.log(`  (console under test: ${FROM_STICK ? 'THE DEPLOYED STICK' : 'the source tree'})`);
cpSync(join(STICK, 'user-admin.json'), join(WORK, 'user-admin.json'));
cpSync(join(STICK, 'trust.json'), TRUST);
for (const extra of ['relay-operator-secret.txt']) {
  const src = join(STICK, extra);
  if (existsSync(src)) cpSync(src, join(WORK, extra));
}
const verifier = JSON.parse(readFileSync(join(STICK, 'verifier.json'), 'utf8'));
verifier.dir = 'data/admissions';            // relative to the TEMP root, not the stick
writeFileSync(join(WORK, 'verifier.json'), JSON.stringify(verifier, null, 2));

const child = spawn(process.execPath, [join(WORK, 'console', 'app.mjs'), '--port', String(PORT), '--no-browser'], {
  cwd: join(WORK, 'console'), stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
const tokenReady = new Promise((res) => {
  const onData = (c) => { out += String(c); const m = /\?t=([A-Za-z0-9_-]{10,})/.exec(out); if (m) res(m[1]); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  setTimeout(() => res(null), 20000);
});

let exitCode = 0;
try {
  const TOKEN = await tokenReady;
  if (!TOKEN) throw new Error('the console never printed a token: ' + out.slice(-400));
  const BASE = `http://127.0.0.1:${PORT}`;
  const call = async (path, init) => {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${BASE}${path}${sep}t=${TOKEN}`, {
      ...init, headers: { 'content-type': 'application/json' },
    });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 200); }
    return { status: res.status, body: parsed };
  };

  check((await call('/')).status === 200, 'the console is serving');

  // --- an agent that will be admitted, one that will be refused, one left undecided ----------
  const agent = generateIdentity();
  const refusedAgent = generateIdentity();
  const pendingAgent = generateIdentity();

  async function enrol(joinKey, who, { bind = true, interview = true, decide = null } = {}) {
    const s = await call('/api/admissions/start', {
      method: 'POST', body: JSON.stringify({ joinKey, agentId: who.agentId }),
    });
    if (!s.body.id) throw new Error(`start failed for ${joinKey}: ${JSON.stringify(s.body)}`);
    const id = s.body.id;
    // The challenge is answered with a deliberately blank stub. This probe is about the
    // admission -> permit seam, NOT about the test, and `decide` requires only that the challenge
    // was answered at all — so the record honestly carries a FAILED verdict and still exercises
    // every refusal arm below. Scoring is never faked to make a probe look better.
    const count = Number(s.body.challenge?.count) || 0;
    await call('/api/admissions/answer', {
      method: 'POST', body: JSON.stringify({ id, answers: Array.from({ length: count }, () => '-') }),
    });
    if (bind) {
      await call('/api/admissions/bind', {
        method: 'POST',
        body: JSON.stringify({ id, agentId: who.agentId, sig: sign(who, bindBytes({ id, agentId: who.agentId })) }),
      });
    }
    if (interview) {
      const statement = `probe statement for ${joinKey}`;
      await call('/api/admissions/interview', {
        method: 'POST',
        body: JSON.stringify({
          id, statement, answers: { probe: 'yes' }, agentId: who.agentId,
          sig: sign(who, interviewBytes({ id, agentId: who.agentId, statement })),
        }),
      });
    }
    if (decide) await call('/api/admissions/decide', { method: 'POST', body: JSON.stringify({ id, decision: decide }) });
    return id;
  }

  const stamp = Date.now();
  const grantedId = await enrol(`permit-probe-grant-${stamp}`, agent, { decide: 'grant' });
  const refusedId = await enrol(`permit-probe-refuse-${stamp}`, refusedAgent, { decide: 'refuse' });
  const pendingId = await enrol(`permit-probe-pending-${stamp}`, pendingAgent, { decide: null });
  const unboundId = await enrol(`permit-probe-unbound-${stamp}`, generateIdentity(), { bind: false, interview: false });

  // --- the seam: a grant that names an ADMISSION instead of a typed key ----------------------
  const before = JSON.parse(readFileSync(TRUST, 'utf8'));
  const strangers = ['A'.repeat(43), 'B'.repeat(43), ADMIN.agentId];
  const levelBefore = Object.fromEntries(strangers.map((k) => [k, levelOf(before.permits ?? [], before.roots ?? [], k)]));

  const admRows = await call('/api/admissions');
  const grantedRow = (admRows.body.admissions ?? []).find((r) => r.id === grantedId);
  check(grantedRow?.permitLevel === null, 'before permitting, the UI is told there is no permit', `permitLevel=${JSON.stringify(grantedRow?.permitLevel)}`);

  const granted = await call('/api/grant', {
    method: 'POST', body: JSON.stringify({ admissionId: grantedId, level: 'poster' }),
  });
  check(granted.status === 200, 'a permit can be issued FROM an admission', `HTTP ${granted.status} ${JSON.stringify(granted.body?.code ?? granted.body?.error ?? '')}`);

  // The artifact, not the response: read the file the console actually wrote and verify it.
  const after = JSON.parse(readFileSync(TRUST, 'utf8'));
  const permit = (after.permits ?? []).find((p) => p.type === 'grant' && p.grantee === agent.agentId);
  check(!!permit, 'the permit is on disk, granted to the key the admission was bound to');
  if (permit) {
    check(permit.level === 'poster', 'the requested level was recorded', `level=${permit.level}`);
    check(permit.issuer === ADMIN.agentId, 'it is signed by the admin key, not by the probe', `issuer=${permit.issuer}`);
    // Independent verification: re-derive the signed bytes and check the signature directly rather
    // than asking the library that produced it whether it is happy with itself.
    const { verify } = await import(new URL('../src/identity.mjs', import.meta.url).href);
    check(verify(ADMIN.publicKey, permitBytes(permit), permit.sig), 'the signature verifies against the admin public key');
    check(levelOf(after.permits, after.roots ?? [], agent.agentId) === 'poster',
      'the real resolver now reads that key as poster', `got ${levelOf(after.permits, after.roots ?? [], agent.agentId)}`);

    // The one key that must NOT have moved: a grant is an act about one agent, and if issuing it
    // changed anyone else's level then authority is leaking sideways.
    const moved = strangers.filter((k) => levelOf(after.permits, after.roots ?? [], k) !== levelBefore[k]);
    check(moved.length === 0, 'no other key changed level', moved.map((k) => `${k.slice(0, 6)}->${levelOf(after.permits, after.roots ?? [], k)}`).join(','));
  }

  const rowsAfter = await call('/api/admissions');
  const rowAfter = (rowsAfter.body.admissions ?? []).find((r) => r.id === grantedId);
  check(rowAfter?.permitLevel === 'poster', 'the UI now reports the permit, so it stops offering one', `permitLevel=${JSON.stringify(rowAfter?.permitLevel)}`);

  // --- negative arms: every way this could grant authority to the wrong key ------------------
  const dup = await call('/api/grant', { method: 'POST', body: JSON.stringify({ admissionId: grantedId, level: 'poster' }) });
  check(dup.status === 409 && dup.body.code === 'already_permitted', 'a second live grant for the same key is refused',
    `HTTP ${dup.status} ${dup.body.code}`);

  const badKey = await call('/api/grant', {
    method: 'POST', body: JSON.stringify({ admissionId: grantedId, agent: 'C'.repeat(43), level: 'admin' }),
  });
  check(badKey.status === 409 && badKey.body.code === 'grantee_key_mismatch',
    'a typed key that disagrees with the admission is refused, not silently preferred',
    `HTTP ${badKey.status} ${badKey.body.code}`);
  check(!(JSON.parse(readFileSync(TRUST, 'utf8')).permits ?? []).some((p) => p.grantee === 'C'.repeat(43)),
    'the mismatched key did NOT receive a permit');

  for (const [label, id, code] of [
    ['a refused admission', refusedId, 'not_granted'],
    ['an undecided admission', pendingId, 'not_decided'],
    ['an admission nobody answered', unboundId, 'not_decided'],
    ['an admission that does not exist', 'no-such-admission', 'unknown_admission'],
  ]) {
    const r = await call('/api/grant', { method: 'POST', body: JSON.stringify({ admissionId: id, level: 'poster' }) });
    check(r.status === 409 && r.body.code === code, `${label} cannot be turned into a permit`, `HTTP ${r.status} ${r.body.code}`);
  }

  const issued = (JSON.parse(readFileSync(TRUST, 'utf8')).permits ?? []).filter((p) => p.type === 'grant');
  check(issued.length === (before.permits ?? []).filter((p) => p.type === 'grant').length + 1,
    'exactly one permit was added by the whole battery', `grants ${before.permits?.filter((p) => p.type === 'grant').length} -> ${issued.length}`);

  // --- revocation: the only irreversible act, and the one that had no pre-flight check ---------
  //
  // Asserted against the RUNNING console, because the guard lives in the route. A unit test of
  // revocationRisk() would stay green forever while the console stayed dangerous — the function
  // being correct and the function being USED are different claims.
  const trustBeforeRevoke = readFileSync(TRUST, 'utf8');

  // A root reaches `admin` through the trust file rather than through any permit, so revoking one
  // deletes the last authority and drags every key it granted down with it, permanently.
  const rootId = (JSON.parse(trustBeforeRevoke).roots ?? [])[0];
  const killRoot = await call('/api/revoke', { method: 'POST', body: JSON.stringify({ agent: rootId }) });
  check(killRoot.status === 409 && killRoot.body.code === 'target_is_root',
    '★ revoking a ROOT is refused, so the console cannot brick the commons',
    `HTTP ${killRoot.status} ${killRoot.body.code}`);
  check(readFileSync(TRUST, 'utf8') === trustBeforeRevoke,
    '★ and the refusal wrote NOTHING — trust.json is byte-identical');

  // A slip of the finger is not a revocation. Without an explicit acknowledgement the console
  // refuses, because a typo and a deliberate pre-emptive bar are the same request on the wire.
  const typo = await call('/api/revoke', { method: 'POST', body: JSON.stringify({ agent: 'D'.repeat(43) }) });
  check(typo.status === 409 && typo.body.code === 'target_holds_no_permit',
    '★ revoking a key that holds no permit is refused unless it is acknowledged',
    `HTTP ${typo.status} ${typo.body.code}`);
  check(readFileSync(TRUST, 'utf8') === trustBeforeRevoke, 'and that refusal wrote nothing either');

  // ...but barring someone in advance is a real thing an admin may mean, so it stays possible — it
  // just has to be said out loud.
  const barring = await call('/api/revoke', {
    method: 'POST', body: JSON.stringify({ agent: 'D'.repeat(43), acknowledgeUnknown: true }),
  });
  check(barring.status === 200, 'an ACKNOWLEDGED pre-emptive bar still succeeds', `HTTP ${barring.status} ${barring.body.code ?? ''}`);

  const shape = await call('/api/revoke', { method: 'POST', body: JSON.stringify({ agent: 'not-a-key' }) });
  check(shape.status === 400 && shape.body.code === 'bad_agent_id',
    'a malformed id is refused before it can be written as a revocation', `HTTP ${shape.status} ${shape.body.code}`);

  // The ordinary case must still WORK. A guard that refuses everything is not a guard, it is an
  // outage — this arm is what stops the three above from being satisfiable by returning 409 always.
  const real = await call('/api/revoke', { method: 'POST', body: JSON.stringify({ agent: agent.agentId }) });
  check(real.status === 200, '★ an ordinary revocation of a real holder still succeeds', `HTTP ${real.status} ${real.body.code ?? ''}`);
  const trustAfterRevoke = JSON.parse(readFileSync(TRUST, 'utf8'));
  const levelNow = levelOf(trustAfterRevoke.permits ?? [], trustAfterRevoke.roots ?? [], agent.agentId);
  check(levelNow === 'observer', '★ and the real resolver now reads that key as observer', `got ${levelNow}`);

  const twice = await call('/api/revoke', { method: 'POST', body: JSON.stringify({ agent: agent.agentId }) });
  check(twice.status === 409 && twice.body.code === 'already_revoked',
    'revoking the same key twice is reported rather than written again', `HTTP ${twice.status} ${twice.body.code}`);
} catch (err) {
  failures++;
  console.error('  FAIL probe aborted:', err.message);
  exitCode = 1;
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 250));
  try { rmSync(WORK, { recursive: true, force: true }); } catch { /* temp dir; leftovers are harmless */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : exitCode);
