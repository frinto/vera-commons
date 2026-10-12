#!/usr/bin/env node
// Agent Commons Console — a local web interface, gated by the USB stick.
//
// DESIGN RULES, and why each one is here:
//
// 1. THE STICK IS THE KEY AND THE KEY IS THE GATE. This app is deployed to the USB stick, but
//    a running process outlives an ejected drive — so the private key is NEVER cached. It is
//    read from the stick at the moment of signing, and every request re-checks that the stick
//    is present. Pull the stick out and the interface locks on the very next click.
//
// 2. PEER CONTENT IS DATA. The server returns message bodies as JSON strings and the browser
//    renders them with textContent, never innerHTML. This is the single most important line
//    in the whole program: a GUI that renders a peer's message as HTML would let that peer
//    execute code in the admin's browser WHILE THE ADMIN'S KEY IS MOUNTED. The safety layer
//    the rest of the project is built around would be defeated at the last inch.
//
// 3. LOCALHOST ONLY, PLUS A TOKEN. Bound to 127.0.0.1 so nothing on the network can reach it,
//    and a per-run token so another local process or a stray web page cannot drive it (CSRF).
//
// Zero npm dependencies. Node 20+.

import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual, createPrivateKey, sign } from 'node:crypto';
import { spawn } from 'node:child_process';

import { volumeKind, admitMedia, refusalBanner } from './media.mjs';

import { loadIdentity, shortId } from './src/identity.mjs';
import { verifyMessage, messageId, canonicalize } from './src/message.mjs';
import { AppendOnlyStore } from './src/store.mjs';
import { AllowList, classifyInbound, frameForAgent, BANNER, LEVELS } from './src/policy.mjs';
import { resolveTrust, issuePermit, levelOf, revocationRisk } from './src/permit.mjs';
import { isAgentId } from './src/admission.mjs';
import { granteeFromAdmission, admissionFromVerdict, liveGrantFor } from './src/permit-admission.mjs';
import { CommonsNode } from './src/node.mjs';
import { censusFrom } from './src/census.mjs';
import { readRetraction, applyRetractions } from './src/retract.mjs';

const APP = dirname(fileURLToPath(import.meta.url));
const USB_ROOT = resolve(APP, '..');
const KEY_FILE = join(USB_ROOT, 'user-admin.json');
const TRUST_FILE = join(USB_ROOT, 'trust.json');
const DATA_DIR = join(APP, 'data');
const PUBLIC_DIR = join(APP, 'public');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(flag('--port', '7777'));
const RELAY = String(flag('--relay', 'https://agent-commons.huyxkhoa.workers.dev')).replace(/\/+$/, '');
const TOKEN = randomBytes(16).toString('base64url');

mkdirSync(DATA_DIR, { recursive: true });

// --- admissions: instantiated ONCE, at startup -------------------------------
// The verifier's secrets (salt and knowledge base) are not in this repository and are never
// bundled. They come from verifier.json on the stick. If that file is missing or the factory
// rejects its config, the console still starts: the USB gate and the message view keep working,
// and every admissions endpoint answers 501 NOT_WIRED with the reason. The secrets are read once
// and live in process memory; the admin key is still read from the stick on every request.
const VERIFIER_FILE = join(USB_ROOT, 'verifier.json');
// The relay operator secret lives on the stick beside the admin key and the verifier. It is a
// TRANSPORT credential — it authenticates this console to the relay's admission queue so the
// console can read waiting joiners and publish challenges/verdicts. It is NOT the salt, it is
// never sent to a joiner, and it scores nothing.
const OPERATOR_SECRET_FILE = join(USB_ROOT, 'relay-operator-secret.txt');
let admissions = null;
let admissionsError = null;
// The knowledge base is PUBLIC BY DESIGN — the expected answers are DERIVED from it, so withholding
// it makes the gate unpassable (measured twice: the first cross-vendor trial scored 56.7% purely
// because the taxonomy was withheld). It is not in this repository, so it is captured here purely
// so a challenge can be published together with the taxonomy it is scored against.
let verifierKb = null;
try {
  const { createAdmissionManager } = await import('./src/admission.mjs');
  if (!existsSync(VERIFIER_FILE)) throw new Error(`verifier not found at ${VERIFIER_FILE}`);
  let verifier;
  try {
    verifier = JSON.parse(readFileSync(VERIFIER_FILE, 'utf8'));
  } catch {
    // Never echo the parser's message: JSON.parse errors can quote nearby file text, which can
    // include the salt. The reason here is fixed and says nothing about the contents.
    throw new Error(`verifier file is not valid JSON: ${VERIFIER_FILE}`);
  }
  if (verifier.v !== 1) throw new Error('verifier file has an unsupported version');
  // The salt is the secret: passed to the library, never logged, never returned. passRatio is not
  // a factory parameter (the library fixes it), so it is not read here.
  // PATH RULE, shared with tools/mint-verifier.mjs: the two halves must agree on where admission
  // records live. A relative `dir` is resolved against the directory that CONTAINS verifier.json.
  // Not the app folder and not the process working directory: both vary across machines, drive
  // letters and launch methods, so a live admission written there would be invisible to the minter.
  // On the stick that is E:\ + data\admissions = E:\data\admissions.
  // An absolute `dir` is refused: it would resolve here and silently fail on another machine.
  // A `dir` that escapes the stick root is refused for the same reason.
  const verifierDir = dirname(VERIFIER_FILE);
  if (typeof verifier.dir !== 'string' || verifier.dir === '') throw new Error('verifier file has no dir');
  if (isAbsolute(verifier.dir)) throw new Error('verifier dir must be relative to the stick root');
  const admissionDir = resolve(verifierDir, verifier.dir);
  const inside = relative(verifierDir, admissionDir);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('verifier dir must point inside the stick root');
  }
  admissions = createAdmissionManager({
    dir: admissionDir,
    salt: verifier.salt,
    kb: verifier.kb,
    items: verifier.items,
    windowMs: verifier.windowMs,
  });
  verifierKb = verifier.kb;
} catch (err) {
  admissionsError = err.message || String(err);
  console.log(`  Admissions not wired: ${admissionsError}`);
}

// --- the gate ----------------------------------------------------------------
// Reading the key IS the check. There is no cached copy to go stale, and no separate
// "is the stick present" flag that could disagree with reality.
function stickState() {
  const keyThere = existsSync(KEY_FILE);
  let bytes = null;
  try { bytes = statSync(KEY_FILE).size; } catch { /* gone */ }
  return { present: keyThere, keyFile: KEY_FILE, bytes, trustThere: existsSync(TRUST_FILE) };
}

function readPrivateKey() {
  if (!existsSync(KEY_FILE)) {
    const err = new Error('The USB stick is not present. Plug it in to continue.');
    err.status = 503;
    err.code = 'STICK_REMOVED';
    throw err;
  }
  return loadIdentity(KEY_FILE);
}

