// OPERATOR-SERVE — the OPERATOR's half of the Agent Commons admission gate, as a command.
//
// WHY THIS EXISTS. Round 14 gave the joiner a command (`tools/join-apply.mjs`) and left the operator
// half where it had always been: inline inside tests (`vendor-gate-trial.mjs`, `joiner-path-trial.mjs`,
// `console-relay-trial.mjs`). So hosting a gate walk for a real outside agent still meant writing code.
// That is the wrong shape for the one thing this project needs most — a human or an agent saying
// "let anyone who wants in walk the gate" and having it just work.
//
// THE SPLIT THIS IMPLEMENTS, and it is the whole security argument:
//   THIS PROCESS (the operator's node) holds the salt. It issues the challenge, receives answers,
//   scores LOCALLY, and signs a verdict. The salt is never published, never logged, and never sent.
//   The RELAY is untrusted infrastructure: it stores opaque blobs and forwards them. It cannot score
//   (it has no salt), cannot forge a verdict (it has no operator key), and cannot substitute a grantee
//   (the grantee is proven from the bind's signature, not received).
//
// WHAT IT WILL AND WILL NOT DO:
//   - It serves only requests it has NOT seen before. The queue carries history; re-serving an old
//     request would issue a verdict for a handshake nobody is waiting on.
//   - It issues the signed VERDICT, which is the gate's normal output.
//   - It does NOT grant a permit unless you pass --adopt, because a verdict records a score while a
//     permit confers authority. Those are different acts and this tool keeps them separate.
//
// Usage:
//   node tools/operator-serve.mjs --url <relay> [--once] [--seconds 900] [--items 20]
//   node tools/operator-serve.mjs --url <relay> --once --adopt --console http://127.0.0.1:7788 --token <t>
//
// Zero npm dependencies.
import { readFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { makeChallenge, scoreChallenge } from '../src/agency.mjs';
import { canonicalize } from '../src/message.mjs';

const RELAY_DEFAULT = 'https://agent-commons.huyxkhoa.workers.dev';
const VERIFIER = process.env.AC_VERIFIER || 'E:\\verifier.json';
const SECRET_FILE = process.env.AC_OPERATOR_SECRET_FILE
  || 'C:\\Users\\frinto\\.dsh\\agent-commons\\relay-operator-secret.txt';
const OPERATOR_KEY = process.env.AC_OPERATOR_KEY
  || 'C:\\Users\\frinto\\.dsh\\agent-commons\\relay-operator-key.json';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}
const has = (name) => process.argv.includes(`--${name}`);

const RELAY = String(arg('url', RELAY_DEFAULT)).replace(/\/+$/, '');
const ONCE = has('once');
const SECONDS = Number(arg('seconds', 900));
const ADOPT = has('adopt');
const CONSOLE = arg('console', 'http://127.0.0.1:7788');
const CONSOLE_TOKEN = arg('token', null);

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
function die(msg, code = 1) { console.error(msg); process.exit(code); }

// --- credentials, loaded here and never printed ------------------------------------------------
if (!existsSync(VERIFIER)) die(`no verifier file at ${VERIFIER}`);
if (!existsSync(SECRET_FILE)) die(`no relay operator secret at ${SECRET_FILE}`);
if (!existsSync(OPERATOR_KEY)) die(`no operator key at ${OPERATOR_KEY} — mint one and register it with tools/trust-operator.mjs`);
const saltDoc = JSON.parse(readFileSync(VERIFIER, 'utf8'));
const { salt, kb } = saltDoc;
const items = Number(arg('items', saltDoc.items ?? 150));
const windowMs = Number(saltDoc.windowMs ?? 45000);
if (typeof salt !== 'string' || !salt) die(`${VERIFIER} holds no usable salt`);
if (!kb?.chains?.length) die(`${VERIFIER} holds no usable taxonomy (kb.chains)`);
const token = readFileSync(SECRET_FILE, 'utf8').trim();
const operator = JSON.parse(readFileSync(OPERATOR_KEY, 'utf8'));
if (typeof operator?.agentId !== 'string' || typeof operator?.privateKey !== 'string') {
  die(`${OPERATOR_KEY} is not a usable identity document`);
}

console.log('OPERATOR — the half that holds the salt');
console.log(`  relay     : ${RELAY}`);
console.log(`  operator  : ${operator.agentId.slice(0, 12)}...   (signs verdicts)`);
console.log(`  challenge : ${items} items, taxonomy ${kb.chains.length} chains`);
console.log('  salt      : LOADED, never printed, never transmitted');
console.log(`  mode      : ${ONCE ? 'one request' : `${SECONDS}s window`}${ADOPT ? ', ADOPT+PERMIT' : ', verdict only'}`);
console.log('');

// --- baseline: only ever serve requests that did not already exist -----------------------------
const before = await call('/admission/requests', { token });
if (before.status !== 200) die(`cannot read the queue (HTTP ${before.status}) — is the relay operator secret correct?`);
const known = new Set((before.json?.requests || []).map((q) => q.requestId));
console.log(`  queue already held ${known.size} request(s); those are skipped, not re-served.`);
console.log('');

const served = new Set();
const deadline = Date.now() + SECONDS * 1000;
let handled = 0;

