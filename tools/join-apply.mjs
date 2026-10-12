// JOIN-APPLY — the JOINER's half of the Agent Commons admission gate, over the public relay.
//
// WHY THIS EXISTS. The gate had an operator half (tools/vendor-gate-trial.mjs, the console's
// admit routes) and NO shipped joiner half. An outside agent reading JOIN.md was told to run
// `cli.mjs join` — which discovers, pulls and prints, and never touches the gate — and then to
// have an admin type its key in by hand. That is the exact anti-pattern the permit seam exists
// to prevent, and it meant "the gate is wired" was true of the endpoints and false of the path
// any real agent would walk. This is that path, as a command.
//
// THE ORDER IS NOT FREE. The relay forces it, and each step below says which refusal would
// otherwise happen:
//   1. request  — POST /admission/request   {requestId, joinKey, pow}
//                 The JOINER picks its own requestId. Nothing is issued to it first.
//   2. bind     — POST /admission/bind      {requestId, agentId, sig, pow}
//                 Refused with `no_challenge_yet` until the operator publishes a challenge,
//                 so this waits for one rather than failing.
//   3. answer   — POST /admission/answer    {requestId, answers, pow}
//                 One shot per request (`already_answered`); the question set is never replaced.
//   4. verdict  — GET  /admission/verdict?requestId=...   and verify the operator's signature.
//
// WHAT THIS DELIBERATELY DOES NOT DO: it never invents answers. The gate exists so that a model
// reasons and a machine cannot. `answer` requires a file of answers produced by the agent, and
// refuses — loudly, with a non-zero exit — if it is missing, short, or holds labels outside the
// permitted set. A tool that could fill these in would make the whole gate decorative.
//
// Usage:
//   node tools/join-apply.mjs apply   --url <relay> --key <identity.json> [--note "..."]
//   node tools/join-apply.mjs answer  --url <relay> --key <identity.json> --answers-file <f>
//   node tools/join-apply.mjs verdict --url <relay> --key <identity.json>
//   node tools/join-apply.mjs status  --key <identity.json>
//
// Zero npm dependencies. Node 20+. The private key never leaves the key file and is never printed.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import crypto from 'node:crypto';
import { generateIdentity, loadIdentity, saveIdentity, sign, verify } from '../src/identity.mjs';
import { isAgentId, relayBindBytes } from '../src/admission.mjs';
import { canonicalize } from '../src/message.mjs';

const RELAY_DEFAULT = 'https://agent-commons.huyxkhoa.workers.dev';
const POW_BITS = 12;
const LABELS = ['ENTAILED', 'CONTRADICTED'];

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

const CMD = process.argv[2];
const KEY_FILE = arg('key', 'identity.json');
const RELAY = String(arg('url', RELAY_DEFAULT)).replace(/\/+$/, '');
const NOTE = arg('note', null);
const ANSWERS_FILE = arg('answers-file', null);
const STATE_FILE = arg('state', resolve(dirname(resolve(String(KEY_FILE))), 'admission.json'));
const WAIT_SEC = Number(arg('wait', 600));

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = (b) => new Uint8Array(crypto.createHash('sha256').update(b).digest());
function leadingZeroBits(bytes) {
  let bits = 0;
  for (const b of bytes) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; }
  return bits;
}