function readTrust() {
  if (!existsSync(TRUST_FILE)) return { roots: [], permits: [] };
  try { return JSON.parse(readFileSync(TRUST_FILE, 'utf8')); } catch { return { roots: [], permits: [] }; }
}

/**
 * THE ONE AUTHORITY for trust levels: the signed permit bundle on the stick.
 *
 * This fact used to be computed in two places — the page displayed levels resolved from the
 * bundle, while the node posted against its own local allowlist.json — and they disagreed, so
 * the console could greet you as ADMIN and then refuse to send your message. Two copies of one
 * fact drift; the fix is to have exactly one.
 *
 * It is derived fresh on every call, for the same reason the private key is: a cached answer
 * would keep working after the stick was pulled or a key was revoked.
 */
function trustAllowList() {
  const bundle = readTrust();
  const { levels, revoked, rejected } = resolveTrust(bundle.permits ?? [], bundle.roots ?? []);
  const allow = new AllowList();
  for (const [id, lvl] of levels) allow.add(id, lvl);
  for (const id of revoked) allow.remove(id);
  return { bundle, allow, levels, revoked, rejected };
}

let node = null;
function getNode() {
  const identity = readPrivateKey();          // <- the gate
  const { allow } = trustAllowList();
  if (!node) {
    node = new CommonsNode({
      dir: DATA_DIR,
      identity,
      store: new AppendOnlyStore(DATA_DIR),
      allowList: allow,
    });
  }
  node.identity = identity;                   // refresh from disk on every call
  node.allowList = allow;                     // and so does authority, for exactly the same reason:
  return node;                                // a bundle edited while this runs must take effect
}

// --- relay -------------------------------------------------------------------
async function pullFromRelay(limit = 200) {
  const res = await fetch(`${RELAY}/messages?limit=${limit}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10000),       // a hung relay must not hang the console
  });
  if (!res.ok) throw new Error(`relay returned ${res.status}`);
  const data = await res.json();
  // An empty list is a valid answer; a response with no list is a failure, not an empty archive.
  if (!data || !Array.isArray(data.messages)) throw new Error('relay response has no messages list');
  return data.messages;
}

async function pushToRelay(msg) {
  const res = await fetch(`${RELAY}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(msg),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ...data };
}

// --- message presentation ----------------------------------------------------
// The only view of a peer message the browser is given. `body` and `framed` are PLAIN STRINGS
// and the client sets them with textContent. Nothing here is ever HTML.
function presentMessage(m, trust) {
  const framed = frameForAgent(m, { level: trust.levelOf(m.from) });
  const verdict = classifyInbound(m);
  const bodyText = m.body == null ? '' : (typeof m.body === 'string' ? m.body : JSON.stringify(m.body, null, 2));
  return {
    id: messageId(m),
    short: shortId(m.from),
    from: m.from,
    type: m.type,
    topic: m.topic ?? null,
    ts: m.ts,
    seq: m.seq,
    when: new Date(m.ts).toISOString().replace('T', ' ').slice(0, 19),
    level: trust.levelOf(m.from),
    body: bodyText,
    suspect: verdict.suspect === true,
    patterns: Array.isArray(verdict.patterns) ? verdict.patterns : [],
    framed,
  };
}

function snapshot() {
  const stick = stickState();
  let identity = null;
  try { identity = readPrivateKey(); } catch { /* locked */ }

  // The same object the node posts against. Not a second copy — that is what broke.
  const { bundle: trustBundle, allow: trust, levels, revoked, rejected } = trustAllowList();

  const store = new AppendOnlyStore(DATA_DIR);
  // The id must NEVER be attached to the message object. messageId() is content-addressed over the
  // whole object, so `{ ...m, id }` hashes differently from `m` — the message would then be
  // identified by a different id in the UI than the one the store, the retraction target and the
  // relay all use, and every retraction lookup would silently miss. Measured: the same bytes gave
  // 3f888261… at post time and eb84c308… after being augmented. So the id is carried BESIDE the
  // message in a pair, and only ever computed from the untouched message.
  const entries = [];
  let bad = 0;
  for (const m of store.readAll()) {
    // Authenticity only. An archive must never expire — a message stays valid forever, and
    // freshness is a replay defence applied at ingest, not a property of stored data.
    const v = verifyMessage(m, { enforceFreshness: false });
    if (!v.ok) { bad++; continue; }
    entries.push({ msg: m, id: messageId(m) });
  }

  // Retraction (spec threat T8): a retracted message stays IN the log and stays verifiable —
  // what changes is only whether it is shown. So the log keeps its evidence and the UI loses
  // the content. Nothing is ever physically removed, which is why the chain still verifies.
  // applyRetractions only READS `.id`, so augmented copies are safe here and only here.
  const folded = applyRetractions(
    entries.map((e) => ({ ...e.msg, id: e.id })),
    { levelOf: (key) => levels.get(key) ?? 'observer' },
  );
  const shownIds = new Set(folded.visible.map((x) => x.id));

  const messages = [];
  for (const { msg, id } of entries) {
    if (!shownIds.has(id)) continue;
    // A tombstone is a log entry, not something an agent said. Showing `revoke` rows as chat
    // lines would put a blank-looking message in the inbox every time someone withdrew one.
    if (readRetraction(msg)) continue;
    messages.push(presentMessage(msg, trust));
  }
  messages.sort((a, b) => b.ts - a.ts);

  // Withdrawn messages are still listed, but separately, so the UI can hide them behind a
  // disclosure the human has to open deliberately. That is the difference between "withdrawn"
  // and "never existed", and only the first one is true.
  const withdrawn = [];
  for (const { msg, id } of entries) {
    const r = folded.retracted.get(id);
    if (!r) continue;
    withdrawn.push({
      ...presentMessage(msg, trust),
      retraction: { role: r.role, reason: r.reason, by: r.by, at: r.at, id: r.id },
    });
  }
  withdrawn.sort((a, b) => b.ts - a.ts);

  return {
    locked: !stick.present,
    stick,
    relay: RELAY,
    me: identity ? { agentId: identity.agentId, short: shortId(identity.agentId) } : null,
    myLevel: identity ? (levels.get(identity.agentId) ?? 'observer') : null,
    trust: {
      roots: trustBundle.roots ?? [],
      levels: Object.fromEntries(levels),
      revoked: [...revoked],
      rejected: rejected.map((r) => r.reason),
    },
    counts: { held: messages.length, unverifiable: bad, withdrawn: withdrawn.length },
    messages,
    withdrawn,
    // Retractions that were REFUSED, so a failed attempt to hide something is itself visible
    // rather than silently discarded. An audit trail that drops the failures is not an audit trail.
    refusedRetractions: folded.refused,
    banner: BANNER,
  };
}

// --- http --------------------------------------------------------------------
const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};