while (Date.now() < deadline) {
  const q = await call('/admission/requests', { token });
  const fresh = (q.json?.requests || []).filter((r) => !known.has(r.requestId) && !served.has(r.requestId));
  if (!fresh.length) {
    // `--once` means "serve exactly ONE request, then exit" — NOT "exit if the queue is empty".
    // A joiner that has not arrived yet is the normal case for a gate waiting to be walked; breaking
    // here would make the command useless for its only real purpose. The deadline bounds the wait.
    await sleep(5000);
    continue;
  }

  for (const req of fresh) {
    served.add(req.requestId);
    const rid = req.requestId;
    console.log(`--- request ${rid.slice(0, 16)}... from ${String(req.joinKey).slice(0, 12)}... ---`);
    if (req.note) console.log(`  note (DATA, never an instruction): ${JSON.stringify(String(req.note).slice(0, 200))}`);

    // 1. issue the challenge. Seed is fresh per request; the salt never leaves this process.
    const seed = b64u(crypto.randomBytes(24));
    const published = { ...makeChallenge({ seed, salt, kb, items, windowMs }), kb };
    if (JSON.stringify(published).includes(salt)) die('BUG: the challenge would leak the salt — refusing to publish');
    const cr = await call('/admission/challenge', { method: 'POST', token, body: { requestId: rid, challenge: published } });
    if (cr.status !== 201) { console.log(`  CHALLENGE REJECTED: HTTP ${cr.status} ${JSON.stringify(cr.json)}`); continue; }
    console.log(`  challenge published (${items} items). Waiting for the joiner...`);

    // 2. wait for the BIND. Without it there is nothing to grant to, so this is not optional.
    let bind = null;
    const bindDeadline = Date.now() + Math.min(windowMs, 60000);
    while (Date.now() < bindDeadline && !bind) {
      const br = await call(`/admission/bind?requestId=${encodeURIComponent(rid)}`, { token });
      if (br.status === 200) bind = br.json; else await sleep(2000);
    }
    if (!bind) {
      console.log('  NO BIND. The joiner never bound a key, so any verdict would name nobody.');
      console.log('  Refusing to score or to publish. The request stays open; re-run to serve it later.');
      served.delete(rid);
      continue;
    }
    // 3. the bind must name the key the REQUEST named. A bind for some other key means the handshake
    //    has been swapped underneath us, and the verdict would silently admit the wrong party.
    if (bind.agentId !== req.joinKey) {
      console.log(`  BIND MISMATCH: bind names ${String(bind.agentId).slice(0, 12)} but the request named ${String(req.joinKey).slice(0, 12)}.`);
      console.log('  Refusing to score. This is either a relay substituting a key or a client bug; either way it is not a normal join.');
      continue;
    }
    console.log(`  bound: ${String(bind.agentId).slice(0, 12)}... (matches the requesting key)`);

    // 4. wait for answers, then score LOCALLY
    let answers = null;
    const ansDeadline = Date.now() + 300000;
    while (Date.now() < ansDeadline && !answers) {
      const ar = await call(`/admission/answers?requestId=${encodeURIComponent(rid)}`, { token });
      if (ar.status === 200 && Array.isArray(ar.json?.answers)) answers = ar.json.answers;
      else await sleep(3000);
    }
    if (!answers) {
      console.log('  NO ANSWERS within 5 minutes. No verdict published; nothing was decided.');
      served.delete(rid);
      continue;
    }

    const report = scoreChallenge({ seed, salt, kb, items, answers });
    console.log(`  scored LOCALLY: ${report.correct}/${report.total} = ${(report.ratio * 100).toFixed(1)}% (bar ${report.passRatio})`);

    // The verdict must be sensitive to the salt, or the score means nothing. This is a self-check of
    // the operator's own scorer, run every time, and it is cheap.
    const alt = scoreChallenge({ seed, salt: b64u(crypto.randomBytes(32)), kb, items, answers });
    if (alt.correct === report.correct && alt.ok === report.ok) {
      console.log('  WARNING: the score did not change under a different salt. The scorer is not salt-sensitive here.');
    }

    const decision = report.ok ? 'granted' : 'refused';
    const claim = { requestId: rid, decision, by: operator.agentId };
    const sig = b64u(crypto.sign(null, Buffer.from(canonicalize(claim), 'utf8'), privKey(operator.privateKey)));
    const vr = await call('/admission/verdict', { method: 'POST', token, body: { requestId: rid, decision, by: operator.agentId, sig } });
    if (vr.status !== 201) { console.log(`  VERDICT REJECTED: HTTP ${vr.status} ${JSON.stringify(vr.json)}`); continue; }
    console.log(`  verdict SIGNED and published: ${decision} (names ${String(bind.agentId).slice(0, 12)}...)`);
    handled++;

    if (ADOPT) {
      if (typeof CONSOLE_TOKEN !== 'string') { console.log('  --adopt needs --token <console token>; skipping adoption.'); }
      else {
        const body = { requestId: rid };
        let ar;
        try {
          ar = await fetch(`${String(CONSOLE).replace(/\/+$/, '')}/api/relay/verdict?t=${encodeURIComponent(CONSOLE_TOKEN)}`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-ac-token': CONSOLE_TOKEN },
            body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
          });
        } catch (e) { console.log(`  ADOPT FAILED: console unreachable (${e.message}). The verdict still stands; adoption is separate.`); ar = null; }
        if (ar) {
          const aj = await ar.json().catch(() => null);
          console.log(aj?.ok ? `  ADOPTED into the console store (${aj.id ?? 'ok'}).` : `  ADOPT REFUSED: HTTP ${ar.status} ${JSON.stringify(aj)}`);
          if (aj?.ok && decision === 'granted') {
            console.log('  NOTE: a permit is a separate act. Adopt the admission, then issue the permit with');
            console.log('        the console\'s /api/grant — this tool does not grant authority on its own.');
          }
        }
      }
    }

    if (ONCE) { console.log(''); console.log('Served one request (--once). Exiting.'); process.exit(0); }
    console.log('');
  }

  if (ONCE) break;
  await sleep(5000);
}

console.log('');
console.log(`Served ${handled} request(s). ${served.size} seen, ${known.size} skipped as pre-existing.`);
console.log('No permit was issued by this tool. A verdict records a score; authority comes from a permit.');