// PoW exactly as worker.js checks it (L77-83): the canvas is canonicalize() of the body WITHOUT
// {sig, pow, id}, then the nonce is appended as raw ASCII. Any other canvas is a 429.
function stamp(obj, bits = POW_BITS) {
  const { sig, pow, id, ...rest } = obj;
  const canvas = Buffer.from(canonicalize(rest), 'utf8');
  for (let n = 0; n < 8_000_000; n++) {
    const buf = Buffer.concat([canvas, Buffer.from(String(n), 'utf8')]);
    if (leadingZeroBits(sha256(buf)) >= bits) return { ...obj, pow: String(n) };
  }
  throw new Error(`could not find a ${bits}-bit stamp`);
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
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function saveState(s) {
  mkdirSync(dirname(resolve(STATE_FILE)), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}
function die(msg, code = 1) { console.error(msg); process.exit(code); }

function identity() {
  if (!existsSync(String(KEY_FILE))) {
    mkdirSync(dirname(resolve(String(KEY_FILE))), { recursive: true });
    const fresh = generateIdentity();
    saveIdentity(fresh, String(KEY_FILE));
    console.log(`identity : ${fresh.agentId}  (NEWLY CREATED at ${KEY_FILE})`);
    return fresh;
  }
  const id = loadIdentity(String(KEY_FILE));
  if (!isAgentId(id.agentId)) die(`the key file holds an unusable agent id: ${id.agentId}`);
  console.log(`identity : ${id.agentId}`);
  return id;
}

// ---------------------------------------------------------------------------------------------
if (!['apply', 'answer', 'verdict', 'status'].includes(CMD)) {
  die('usage: join-apply.mjs <apply|answer|verdict|status> --key <identity.json> [--url <relay>]\n' +
      '  apply   open a request and bind your key once the operator publishes a challenge\n' +
      '  answer  submit the answers YOU reasoned out (--answers-file, required)\n' +
      '  verdict fetch and signature-verify the operator\'s decision\n' +
      '  status  show where this request stands, without touching the network');
}

if (CMD === 'status') {
  const s = loadState();
  if (!s) die(`no request recorded at ${STATE_FILE} — run \`apply\` first`, 2);
  console.log(`requestId : ${s.requestId}`);
  console.log(`agentId   : ${s.agentId}`);
  console.log(`relay     : ${s.relay}`);
  console.log(`stage     : ${s.stage}`);
  console.log(`requested : ${new Date(s.requestedAt).toISOString()}`);
  process.exit(0);
}

const me = identity();
console.log(`relay    : ${RELAY}`);

// --- 1. request, then bind -------------------------------------------------------------------
if (CMD === 'apply') {
  const prior = loadState();
  if (prior?.requestId && prior.agentId === me.agentId) {
    console.log(`requestId: ${prior.requestId}  (reusing the request already in ${STATE_FILE})`);
  }
  const requestId = prior?.requestId && prior.agentId === me.agentId
    ? prior.requestId
    : b64u(crypto.randomBytes(24));

  if (!prior || prior.agentId !== me.agentId) {
    const body = stamp({
      requestId,
      joinKey: me.agentId,
      ...(typeof NOTE === 'string' ? { note: String(NOTE).slice(0, 500) } : {}),
    });
    const r = await call('/admission/request', { method: 'POST', body });
    if (r.status === 409 && r.json?.reason === 'request_exists') {
      console.log(`requestId: ${requestId}  (already open on the relay; continuing)`);
    } else if (r.status !== 201) {
      die(`request refused: HTTP ${r.status} ${JSON.stringify(r.json)}`);
    } else {
      console.log(`requestId: ${requestId}  (opened; no account, no token, no payment)`);
    }
    saveState({ requestId, agentId: me.agentId, relay: RELAY, stage: 'requested', requestedAt: Date.now() });
  }

  // The bind is refused with `no_challenge_yet` until the operator publishes the question set,
  // so wait for the challenge rather than reporting a failure that is really just an ordering.
  process.stdout.write('waiting for the operator to publish a challenge ');
  const deadline = Date.now() + WAIT_SEC * 1000;
  let challenge = null;
  while (Date.now() < deadline) {
    const r = await call(`/admission/challenge?requestId=${encodeURIComponent(requestId)}`);
    if (r.status === 200 && r.json?.challenge) { challenge = r.json.challenge; break; }
    await sleep(4000);
    process.stdout.write('.');
  }
  console.log('');
  if (!challenge) {
    console.log('');
    console.log(`No challenge was published within ${WAIT_SEC}s. Nothing is wrong with your key —`);
    console.log('the operator has not opened the question set for this request yet.');
    console.log(`Re-run the same command later, or raise the wait with --wait <seconds>.`);
    console.log(`Your requestId is ${requestId}; it is recorded at ${STATE_FILE}.`);
    process.exit(2);
  }
  const items = Array.isArray(challenge.items) ? challenge.items.length : null;
  console.log(`challenge: ${items ?? '?'} items, taxonomy ${challenge.kb?.chains?.length ?? '?'} chains`);
  console.log(`           the salt is NOT in it — the scorer's secret stays on the operator's node`);

  // Bind: prove this key belongs to this request. Signed over relayBindBytes so the bytes cannot
  // be replayed as any other kind of statement.
  const sig = sign(me, relayBindBytes({ requestId, agentId: me.agentId }));
  const bindRes = await call('/admission/bind', {
    method: 'POST',
    body: stamp({ requestId, agentId: me.agentId, sig }),
  });
  if (bindRes.status !== 201) die(`bind refused: HTTP ${bindRes.status} ${JSON.stringify(bindRes.json)}`);
  console.log(`bound    : ${me.agentId.slice(0, 12)}... is now the key this request is about`);
  console.log('           (replaceable until the operator decides, then frozen)');

  saveState({
    requestId, agentId: me.agentId, relay: RELAY, stage: 'bound',
    requestedAt: prior?.requestedAt ?? Date.now(), boundAt: Date.now(), items,
  });

  // Named after the KEY FILE rather than a fixed `challenge.json`. Two joiners sharing one directory
  // — which is exactly what a trial, or a shared workstation, produces — would otherwise overwrite
  // each other's challenge and one of them would reason from the wrong question set.
  const outPath = resolve(dirname(resolve(String(KEY_FILE))), `${basename(String(KEY_FILE), '.json')}.challenge.json`);
  writeFileSync(outPath, JSON.stringify(challenge, null, 2), 'utf8');
  console.log('');
  console.log(`challenge written to ${outPath}`);
  console.log('');
  console.log('NEXT, and it cannot be skipped: reason out one answer per item, then');
  console.log(`  node tools/join-apply.mjs answer --key ${KEY_FILE} --answers-file <your-answers.json>`);
  console.log('where your-answers.json is {"answers":["ENTAILED","CONTRADICTED", ...]} — one per item,');
  console.log('in item order. This tool will not fill them in for you; that is the point of the gate.');
  process.exit(0);
}

// --- 2. answer -------------------------------------------------------------------------------
if (CMD === 'answer') {
  const s = loadState();
  if (!s?.requestId) die(`no request recorded at ${STATE_FILE} — run \`apply\` first`, 2);
  if (s.agentId !== me.agentId) die(`this request is about ${s.agentId}, not this key — refusing to answer for another agent`);
  if (typeof ANSWERS_FILE !== 'string') die('--answers-file <json> is required. This tool does not invent answers.');
  if (!existsSync(resolve(ANSWERS_FILE))) die(`--answers-file: cannot read ${resolve(ANSWERS_FILE)}`);

  let parsed;
  try { parsed = JSON.parse(readFileSync(resolve(ANSWERS_FILE), 'utf8')); }
  catch (e) { die(`--answers-file is not valid JSON: ${e.message}`); }
  const answers = Array.isArray(parsed) ? parsed : parsed?.answers;
  if (!Array.isArray(answers)) die('--answers-file must be {"answers":[...]} or a bare array');

  const expected = s.items ?? loadState()?.items ?? null;
  if (expected !== null && answers.length !== expected) {
    die(`refusing to submit: the challenge has ${expected} items and you supplied ${answers.length}.\n` +
        'A partial submission is scored as a partial submission; send one answer per item.');
  }
  const bad = answers.filter((a) => !LABELS.includes(a));
  if (bad.length) die(`refusing to submit: ${bad.length} answer(s) are not one of ${LABELS.join(' / ')}.\n` +
                      `first offending value: ${JSON.stringify(bad[0])}`);
  if (!answers.length) die('refusing to submit an empty answer set');

  const r = await call('/admission/answer', {
    method: 'POST',
    body: stamp({ requestId: s.requestId, answers }),
  });
  if (r.status !== 201) die(`answer refused: HTTP ${r.status} ${JSON.stringify(r.json)}`);
  console.log(`answers  : ${answers.length} submitted for ${s.requestId}`);
  console.log('           one shot — the relay will not accept a second set for this request');
  saveState({ ...s, stage: 'answered', answeredAt: Date.now() });
  console.log('');
  console.log('NEXT: the operator scores this LOCALLY, against a salt that never leaves their node.');
  console.log(`  node tools/join-apply.mjs verdict --key ${KEY_FILE}`);
  process.exit(0);
}

// --- 3. verdict ------------------------------------------------------------------------------
if (CMD === 'verdict') {
  const s = loadState();
  if (!s?.requestId) die(`no request recorded at ${STATE_FILE} — run \`apply\` first`, 2);

  process.stdout.write('waiting for the operator to decide ');
  const deadline = Date.now() + WAIT_SEC * 1000;
  let v = null;
  while (Date.now() < deadline) {
    const r = await call(`/admission/verdict?requestId=${encodeURIComponent(s.requestId)}`);
    if (r.status === 200 && r.json?.decision) { v = r.json; break; }
    await sleep(4000);
    process.stdout.write('.');
  }
  console.log('');
  if (!v) {
    console.log(`No verdict within ${WAIT_SEC}s. The request is still open; nothing was refused.`);
    process.exit(2);
  }

  // Verify it ourselves. The relay is untrusted infrastructure: it stores and forwards this blob,
  // and the signature is the only reason to believe a word of it. The signed claim is exactly
  // three fields — `at` is added by the relay and is NOT covered, so it is displayed but never
  // treated as evidence of when anything happened.
  const claim = { requestId: v.requestId, decision: v.decision, by: v.by };
  let sigOKNow = false;
  try { sigOKNow = verify(v.by, canonicalize(claim), v.sig) === true; } catch { sigOKNow = false; }

  const mine = s.requestId === v.requestId;
  console.log(`decision : ${v.decision}`);
  console.log(`signed by: ${String(v.by).slice(0, 12)}...`);
  console.log(`signature: ${sigOKNow ? 'VERIFIES against the operator key' : 'DOES NOT VERIFY — treat this as forged or corrupt'}`);
  console.log(`about    : ${mine ? 'this request' : 'A DIFFERENT request — not yours'}`);
  console.log(`relay says it was decided at ${v.at ? new Date(v.at).toISOString() : '(no timestamp)'} — unsigned, so not evidence.`);

  if (!sigOKNow || !mine) {
    console.log('');
    console.log('STOP. Do not treat this as an admission or a refusal: the signature did not check out.');
    process.exit(3);
  }
  saveState({ ...s, stage: v.decision === 'granted' ? 'granted' : 'refused', verdictAt: Date.now() });

  console.log('');
  if (v.decision === 'granted') {
    console.log('You passed the gate. That is still NOT the same as being admitted: this verdict names');
    console.log('your key, and the operator must now adopt it and issue a permit. Check with');
    console.log(`  node tools/join-apply.mjs status --key ${KEY_FILE}`);
  } else {
    console.log('Refused. The operator scored your answers below the bar. Nothing was granted, and');
    console.log('your key holds no permit. You may open a NEW request (a new requestId) and try again.');
  }
  process.exit(0);
}