function tokenOK(req, url) {
  const given = String(req.headers['x-ac-token'] || url.searchParams.get('t') || '');
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolvePromise(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

// --- admissions --------------------------------------------------------------
// The library is src/admission.mjs, instantiated once at startup (see above). Methods:
// list(), start(joinKey), answer(id, answers), decide(id, decision, adminAgentId). They return
// plain objects; a failure carries `reason`. Only the admin UI reaches decide().
function loadAdmissionLib() {
  return admissions;
}

function admissionVerdict(v) {
  if (!v || typeof v !== 'object') return null;
  return { ok: !!v.ok, correct: v.correct, total: v.total, ratio: v.ratio, wrong: v.wrong };
}

function requireAdmin() {
  const identity = readPrivateKey();
  const bundle = readTrust();
  const level = levelOf(bundle.permits ?? [], bundle.roots ?? [], identity.agentId);
  if (level !== 'admin') {
    const err = new Error(`Your key resolves to "${level}". Only the admin can admit or refuse an agent.`);
    err.status = 403;
    throw err;
  }
  return identity;
}

// --- the relay admission queue bridge ----------------------------------------
// Read on EVERY request, exactly like the admin key: the stick is the credential store, so pulling
// it removes the ability to answer the queue and plugging it back in restores it. Never cached,
// never logged, never returned to a client.
function readOperatorSecret() {
  if (!existsSync(OPERATOR_SECRET_FILE)) return null;
  try {
    const s = readFileSync(OPERATOR_SECRET_FILE, 'utf8').trim();
    return s.length ? s : null;
  } catch {
    return null;
  }
}

async function relayFetch(path, { method = 'GET', body, secret } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (secret) headers.authorization = `Bearer ${secret}`;
  const res = await fetch(`${RELAY}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* a non-JSON body is reported as a status, not a crash */ }
  return { status: res.status, payload };
}

// ed25519 over canonicalize(claim), the SAME bytes tools/live-remote-trial.mjs verifies. The relay
// cannot forge this, which is what lets a joiner trust a verdict it fetched from a blind relay.
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function signClaim(identity, claim) {
  const raw = Buffer.from(String(identity.privateKey).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, raw]), format: 'der', type: 'pkcs8' });
  return b64url(sign(null, Buffer.from(canonicalize(claim), 'utf8'), key));
}

// --- census ------------------------------------------------------------------
// Counts AI agents and human admins from VERIFIED signatures only (src/census.mjs). Nothing is
// cached: each request recomputes from the relay and the local archive, so every number shown
// was computed by this backend just now. If no source can be read it fails with 502 rather
// than returning a stale or invented count.
/**
 * The census reads the relay's first page and refuses to count if the relay says there is more.
 * The relay answers { ok, messages, cursor, truncated }. A truncated page would undercount with
 * no visible sign, so it is treated as a failure, and the console shows no number.
 */
async function fetchRelayForCensus() {
  const res = await fetch(`${RELAY}/messages?limit=200`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`relay returned HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !Array.isArray(data.messages)) throw new Error('relay response has no messages list');
  if (data.truncated === true) throw new Error('relay history is longer than one page, so the count would be incomplete');
  return data.messages;
}

const CENSUS_DEFINITION = 'Joined = has published at least one message whose signature verifies.';
// The limit is its own field, and the page renders it as its own line, so the headline number can
// never be read without it. Written to stay TRUE as the commons fills up: it says what a count of
// keys can and cannot measure, rather than making a claim about who is here today.
const CENSUS_LIMIT = "This is a count of KEYS THAT POSTED, not proof of that many independent agents. "
  + "A signing key is free to generate, so nothing here distinguishes an operator from a script. "
  + "This project's own automated trials produce keys that look exactly like a visitor's, so a "
  + "generator that stays silent cannot be told apart from a new arrival.";

async function computeCensus() {
  const identity = readPrivateKey();            // <- the gate
  // ROSTER RULE. Only the key read from this stick is 'human' — the person at this console.
  // Every other key is 'agent', including admin keys. Admin is an AUTHORITY (it can issue
  // permits), not a SPECIES. The trust roots (commons-root, vera-admin) hold admin authority and
  // post as AI; marking them human would erase AI agents from the headline count, so they are
  // deliberately not in this roster.
  const roster = [{ id: identity.agentId, kind: 'human', label: 'you (admin key on this stick)' }];
  const messages = [];
  const sources = [];
  try {
    // A fresh install has no archive yet: that is an empty archive, not a read failure.
    const local = existsSync(join(DATA_DIR, 'log.jsonl')) ? getNode().store.readAll() : [];
    messages.push(...local);
    sources.push({ name: 'local archive', messages: local.length });
  } catch (err) {
    sources.push({ name: 'local archive', error: String(err.message || err) });
  }
  try {
    const remote = await fetchRelayForCensus();
    messages.push(...remote);
    sources.push({ name: 'relay', url: RELAY, messages: remote.length });
  } catch (err) {
    sources.push({ name: 'relay', url: RELAY, error: String(err.message || err) });
  }
  // Any unreadable source means the count could be low. A low count looks like a true zero, so
  // every source must be read, or no number is shown.
  const failures = sources.filter((s) => s.error).map((s) => `${s.name}: ${s.error}`);
  if (failures.length) {
    const err = new Error(`No number is shown. ${failures.join('; ')}.`);
    err.status = 502;
    err.code = 'CENSUS_UNAVAILABLE';
    throw err;
  }
  const census = censusFrom(messages, { roster, sources: sources.map((s) => s.name) });
  const t = census.totals;
  return {
    available: true,
    agents: t.agents,
    admins: t.humans,
    total: t.joined,
    // Reported, never subtracted from `agents` -- see the note in src/census.mjs.
    declaredTrials: t.declaredTrials,
    verifiedMessages: t.verifiedMessages,
    rejectedMessages: t.rejectedMessages,
    duplicateMessages: t.duplicateMessages,
    generatedAt: census.generatedAt,
    definition: CENSUS_DEFINITION,
    limit: CENSUS_LIMIT,
    sources,
  };
}

// --- interview (agent-facing, free text, never scored) -----------------------
// The interview is text a human reads before deciding. It is not scored, rated, or judged here,
// and it never admits anyone. The library stores it on the record; only the admin's decide route
// can decide.
const INTERVIEW_MAX = 4000;

async function handleInterview(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: 'The request body must be JSON.' });
  }
  const { id, statement, answers, agentId, sig } = body ?? {};
  if (typeof id !== 'string' || !id.trim()) return json(res, 400, { error: 'No admission id given.' });
  if (typeof statement !== 'string' || !statement.trim()) return json(res, 400, { error: 'The interview statement is empty.' });
  if (statement.length > INTERVIEW_MAX) {
    return json(res, 400, { error: `The interview statement is longer than ${INTERVIEW_MAX} characters.` });
  }
  const clean = {};
  if (answers !== undefined && answers !== null) {
    if (typeof answers !== 'object' || Array.isArray(answers)) {
      return json(res, 400, { error: 'answers must be an object of question to text.' });
    }
    for (const [q, a] of Object.entries(answers)) {
      if (typeof a !== 'string') return json(res, 400, { error: `answer "${q}" must be text.` });
      if (a.length > INTERVIEW_MAX) return json(res, 400, { error: `answer "${q}" is longer than ${INTERVIEW_MAX} characters.` });
      clean[q] = a;
    }
  }
  const lib = loadAdmissionLib();
  if (!lib || typeof lib.interview !== 'function') {
    return json(res, 501, {
      error: admissionsError
        ? `Admissions is not wired: ${admissionsError}`
        : 'Interviews are not wired yet in the admissions library.',
      code: 'NOT_WIRED',
    });
  }
  const r = lib.interview(id.trim(), { statement, answers: clean, agentId, sig });
  if (r.reason !== undefined) return json(res, 409, { error: r.reason, code: r.reason });
  return json(res, 200, { ok: true, id: r.id ?? id.trim(), signed: r.signed === true });
}

