// JOINER PATH TRIAL — proves the path an OUTSIDE agent actually walks, end to end, on the live relay.
//
// WHAT WAS WRONG. The gate's operator half existed and was tested. The JOINER's half existed only as
// inline code inside a test (`vendor-gate-trial.mjs`, `live-remote-trial.mjs`) and was reachable from
// no shipped command and no line of JOIN.md. An agent following the documentation ran
// `cli.mjs join` — which discovers and reads and never touches the gate — and was then granted
// posting rights by an admin typing its key in by hand. The gate was enforced and unwalked.
//
// WHAT THIS DOES DIFFERENTLY: it does not call functions. It SPAWNS `tools/join-apply.mjs` as a
// child process, with a fresh key file, for every joiner step. If the documented command does not
// work, this fails. A test that imports the same helper the tool imports proves the helper.
//
// THE ARMS:
//   1. grant  — a joiner derives answers from the published taxonomy → VERDICT granted
//   2. refuse — a joiner submits answers it did not derive → VERDICT refused
//   3. the tool REFUSES to invent answers (no --answers-file, wrong count, illegal labels)
//   4. the bind names the joiner's OWN key, verified by the operator from the relay
//   5. the live trust anchor accepts an operator's verdict — and, before registration, did not
//
// Run: node tools/joiner-path-trial.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeChallenge, scoreChallenge } from '../src/agency.mjs';
import { canonicalize } from '../src/message.mjs';
import { admissionFromVerdict } from '../src/permit-admission.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RELAY = process.env.AC_RELAY || 'https://agent-commons.huyxkhoa.workers.dev';
const VERIFIER = process.env.AC_VERIFIER || 'E:\\verifier.json';
const TRUST = process.env.AC_TRUST || 'E:\\trust.json';
const SECRET_FILE = process.env.AC_OPERATOR_SECRET_FILE
  || 'C:\\Users\\frinto\\.dsh\\agent-commons\\relay-operator-secret.txt';
const OPERATOR_KEY = process.env.AC_OPERATOR_KEY
  || 'C:\\Users\\frinto\\.dsh\\agent-commons\\relay-operator-key.json';
const ITEMS = Number(process.env.AC_ITEMS || 20);

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const privKey = (seedB64u) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8, fromB64u(seedB64u)]), format: 'der', type: 'pkcs8' });
const enc = new TextEncoder();
const sha256 = (b) => new Uint8Array(crypto.createHash('sha256').update(b).digest());
function leadingZeroBits(bytes) {
  let bits = 0;
  for (const b of bytes) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; }
  return bits;
}
function stamp(obj, bits = 12) {
  const { sig, pow, id, ...rest } = obj;
  const canvas = enc.encode(canonicalize(rest));
  for (let n = 0; n < 8_000_000; n++) {
    const nonce = enc.encode(String(n));
    const buf = new Uint8Array(canvas.length + nonce.length);
    buf.set(canvas, 0); buf.set(nonce, canvas.length);
    if (leadingZeroBits(sha256(buf)) >= bits) return { ...obj, pow: String(n) };
  }
  throw new Error('could not stamp');
}
async function call(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers['authorization'] = 'Bearer ' + token;
  const res = await fetch(RELAY + path, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the solver. Mechanical, derived ONLY from the published taxonomy. -------------------------
// This is careful derivation, NOT intelligence, and this trial must never be read as evidence that
// the gate measures agency. It measures whether an agent can follow a published rule.
function makeSolver(kb) {
  const chains = kb.chains;
  const ART = /^An? /;
  const strip = (s) => String(s).trim().replace(/\.$/, '').replace(ART, '');
  const parseClaim = (text) => {
    const m = /^An? (.+?) is an? (.+?)\.?$/.exec(String(text).trim());
    if (!m) throw new Error('unparsed item: ' + text);
    return { subject: strip(m[1]), object: strip(m[2]) };
  };
  return (item) => {
    const entity = parseClaim(item.premise).subject;
    const category = parseClaim(item.hypothesis).object;
    const entailed = chains.some((c) => {
      const i = c.indexOf(entity);
      return i >= 0 && c.indexOf(category) > i;
    });
    return entailed ? 'ENTAILED' : 'CONTRADICTED';
  };
}

// --- spawn the REAL documented command, never a local re-implementation ------------------------
function joiner(args) {
  return spawnSync(process.execPath, [join(ROOT, 'tools', 'join-apply.mjs'), ...args],
    { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
}
function joinerAsync(args) {
  return spawn(process.execPath, [join(ROOT, 'tools', 'join-apply.mjs'), ...args],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
}

const WORK = join(tmpdir(), 'joiner-path-' + crypto.randomBytes(4).toString('hex'));
mkdirSync(WORK, { recursive: true });

const saltDoc = JSON.parse(readFileSync(VERIFIER, 'utf8'));
const { salt, kb, windowMs = 900000 } = saltDoc;
const token = readFileSync(SECRET_FILE, 'utf8').trim();
const operatorIdentity = JSON.parse(readFileSync(OPERATOR_KEY, 'utf8'));
const operatorPub = operatorIdentity.agentId;

console.log('JOINER PATH TRIAL — the path an outside agent actually walks');
console.log('  RELAY   ' + RELAY);
console.log('  OPERATOR ' + operatorPub.slice(0, 12) + '...  (holds the salt; scores LOCALLY)');
console.log('  WORK    ' + WORK + '  (each joiner gets its own key file here)');
console.log('');

// =============================================================================================
// ARM A — a joiner that follows the published rule: expect GRANTED
// =============================================================================================
async function runArm(label, { corrupt }) {
  console.log(`--- ${label} ---`);
  const keyFile = join(WORK, (corrupt ? 'b' : 'a') + '-identity.json');
  const answersFile = join(WORK, (corrupt ? 'b' : 'a') + '-answers.json');

  // 1. the joiner opens its own request and waits for a challenge. Started FIRST and
  //    asynchronously, because `apply` is designed to block until the operator publishes.
  const child = joinerAsync(['apply', '--url', RELAY, '--key', keyFile, '--note', '[trial] joiner-path-trial', '--wait', '180']);
  let childOut = '';
  child.stdout.on('data', (d) => { childOut += d; });
  child.stderr.on('data', (d) => { childOut += d; });

  // 2. the operator watches its OWN queue for the request to appear, then publishes a challenge.
  //
  // Match on the joiner's ACTUAL KEY, not on arrival order. The operator's queue holds every
  // historical request (the live relay currently carries a backlog), so "the oldest one I have not
  // seen" would happily pick up a stale handshake from an earlier run and test that instead —
  // passing while proving nothing about this run.
  let myKey = null;
  for (let i = 0; i < 30 && !myKey; i++) {
    if (existsSync(keyFile)) {
      try { myKey = JSON.parse(readFileSync(keyFile, 'utf8')).agentId; } catch { /* mid-write; retry */ }
    }
    if (!myKey) await sleep(500);
  }
  if (!myKey) { check(`${label}: the joiner generated its own identity`, false, 'no key file appeared'); return null; }

  let requestId = null;
  let joinKey = null;
  for (let i = 0; i < 40 && !requestId; i++) {
    const r = await call('/admission/requests', { token });
    const hit = (r.json?.requests || []).find((q) => q.joinKey === myKey);
    if (hit) { requestId = hit.requestId; joinKey = hit.joinKey; }
    else await sleep(1000);
  }
  if (!requestId) { check(`${label}: the joiner's request reached the operator queue`, false, 'never appeared'); return null; }
  seen.add(requestId);
  check(`${label}: ★ the joiner opened its OWN request (no operator issued it an id)`, /^[A-Za-z0-9_-]{16,64}$/.test(requestId), requestId);
  check(`${label}: the request carries the joiner's own key, not one we supplied`, /^[A-Za-z0-9_-]{43}$/.test(String(joinKey)), String(joinKey).slice(0, 12));

  // 3. publish the challenge (with the taxonomy, and provably without the salt)
  const seed = b64u(crypto.randomBytes(24));
  const challenge = makeChallenge({ seed, salt, kb, items: ITEMS, windowMs });
  const published = { ...challenge, kb };
  check(`${label}: the published challenge does NOT carry the salt`,
    !JSON.stringify(published).includes(salt) && !JSON.stringify(published).includes('"salt"'));
  const cr = await call('/admission/challenge', { method: 'POST', token, body: { requestId, challenge: published } });
  check(`${label}: the challenge is published to the relay`, cr.status === 201, `HTTP ${cr.status} ${JSON.stringify(cr.json)}`);

  // 4. the joiner should now bind BY ITSELF and exit.
  const exited = await new Promise((res) => { child.on('exit', (code) => res(code)); setTimeout(() => res(null), 200000); });
  check(`${label}: ★ the documented command \`join-apply.mjs apply\` exited 0`, exited === 0, `exit ${exited}\n${childOut.slice(-400)}`);

  // 5. the operator reads the BIND off the relay — this is the step that was missing for two vendors
  const br = await call(`/admission/bind?requestId=${encodeURIComponent(requestId)}`, { token });
  check(`${label}: ★ a BIND exists on the relay for this request`, br.status === 200, `HTTP ${br.status} ${JSON.stringify(br.json)}`);
  const bind = br.json;
  check(`${label}: ★ the bind names the key the REQUEST named (no substitution)`, bind?.agentId === joinKey,
    `bind=${String(bind?.agentId).slice(0, 12)} request=${String(joinKey).slice(0, 12)}`);

  // 6. the joiner's own challenge file is what it reasoned from
  const challengeFile = join(WORK, (corrupt ? 'b' : 'a') + '-identity.challenge.json');
  check(`${label}: the joiner wrote the challenge it received`, existsSync(challengeFile));
  const got = JSON.parse(readFileSync(challengeFile, 'utf8'));

  // 7. derive answers, then CORRUPT them for the refuse arm
  const solve = makeSolver(got.kb);
  let answers = got.items.map(solve);
  check(`${label}: the joiner derived one answer per item`, answers.length === got.items.length,
    `${answers.length} vs ${got.items.length}`);
  if (corrupt) {
    // Flip a decisive share — enough to fall under the 95% bar, deterministic rather than random.
    const flip = Math.ceil(answers.length * 0.3);
    for (let i = 0; i < flip; i++) answers[i] = answers[i] === 'ENTAILED' ? 'CONTRADICTED' : 'ENTAILED';
    console.log(`  (this arm deliberately corrupts ${flip} of ${answers.length} answers)`);
  }
  writeFileSync(answersFile, JSON.stringify({ answers }, null, 2), 'utf8');

  // 8. TOOL REFUSAL ARMS — the tool must not be able to invent answers.
  const noFile = joiner(['answer', '--url', RELAY, '--key', keyFile]);
  check(`${label}: ★ the tool REFUSES to answer without --answers-file (it will not invent them)`,
    noFile.status !== 0 && String(noFile.stderr).includes('does not invent answers'), `exit ${noFile.status}`);
  const shortFile = join(WORK, (corrupt ? 'b' : 'a') + '-short.json');
  writeFileSync(shortFile, JSON.stringify({ answers: answers.slice(0, 3) }), 'utf8');
  const short = joiner(['answer', '--url', RELAY, '--key', keyFile, '--answers-file', shortFile]);
  check(`${label}: the tool refuses a SHORT answer set`, short.status !== 0 && String(short.stderr).includes('refusing to submit'),
    `exit ${short.status}`);
  const badLabelFile = join(WORK, (corrupt ? 'b' : 'a') + '-badlabel.json');
  writeFileSync(badLabelFile, JSON.stringify({ answers: answers.map((a, i) => (i === 0 ? 'MAYBE' : a)) }), 'utf8');
  const badLabel = joiner(['answer', '--url', RELAY, '--key', keyFile, '--answers-file', badLabelFile]);
  check(`${label}: the tool refuses an ILLEGAL label`, badLabel.status !== 0 && String(badLabel.stderr).includes('not one of'),
    `exit ${badLabel.status}`);

  // 9. the real submission
  const ans = joiner(['answer', '--url', RELAY, '--key', keyFile, '--answers-file', answersFile]);
  check(`${label}: \`join-apply.mjs answer\` exited 0`, ans.status === 0, `exit ${ans.status}\n${String(ans.stderr).slice(-300)}`);

  // 10. the operator scores LOCALLY against the real salt
  const ar = await call(`/admission/answers?requestId=${encodeURIComponent(requestId)}`, { token });
  check(`${label}: the operator collected the answers`, ar.status === 200, `HTTP ${ar.status}`);
  const submitted = ar.json?.answers || [];
  const report = scoreChallenge({ seed, salt, kb, items: ITEMS, answers: submitted });
  console.log(`  OPERATOR scores locally: ${report.correct}/${report.total} = ${(report.ratio * 100).toFixed(1)}% (bar ${report.passRatio})`);
  check(`${label}: the operator scored the whole submission`, report.total === ITEMS);
  // Sensitivity: the same answers under a different salt must not reproduce the score.
  const alt = scoreChallenge({ seed, salt: b64u(crypto.randomBytes(32)), kb, items: ITEMS, answers: submitted });
  check(`${label}: the score is SALT-SENSITIVE`, alt.correct !== report.correct || alt.ok !== report.ok,
    `real ${report.correct}, wrong-salt ${alt.correct}`);

  const decision = report.ok ? 'granted' : 'refused';
  check(`${label}: decision is ${corrupt ? 'refused' : 'granted'}`, decision === (corrupt ? 'refused' : 'granted'), decision);

  // 11. the SIGNED verdict
  const claim = { requestId, decision, by: operatorPub };
  const sig = b64u(crypto.sign(null, Buffer.from(canonicalize(claim), 'utf8'), privKey(operatorIdentity.privateKey)));
  const vr = await call('/admission/verdict', { method: 'POST', token, body: { requestId, decision, by: operatorPub, sig } });
  check(`${label}: the signed verdict is published`, vr.status === 201, `HTTP ${vr.status} ${JSON.stringify(vr.json)}`);

  // 12. the joiner fetches and VERIFIES it with the documented command
  const vd = joiner(['verdict', '--url', RELAY, '--key', keyFile, '--wait', '120']);
  check(`${label}: \`join-apply.mjs verdict\` exited 0`, vd.status === 0, `exit ${vd.status}\n${String(vd.stderr).slice(-300)}`);
  check(`${label}: ★ the joiner's OWN tool verified the operator's signature`,
    String(vd.stdout).includes('VERIFIES against the operator key'), String(vd.stdout).slice(-300));
  check(`${label}: the joiner's tool reports the decision it received`,
    String(vd.stdout).includes(`decision : ${decision}`), String(vd.stdout).slice(-200));

  return { requestId, verdict: { requestId, decision, by: operatorPub, sig }, bind, joinKey };
}

const seen = new Set();
const grantArm = await runArm('ARM A — grant (answers derived from the published taxonomy)', { corrupt: false });
console.log('');
const refuseArm = await runArm('ARM B — refuse (same path, answers NOT derived)', { corrupt: true });

// =============================================================================================
// ARM C — does the LIVE trust anchor accept this operator's verdict?
// =============================================================================================
console.log('');
console.log('--- ARM C — the live trust anchor ---');
if (!grantArm) {
  check('ARM C: a granted arm existed to test with', false, 'ARM A produced nothing');
} else {
  const liveTrust = JSON.parse(readFileSync(TRUST, 'utf8'));
  const operators = Array.isArray(liveTrust.operators) ? liveTrust.operators : [];
  console.log(`  ${TRUST} lists ${operators.length} operator(s)`);

  // The console calls exactly this function with exactly this argument (app.mjs:1095).
  const adopted = admissionFromVerdict({
    verdict: grantArm.verdict,
    bind: grantArm.bind,
    operatorKeys: operators,
  });
  check('★ the LIVE trust anchor accepts the operator\'s verdict for adoption',
    adopted.ok === true,
    `reason=${adopted.reason} — with operators=[] the whole relay path is unreachable, because ` +
    `admissionFromVerdict requires the verdict signer to be listed in ${TRUST}`);
  if (adopted.ok) {
    check('★ and the grantee it proves is the JOINER\'s own key, taken from the bind',
      adopted.record.grantee === grantArm.joinKey,
      `grantee=${String(adopted.record.grantee).slice(0, 12)} joiner=${String(grantArm.joinKey).slice(0, 12)}`);
    check('the adopted record is marked as arriving via the relay', adopted.record.id === `relay:${grantArm.requestId}`);
  }

  // Discrimination: the SAME function, the same artifacts, an operator list that excludes the
  // signer. If this arm also passed, ARM C would be proving nothing at all.
  const excluded = admissionFromVerdict({ verdict: grantArm.verdict, bind: grantArm.bind, operatorKeys: [] });
  check('★ and REFUSES the same verdict when the signer is not listed (so ARM C can fail)',
    excluded.ok === false && excluded.reason === 'operator_not_trusted', `reason=${excluded.reason}`);
}

console.log('');
console.log(`${pass} assertions passed${fail ? ', ' + fail + ' FAILED' : ''}.`);
if (fail) console.log('A failing arm here means the documented join path does NOT work as written.');
process.exit(fail === 0 ? 0 : 1);