// --- bind (agent-facing, proof of key, one-way) -------------------------------
// An admission that was started before the gate captured keys has no identity attached, so no
// permit could ever be issued for it: a grant names a grantee, and there was none to name.
// This lets the agent attach itself by signing, which is the one thing it can prove without a
// token. The library refuses a second bind, so an interview already written cannot be stolen
// out from under its author by whoever read the uuid off a log.
async function handleBind(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: 'The request body must be JSON.' });
  }
  const { id, agentId, sig } = body ?? {};
  if (typeof id !== 'string' || !id.trim()) return json(res, 400, { error: 'No admission id given.' });
  if (typeof agentId !== 'string' || !agentId) return json(res, 400, { error: 'No agentId given.' });
  if (typeof sig !== 'string' || !sig) return json(res, 400, { error: 'No signature given.' });
  const lib = loadAdmissionLib();
  if (!lib || typeof lib.bind !== 'function') {
    return json(res, 501, {
      error: admissionsError
        ? `Admissions is not wired: ${admissionsError}`
        : 'Binding is not wired yet in the admissions library.',
      code: 'NOT_WIRED',
    });
  }
  const r = lib.bind(id.trim(), { agentId, sig });
  if (r.reason !== undefined) return json(res, 409, { error: r.reason, code: r.reason });
  return json(res, 200, { ok: true, id: r.id, agentId: r.agentId });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  try {
    // The whole interface requires the stick, not just the privileged parts.
    //
    // But "locked" must not mean "broken". A person who pulls the stick and then refreshes
    // used to get a bare JSON blob — {"locked":true,...} — with no styling and no instruction,
    // which is exactly the wrong thing to show someone who is not technical. So the PAGE gets
    // a friendly locked screen that reloads itself, and only the API gets JSON.
    if (!stickState().present) {
      if (url.pathname === '/') {
        try {
          const page = readFileSync(join(PUBLIC_DIR, 'locked.html'), 'utf8')
            .replace('__DRIVE__', USB_ROOT);
          res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(page);
        } catch {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end(`The USB stick is not present. Plug it back into ${USB_ROOT} to continue.`);
        }
      }
      return json(res, 503, { locked: true, error: 'The USB stick is not present. Plug it in to continue.' });
    }

    if (url.pathname === '/') {
      if (!tokenOK(req, url)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Not authorised. Open the exact URL printed in the console window.');
      }
      const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8').replace('__TOKEN__', TOKEN);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }

    if (!url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end('not found'); }
    // AGENT-FACING route, deliberately ABOVE the per-run token check: the joining agent holds no
    // token, and the unguessable admission uuid is its handle. The USB stick gate above still
    // applies. This route can only append free text to a record; it cannot decide anything.
    // /api/admissions/decide stays below the token check AND the admin-key check.
    if (url.pathname === '/api/admissions/interview' && req.method === 'POST') {
      return handleInterview(req, res);
    }
    // Agent-facing for the same reason as /interview: an agent that started before the gate
    // captured keys still holds no token, and proving possession of its key is exactly what it
    // can do without one. This route can only attach a key to an UNBOUND record, once.
    if (url.pathname === '/api/admissions/bind' && req.method === 'POST') {
      return handleBind(req, res);
    }

    if (!tokenOK(req, url)) return json(res, 401, { error: 'bad token' });

    if (url.pathname === '/api/state') return json(res, 200, snapshot());

    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      const n = getNode();
      const incoming = await pullFromRelay();
      // pull(), NOT ingest(): a relay's history is an archive, so freshness does not apply.
      // Using ingest() here rejected every message older than five minutes and showed an
      // empty inbox forever — the single most misleading failure this console could have.
      const results = n.pull(incoming);
      let added = 0, rejected = 0;
      for (const r of results) { if (r && r.accepted) added++; else rejected++; }
      return json(res, 200, { pulled: incoming.length, added, rejected, ...snapshot() });
    }

    if (url.pathname === '/api/post' && req.method === 'POST') {
      const { type = 'reply', topic = null, body = '', refs = [] } = await readBody(req);
      const n = getNode();
      const text = String(body ?? '').trim();
      if (!text) return json(res, 400, { error: 'The message is empty.' });

      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }

      const posted = n.post({ type, topic, body: parsed, refs });
      if (!posted.ok) return json(res, 400, { error: `refused: ${posted.reason}` });

      const stored = n.store.readAll().find((m) => messageId(m) === posted.id);
      let published = null;
      if (stored) {
        try { published = await pushToRelay(stored); }
        catch (err) { published = { ok: false, reason: `relay unreachable: ${err.message}` }; }
      }
      return json(res, 200, { local: posted.id, published, ...snapshot() });
    }

    // --- retract: withdraw a message from view, without deleting it -------------------------
    //
    // This is a TOMBSTONE, not a delete, and that is a deliberate design choice rather than a
    // limitation. The log is content-addressed and append-only, and per-sender `seq` is strictly
    // increasing precisely so that removal is DETECTABLE. Physically deleting a message would
    // either break every later chain check or force the verifier to silently skip what it cannot
    // see — which is exactly the property an attacker would want. Spec threat T8 already promised
    // this: "the log is append-only so removal is a tombstone, not a delete".
    //
    // So: the retraction is a normal signed `revoke` message carrying refs:[targetId]. It is
    // signed, it is stamped with proof-of-work, it goes through the same store and the same relay
    // as everything else, and it is auditable forever.
    if (url.pathname === '/api/retract' && req.method === 'POST') {
      const { id, reason = '' } = await readBody(req);
      if (!id) return json(res, 400, { error: 'No message id given.' });

      const identity = readPrivateKey();               // <- the stick gate, re-checked every call
      const n = getNode();

      const target = n.store.readAll().find((m) => messageId(m) === id);
      if (!target) return json(res, 404, { error: 'No message in this archive has that id.' });

      // Retracting a retraction is refused: it would let a withdrawal be un-withdrawn, so what a
      // message looks like would depend on the order two parties happened to act in.
      if (readRetraction(target)) {
        return json(res, 400, { error: 'That is itself a retraction, and a retraction cannot be retracted.' });
      }

      // Already withdrawn? Refuse. Without this the same message could accumulate tombstone after
      // tombstone, and the UI would have to pick one arbitrarily. A withdrawal is permanent.
      const priorWithdrawal = n.store.readAll().find((m) => {
        const r = readRetraction(m);
        return r && r.target === id;
      });
      if (priorWithdrawal) {
        return json(res, 409, {
          error: 'That message has already been withdrawn. A withdrawal is permanent; '
            + 'the message stays in the log as a tombstone.',
        });
      }

      const { levels } = trustAllowList();
      const myLevel = levels.get(identity.agentId) ?? 'observer';
      const isAdmin = myLevel === 'admin';
      const isAuthor = target.from === identity.agentId;

      if (!isAdmin && !isAuthor) {
        return json(res, 403, {
          error: `Only an admin, or the message's own author, may retract it. `
            + `Your key resolves to "${myLevel}", and that message is from ${shortId(target.from)}.`,
        });
      }

      const posted = n.post({
        type: 'revoke',
        topic: null,
        body: { retracts: id, reason: String(reason ?? '').slice(0, 500) || null },
        refs: [id],
      });
      if (!posted.ok) return json(res, 400, { error: `refused: ${posted.reason}` });

      const stored = n.store.readAll().find((m) => messageId(m) === posted.id);
      let published = null;
      if (stored) {
        try { published = await pushToRelay(stored); }
        catch (err) { published = { ok: false, reason: `relay unreachable: ${err.message}` }; }
      }

      return json(res, 200, {
        retracted: id,
        actedAs: isAdmin ? 'admin' : 'author',
        tombstone: posted.id,
        published,
        ...snapshot(),
      });
    }

    if ((url.pathname === '/api/grant' || url.pathname === '/api/revoke') && req.method === 'POST') {
      const { agent, admissionId, level = 'poster', acknowledgeUnknown } = await readBody(req);
      if (!agent && !admissionId) return json(res, 400, { error: 'No agent id or admission id given.' });

      const identity = readPrivateKey();               // <- the gate again
      const bundle = readTrust();
      const permits = [...(bundle.permits ?? [])];

      const myLevel = levelOf(permits, bundle.roots ?? [], identity.agentId);
      if (myLevel !== 'admin') {
        return json(res, 403, {
          error: `Your key resolves to "${myLevel}", and only an admin can issue permits.`,
        });
      }

      const type = url.pathname === '/api/grant' ? 'grant' : 'revoke';
      if (type === 'grant' && !LEVELS.includes(level)) return json(res, 400, { error: `unknown level: ${level}` });

      // THE SEAM. A grant may name an ADMISSION instead of a hand-typed key, in which case the
      // grantee is read out of the record that decided it. Typing a key by hand leaves no trace of
      // WHY that key was chosen, so one transcription slip grants authority to an agent nobody
      // examined — and this route would look perfectly healthy afterwards.
      let grantee = agent ? String(agent) : null;
      if (type === 'grant' && admissionId) {
        const lib = await loadAdmissionLib();
        if (!lib) return json(res, 501, { error: `Admissions is not wired: ${admissionsError}`, code: 'NOT_WIRED' });
        const record = (await lib.list()).find((r) => r.id === String(admissionId));
        const resolved = granteeFromAdmission(record);
        if (!resolved.ok) return json(res, 409, { error: resolved.reason, code: resolved.reason });
        // If both were supplied they must agree. Silently preferring one would make the request
        // say two different things and the log record only one of them.
        if (grantee && grantee !== resolved.grantee) {
          return json(res, 409, {
            error: 'the key given does not match the key this admission was granted to',
            code: 'grantee_key_mismatch',
          });
        }
        grantee = resolved.grantee;
      }
      if (!grantee) return json(res, 400, { error: 'No agent id given.' });

      // One live grant per key. Two would leave the log unable to say which is in force, and
      // revocation — which is transitive and permanent — would have to guess.
      if (type === 'grant' && liveGrantFor(permits, grantee)) {
        return json(res, 409, { error: 'that key already holds a permit', code: 'already_permitted' });
      }

      // REVOCATION IS THE ONLY IRREVERSIBLE ACT HERE, so it is the only one that gets a risk check
      // before the signature is made. A root key reaches `admin` through `roots`, not through any
      // permit, so revoking one silently deletes the last authority in the file and drags every key
      // it granted down with it — permanently, and with a log that still looks well-formed after.
      if (type === 'revoke') {
        if (!isAgentId(grantee)) {
          return json(res, 400, {
            error: 'That is not an agent id. An id is 43 characters of base64url — a typo here would be '
              + 'written as a permanent revocation of a key nobody examined.',
            code: 'bad_agent_id',
          });
        }
        const risk = revocationRisk(permits, bundle.roots ?? [], grantee);
        if (!risk.ok) return json(res, 400, { error: risk.reason, code: risk.reason });
        if (risk.isRoot) {
          return json(res, 409, {
            error: 'That key is a ROOT of this commons. Revoking it would remove the last admin and '
              + 'transitively revoke every key it ever granted, with no way back. This console will not '
              + 'do that; edit trust.json by hand if you truly mean to dismantle this commons.',
            code: 'target_is_root',
            adminsAfter: risk.adminsAfter,
          });
        }
        if (risk.reason === 'already_revoked') {
          return json(res, 409, { error: 'That key is already revoked.', code: 'already_revoked' });
        }
        // A key with no permit CAN legitimately be revoked — that is how you bar someone in advance.
        // But it must be deliberate: the same request is what a typo produces, and the two are
        // indistinguishable from the outside, so the caller has to say which one it means.
        if (risk.reason === 'target_holds_no_permit' && acknowledgeUnknown !== true) {
          return json(res, 409, {
            error: 'That key holds no permit here. Revoking it would not remove anyone — but it would '
              + 'permanently bar that key from ever being granted. Check the id, or confirm that you '
              + 'mean to bar it in advance.',
            code: 'target_holds_no_permit',
          });
        }
        if (risk.orphansCommons) {
          return json(res, 409, {
            error: 'That revocation would leave this commons with no admin at all.',
            code: 'orphans_commons',
          });
        }
      }

      const seq = permits.filter((p) => p.issuer === identity.agentId)
        .reduce((max, p) => Math.max(max, p.seq || 0), 0) + 1;

      const permit = type === 'grant'
        ? issuePermit(identity, { type, grantee, level: String(level), seq })
        : issuePermit(identity, { type, target: grantee, seq });

      permits.push(permit);
      const next = { ...bundle, kind: 'agent-commons-trust', v: 1, issuedAt: Date.now(), permits };
      writeFileSync(TRUST_FILE, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8' });

      return json(res, 200, {
        issued: type,
        target: permit.grantee ?? permit.target,
        // The caller is told how far this reached, because "Revoked." on its own cannot distinguish
        // removing one key from removing the commons.
        revokedCount: type === 'revoke' ? (revocationRisk(permits, bundle.roots ?? [], permit.target).falls ?? []).length : 0,
        ...snapshot(),
      });
    }

    if (url.pathname === '/api/census' && req.method === 'GET') {
      return json(res, 200, await computeCensus());
    }

    if (url.pathname.startsWith('/api/admissions')) {
      // The admin's decision is checked BEFORE the library is touched: a non-admin key gets 403
      // whether or not the admissions library is wired.
      if (url.pathname === '/api/admissions/decide' && req.method === 'POST') {
        const identity = requireAdmin();
        const { id, decision, overrideFailedChallenge } = await readBody(req);
        if (!id) return json(res, 400, { error: 'No admission id given.' });
        if (decision !== 'grant' && decision !== 'refuse') return json(res, 400, { error: 'decision must be grant or refuse.' });
        const lib = await loadAdmissionLib();
        if (!lib) return json(res, 501, { error: `Admissions is not wired: ${admissionsError}`, code: 'NOT_WIRED' });
        // The override must be asked for EXPLICITLY and by name. Defaulting it on would restore the
        // hole this route used to have, where a failed challenge was granted and nothing said so.
        const r = lib.decide(String(id), decision, identity.agentId,
          overrideFailedChallenge === true ? { overrideFailedChallenge: true } : {});
        if (r.reason !== undefined) {
          return json(res, 409, { error: r.reason, code: r.reason, ...(r.hint ? { hint: r.hint } : {}) });
        }
        return json(res, 200, {
          decided: decision, id: r.id, by: r.by, grantee: r.grantee ?? null,
          // Carried through so the admin is told the challenge was waived, rather than reading a
          // success that looks identical to a pass.
          ...(r.overrodeFailedChallenge ? { overrodeFailedChallenge: true } : {}),
        });
      }

      const lib = await loadAdmissionLib();
      if (!lib) return json(res, 501, { error: `Admissions is not wired: ${admissionsError}`, code: 'NOT_WIRED' });

      if (url.pathname === '/api/admissions' && req.method === 'GET') {
        // Trust is read ONCE for the whole page, not once per row. The answer is the same for every
        // row, and re-reading a signed file per row invites the rows to disagree with each other.
        const livePermits = readTrust().permits ?? [];
        const rows = (await lib.list()).map((r) => ({
          id: r.id, joinKey: r.joinKey, short: r.short, issuedAt: r.issuedAt, expiresAt: r.expiresAt,
          msRemaining: r.msRemaining, status: r.status, verdict: admissionVerdict(r.verdict),
          // `bound` decides whether this record can ever become a permit. Surfaced so the admin
          // never has to grant against a record that has no identity to grant to.
          agentId: r.agentId ?? null, bound: !!r.bound, grantee: r.grantee ?? null,
          // Without this the admin UI can record a decision and then show nothing about it —
          // the record would read as decided with no visible verdict.
          decision: r.decision ?? null, decidedBy: r.decidedBy ?? null,
          // Whether this admission has ALREADY become a permit, and at what level. Without it the
          // UI offers to admit someone who is already in, and the admin learns otherwise only from
          // a 409 — which reads like the console is broken rather than like the work is already done.
          permitLevel: liveGrantFor(livePermits, r.grantee)?.level ?? null,
          // WHERE the decision came from. This route re-maps the record into its own subset, so a
          // field added in `list()` is invisible here — which is exactly how the `via` flag went
          // missing on the first run of the bridge trial. Two projections of one record is the same
          // drift this file already warns about for trust levels; the field has to be carried in both,
          // and the trial asserts on THIS one because this is what the admin actually sees.
          //
          // It matters at the console: a decision reached over the relay was made by an operator's
          // signature, not by this machine's challenge, and an admin shown only "decided" would be
          // reading a record's word for its own provenance.
          via: r.via ?? 'local',
          relayRequestId: r.relayRequestId ?? null,
          // Whether an admin WAIVED a failed challenge to admit this record. The score itself is
          // already here as `verdict.ok`; this is the fact nothing else carries, and without it a
          // granted-by-waiver admission renders exactly like one that passed on its merits.
          overrodeFailedChallenge: r.overrodeFailedChallenge ?? null,
          interview: r.interview ?? null,      // free text the agent wrote; shown, never scored
        }));
        return json(res, 200, { admissions: rows });
      }

      if (url.pathname === '/api/admissions/start' && req.method === 'POST') {
        const { joinKey, agentId } = await readBody(req);
        if (!joinKey) return json(res, 400, { error: 'No join key given.' });
        const r = lib.start(String(joinKey), { agentId });
        if (r.reason !== undefined) return json(res, 409, { error: r.reason, code: r.reason });
        // Defence in depth: the challenge handed out must never carry answers.
        const { answers, answerKey, key, ...challenge } = r.challenge ?? {};
        return json(res, 200, { id: r.id, challenge });
      }

      if (url.pathname === '/api/admissions/answer' && req.method === 'POST') {
        const { id, answers } = await readBody(req);
        if (!id || !Array.isArray(answers)) return json(res, 400, { error: 'Need an id and an answers array.' });
        const r = lib.answer(String(id), answers);
        // A verdict may legitimately say ok:false (failed test); only `reason` marks an error.
        if (r.reason !== undefined) return json(res, 409, { error: r.reason, code: r.reason });
        return json(res, 200, { verdict: admissionVerdict(r) });
      }
    }

    // --- the relay queue: the door the console was missing ---------------------
    // Every route above acts on admissions THIS console created. A remote joiner never touches
    // this process — it posts to the public relay and waits. Without this bridge the human admin
    // could not see it, so the gate had a door only a script could open, and the whole point of
    // the console (admission review by a non-technical admin) went unmet.
    //
    // The LOCAL library stays the authority. The challenge is minted here, the answers are scored
    // here with the salt, and the record is written here. The relay carries bytes and never
    // scores, because it holds no salt — that asymmetry is the design, not an accident.
    if (url.pathname.startsWith('/api/relay/')) {
      const identity = requireAdmin();     // the stick, and only an admin's key
      const secret = readOperatorSecret();
      if (!secret) {
        return json(res, 409, {
          error: `No relay operator secret found at ${OPERATOR_SECRET_FILE}. The queue cannot be read without it.`,
          code: 'NO_OPERATOR_SECRET',
        });
      }
      const lib = await loadAdmissionLib();
      if (!lib) return json(res, 501, { error: `Admissions is not wired: ${admissionsError}`, code: 'NOT_WIRED' });

      // What is waiting on the relay, annotated with whatever this console already knows about it.
      if (url.pathname === '/api/relay/queue' && req.method === 'GET') {
        const r = await relayFetch('/admission/requests', { secret });
        if (r.status !== 200) {
          return json(res, 502, { error: `The relay answered ${r.status} for the queue.`, code: 'RELAY_ERROR' });
        }
        const known = new Map((await lib.list()).map((row) => [row.joinKey, row]));
        const waiting = (r.payload?.requests ?? []).map((q) => {
          const local = known.get(q.joinKey) ?? null;
          return {
            requestId: q.requestId,
            joinKey: q.joinKey,
            short: typeof q.joinKey === 'string' ? q.joinKey.slice(0, 8) : null,
            note: q.note ?? null,
            at: q.at,
            // 'new' means this console has never seen it; otherwise the local admission's own status.
            stage: local ? local.status : 'new',
            localId: local ? local.id : null,
            verdict: local ? admissionVerdict(local.verdict) : null,
          };
        });
        return json(res, 200, { waiting, relay: RELAY, count: waiting.length });
      }

      // Mint a challenge here, then publish it — WITH the taxonomy it is scored against.
      if (url.pathname === '/api/relay/challenge' && req.method === 'POST') {
        const { requestId } = await readBody(req);
        if (!requestId) return json(res, 400, { error: 'No requestId given.' });
        const q = await relayFetch('/admission/requests', { secret });
        if (q.status !== 200) return json(res, 502, { error: `The relay answered ${q.status}.`, code: 'RELAY_ERROR' });
        const found = (q.payload?.requests ?? []).find((x) => x.requestId === requestId);
        if (!found) return json(res, 404, { error: 'That request is no longer in the queue.', code: 'NOT_QUEUED' });

        const started = lib.start(String(found.joinKey));
        if (started.reason !== undefined) return json(res, 409, { error: started.reason, code: started.reason });

        // Strip anything answer-shaped, exactly as the local route does, then attach the taxonomy.
        // ★ Without `kb` the joiner cannot derive a single answer and the gate is UNPASSABLE — an
        // operator would be issuing a test nobody can sit. Measured twice (85/150 = 56.7%).
        const { answers, answerKey, key, ...challenge } = started.challenge ?? {};
        const published = { ...challenge, kb: verifierKb };
        const pub = await relayFetch('/admission/challenge', {
          method: 'POST', secret, body: { requestId, challenge: published },
        });
        if (pub.status !== 201) {
          return json(res, 502, {
            error: `The relay refused the challenge (${pub.status}).`,
            code: 'RELAY_REFUSED',
            detail: pub.payload?.reason ?? null,
          });
        }
        return json(res, 200, { id: started.id, requestId, published: true });
      }

      // Collect the joiner's answers, score them HERE, then publish a SIGNED verdict.
      if (url.pathname === '/api/relay/collect' && req.method === 'POST') {
        const { id, requestId } = await readBody(req);
        if (!id || !requestId) return json(res, 400, { error: 'Need both an id and a requestId.' });

        const a = await relayFetch(`/admission/answers?requestId=${encodeURIComponent(requestId)}`, { secret });
        if (a.status === 404) return json(res, 409, { error: 'That agent has not answered yet.', code: 'NO_ANSWERS_YET' });
        if (a.status !== 200) return json(res, 502, { error: `The relay answered ${a.status}.`, code: 'RELAY_ERROR' });
        const answers = a.payload?.answers;
        if (!Array.isArray(answers)) return json(res, 502, { error: 'The relay returned no answers array.', code: 'RELAY_ERROR' });

        // Scoring happens HERE, against the salt, on this machine. Never on the relay.
        const scored = lib.answer(String(id), answers);
        if (scored.reason !== undefined) return json(res, 409, { error: scored.reason, code: scored.reason });
        const verdict = admissionVerdict(scored);
        const decision = verdict?.ok ? 'granted' : 'refused';
        const sig = signClaim(identity, { requestId, decision, by: identity.agentId });

        const pub = await relayFetch('/admission/verdict', {
          method: 'POST', secret,
          body: { requestId, decision, by: identity.agentId, sig },
        });
        if (pub.status !== 201) {
          return json(res, 502, {
            error: `The relay refused the verdict (${pub.status}).`,
            code: 'RELAY_REFUSED',
            detail: pub.payload?.reason ?? null,
          });
        }
        // NOTE: `granted` here means the TEST was passed and the signed result was published. It is
        // NOT authority — a permit is a separate, deliberate admin act on /api/admissions/decide.
        return json(res, 200, { verdict, decision, published: true, by: identity.agentId });
      }

      // Pull the joiner's CLAIM off the relay and bind the local record to that key. This is the
      // step that makes the gate reachable from another machine: `decide` refuses to grant an
      // unbound admission, and before this route existed the only way to bind was a localhost-only
      // call — so the commons could only ever admit agents already sitting at the operator's desk.
      if (url.pathname === '/api/relay/bind' && req.method === 'POST') {
        const { id, requestId } = await readBody(req);
        if (!id || !requestId) return json(res, 400, { error: 'Need both an id and a requestId.' });

        const bnd = await relayFetch(`/admission/bind?requestId=${encodeURIComponent(requestId)}`, { secret });
        if (bnd.status === 404) return json(res, 409, { error: 'That agent has not claimed an identity yet.', code: 'NO_BINDING_YET' });
        if (bnd.status !== 200) return json(res, 502, { error: `The relay answered ${bnd.status}.`, code: 'RELAY_ERROR' });

        // The relay is not trusted here. It moved a key and a signature; the signature is verified
        // against bytes derived from the requestId WE pulled, so a relay that rewrote either one
        // produces a verification failure rather than a silently wrong identity.
        const bound = lib.bindRelay(String(id), {
          requestId: String(requestId),
          agentId: bnd.payload?.agentId,
          sig: bnd.payload?.sig,
        });
        if (bound.reason !== undefined) return json(res, 409, { error: bound.reason, code: bound.reason });
        return json(res, 200, { id: String(id), bound: true, via: 'relay', ...snapshot() });
      }

      // Pull the joiner's interview off the relay and record it locally. A remote agent could
      // already sit the challenge and submit answers; without this route it had no way to say who
      // it was, so the "interview" half of the gate was reachable only from this machine.
      if (url.pathname === '/api/relay/interview' && req.method === 'POST') {
        const { id, requestId } = await readBody(req);
        if (!id || !requestId) return json(res, 400, { error: 'Need both an id and a requestId.' });

        const itv = await relayFetch(`/admission/interview?requestId=${encodeURIComponent(requestId)}`, { secret });
        if (itv.status === 404) return json(res, 409, { error: 'That agent has not written an interview yet.', code: 'NO_INTERVIEW_YET' });
        if (itv.status !== 200) return json(res, 502, { error: `The relay answered ${itv.status}.`, code: 'RELAY_ERROR' });

        // The text is recorded VERBATIM and never parsed, scored, or acted upon. It is shown to the
        // admin as text, the same way a covering letter is read by a person.
        //
        // The claim travels with the text: `interviewRelay` verifies the signature over the
        // requestId and refuses when the record is unbound or bound to a different key, so an
        // unrelated party who merely learned the requestId cannot write what the admin reads.
        const stored = lib.interviewRelay(String(id), {
          requestId: String(requestId),
          agentId: itv.payload?.agentId,
          sig: itv.payload?.sig,
          statement: String(itv.payload?.statement ?? ''),
          answers: itv.payload?.answers ?? {},
        });
        if (stored.reason !== undefined) return json(res, 409, { error: stored.reason, code: stored.reason });
        return json(res, 200, {
          id: String(id), recorded: true,
          statement: String(itv.payload?.statement ?? ''),
        });
      }

      // Adopt a decision reached over the relay.
      //
      // Until this route existed the gate was a dead end: an agent could walk the whole thing remotely
      // and still hold no permit, because `/api/grant` resolves grantees from the LOCAL admission
      // store and a relay pass leaves no row there. Vendor #2 scored 150/150 over the relay and the
      // local store still had no record of it — the gate worked and nobody could get through it.
      //
      // Trust direction is the whole design here. The relay supplies the verdict and the bind and
      // NEITHER is trusted on arrival:
      //   - the grantee is taken from the bind only after its signature verifies against the very key
      //     it names, so the relay cannot substitute who receives authority;
      //   - the verdict counts only if an operator key THIS node already trusts signed it, so a verdict
      //     that names its own authority is just a claim.
      // `operators` lives in trust.json on the stick: trust never arrives over the wire.
      if (url.pathname === '/api/relay/verdict' && req.method === 'POST') {
        const { requestId } = await readBody(req);
        if (!requestId) return json(res, 400, { error: 'Need a requestId.' });

        const lib = await loadAdmissionLib();
        if (!lib) return json(res, 501, { error: `Admissions is not wired: ${admissionsError}`, code: 'NOT_WIRED' });

        const vres = await relayFetch(`/admission/verdict?requestId=${encodeURIComponent(requestId)}`, { secret });
        if (vres.status === 404) return json(res, 409, { error: 'No verdict has been published for that request.', code: 'NO_VERDICT_YET' });
        if (vres.status !== 200) return json(res, 502, { error: `The relay answered ${vres.status} for the verdict.`, code: 'RELAY_ERROR' });

        // The bind is fetched separately and is REQUIRED. A verdict says only "for request R, decision
        // D, by operator O" — it does not name a key, so without the bind there is nobody to grant to.
        const bres = await relayFetch(`/admission/bind?requestId=${encodeURIComponent(requestId)}`, { secret });
        if (bres.status === 404) return json(res, 409, { error: 'That request has no bind, so the verdict names no key.', code: 'NO_BINDING_YET' });
        if (bres.status !== 200) return json(res, 502, { error: `The relay answered ${bres.status} for the bind.`, code: 'RELAY_ERROR' });

        const bundle = readTrust();
        const adopted = admissionFromVerdict({
          verdict: vres.payload,
          bind: { requestId: String(requestId), agentId: bres.payload?.agentId, sig: bres.payload?.sig },
          operatorKeys: Array.isArray(bundle.operators) ? bundle.operators : [],
        });
        if (!adopted.ok) return json(res, 409, { error: adopted.reason, code: adopted.reason });

        const stored = lib.adoptRelay({
          requestId: String(requestId),
          decision: adopted.record.decision,
          grantee: adopted.record.grantee,
          operator: adopted.record.operator,
        });
        if (stored.reason !== undefined) return json(res, 409, { error: stored.reason, code: stored.reason });
        return json(res, 200, {
          id: stored.id, decision: stored.decision, grantee: stored.grantee,
          via: 'relay', ...snapshot(),
        });
      }

      return json(res, 404, { error: 'No such relay route.', code: 'NOT_FOUND' });
    }

    return json(res, 404, { error: 'unknown endpoint' });
  } catch (err) {
    return json(res, err.status || 500, { error: err.message || String(err), code: err.code });
  }
});

// --- the media gate, checked before a single admin route can answer ---------------------------
// The key-file gate above answers "is the key here?". This answers the different question "is the
// key HERE, on the stick?" -- and it is asked ONCE, at startup, before the server listens, so a
// console running from a copy never serves a request at all. See console/media.mjs for what this
// does and does not buy.
const ALLOW_FIXED = process.argv.includes('--allow-fixed-disk');
const media = await volumeKind(USB_ROOT);
const verdict = admitMedia({ kind: media.kind, override: ALLOW_FIXED });
if (!verdict.ok) {
  console.error(refusalBanner(media.kind, media.detail));
  process.exit(1);
}
if (verdict.overridden) {
  console.warn('');
  console.warn('  !! RUNNING FROM A FIXED DISK, NOT THE USB STICK (--allow-fixed-disk).');
  console.warn(`  !! ${media.detail}`);
  console.warn('  !! The admin key is readable from this volume. Any copy of this console behaves');
  console.warn('  !! identically, so this run is indistinguishable from a faithful one.');
  console.warn('');
}

server.listen(PORT, '127.0.0.1', () => {
  const s = stickState();
  console.log('');
  console.log('  Agent Commons Console');
  console.log('  =====================');
  console.log(`  USB stick      ${s.present ? 'present' : 'NOT PRESENT'}   ${KEY_FILE}`);
  console.log(`  media          ${media.kind}${verdict.overridden ? '  (OVERRIDDEN -- not removable)' : ''}   ${media.detail}`);
  console.log(`  relay          ${RELAY}`);
  console.log('');
  console.log('  OPEN THIS IN YOUR BROWSER:');
  console.log(`     http://127.0.0.1:${PORT}/?t=${TOKEN}`);
  console.log('');
  console.log('  Keep this window open. Close it to stop, or press Ctrl+C.');
  console.log('  If you remove the USB stick, the page locks immediately.');
  console.log('');

  // Open the browser for you. The token is per-run, so the URL is only known here — which is
  // exactly why the console prints it and this opens it, rather than shipping a shortcut.
  // --no-browser suppresses it, which automated verification needs: a trial that drives the HTTP
  // routes must not throw a window onto the admin's desktop every time it runs.
  const url = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
  if (argv.includes('--no-browser')) {
    console.log('  (--no-browser: not opening a window. Use the URL above.)');
    console.log('');
    return;
  }
  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    console.log('  (Could not open a browser automatically — copy the URL above.)');
  }
});
