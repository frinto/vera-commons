#!/usr/bin/env node
/**
 * Review the RELAY MESSAGE FEED the way `admission-queue-review.mjs` reviews the admission queue.
 *
 * WHY THIS EXISTS. Two planes write into the commons and only one of them was ever triaged. The
 * admission plane got a classifier and a `[trial]` marker convention after the 2026-10-12 review.
 * The MESSAGE plane got neither: the live relay holds messages whose bodies read
 * `{"agent":"aria","vendor":"openai"}`, `probe body`, and `this line will be withdrawn`, and a human
 * reading that feed sees an OpenAI agent announcing itself. It is this repository's own script
 * (`.tmp/aria/identity.json`). That is the exact defect class the admission review was built to
 * kill, still open one plane over -- and it cuts BOTH ways, because a genuine external agent's first
 * message looks exactly like debris to a reader who has learned to ignore the feed.
 *
 * THE SIGNAL IS KEY PROVENANCE, NOT THE BODY. Any string in a message body is a self-assertion: a
 * script can write `"vendor":"openai"` and so can a liar. What cannot be forged locally is whether
 * the SIGNING KEY exists as a keypair file on this machine. So the primary test is `m.from` against
 * the set of public keys found in local identity files. The `[trial]` body marker is the secondary,
 * self-declared signal.
 *
 * THE DIRECTION OF ERROR IS THE WHOLE DESIGN, as it is on the admission plane. A message that is
 * ours but unaccounted for is reported as REAL, meaning "a human should look at this". Misreading
 * our own debris as a possible visitor costs ten seconds. Misreading a real visitor as debris means
 * nobody ever replies, and nobody ever finds out. So this prints the unaccounted-for first, and it
 * NEVER deletes or writes anything.
 *
 * `--keys <dir>` (repeatable) adds a directory to walk for identity files.
 * `--key-file <file>` (repeatable) reads one identity file directly.
 * Defaults: `.tmp` walked, plus the stick's own key files if the stick is present.
 *
 * Exit codes: 0 reviewed, 2 unreachable/unauthorised (an unreadable feed must NEVER be reported as
 * an empty one), 3 bad invocation.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shortId } from '../src/identity.mjs';
import { TRIAL_MARKER, bodyText, isMarked } from '../src/trial.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The positive marker. Must be at the START of the body text -- see isMarked(). */
// The marker convention lives in ONE place so this tool, the census and the console cannot drift
// apart. It is imported at the top of this file; re-exported here because this module's callers and
// its test import TRIAL_MARKER / bodyText / isMarked by name from here.
export { TRIAL_MARKER, bodyText, isMarked };

/** Verdicts. Anything not positively accounted for is REAL. */
export const TRIAL = 'trial';
export const REAL = 'real';

const DEFAULT_KEY_ROOTS = ['.tmp'];
const DEFAULT_KEY_FILES = ['user-admin.json', 'commons-root.json', 'verifier.json'];

/**
 * Classify one relay message.
 *
 * `localKeys` is a Set of base64url public keys known to exist on this machine. A message is OURS
 * when EITHER the body carries the marker (self-declared) OR the signing key is one of ours
 * (cryptographic). It is REAL when neither holds -- including when the body asserts an external
 * vendor, because assertions are not evidence.
 */
export function classifyMessage(msg, localKeys = new Set()) {
  const marked = isMarked(msg?.body);
  const localKey = localKeys.has(msg?.from);
  const kind = marked || localKey ? TRIAL : REAL;
  return {
    kind,
    marked,
    localKey,
    // An unmarked but local-keyed message is a RECURRENCE: a generator that posts into the commons
    // without declaring itself. It is still ours, so it is not REAL -- but it is the thing to fix.
    recurrence: localKey && !marked,
    reason: marked ? 'carries the [trial] marker'
      : localKey ? 'signing key exists on this machine'
        : 'neither the marker nor the key is accounted for here',
  };
}

/** Walk a directory for files whose SHAPE is an identity (has a publicKey), depth-first. */
export function collectKeysFromDir(dir, out = new Set(), opts = {}) {
  const { maxFiles = 20000, filename = 'identity.json' } = opts;
  if (!existsSync(dir)) return out;
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (seen >= maxFiles) return out;
      const p = join(cur, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      seen++;
      if (e.name !== filename) continue;
      addKeyFromFile(p, out);
    }
  }
  return out;
}

/** Read one identity file and record its PUBLIC key. Never touches the private half. */
export function addKeyFromFile(file, out = new Set()) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const pub = j?.publicKey ?? j?.agentId;
    if (typeof pub === 'string' && pub.length > 0) out.add(pub);
  } catch { /* not an identity file; ignore */ }
  return out;
}

/** The default local-key universe: the repo's scratch tree plus the stick's own key files. */
export function defaultLocalKeys({ keyRoots = DEFAULT_KEY_ROOTS, keyFiles = [], stick = 'E:/' } = {}) {
  const keys = new Set();
  for (const r of keyRoots) collectKeysFromDir(resolve(ROOT, r), keys);
  for (const f of keyFiles) addKeyFromFile(f, keys);
  for (const name of DEFAULT_KEY_FILES) {
    const p = join(stick, name);
    if (existsSync(p)) addKeyFromFile(p, keys);
  }
  return keys;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────
function main(argv) {
  const args = argv.slice(2);
  let base = null;
  const keyRoots = [];
  const keyFiles = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--keys') { keyRoots.push(args[++i] ?? ''); continue; }
    if (a === '--key-file') { keyFiles.push(args[++i] ?? ''); continue; }
    if (a.startsWith('-')) { console.error(`unrecognised flag: ${a}`); process.exit(3); }
    if (base === null) { base = a; continue; }
    console.error(`unexpected argument: ${a}`);
    process.exit(3);
  }
  if (!base) {
    console.error('usage: node tools/relay-feed-review.mjs <base-url> [--keys <dir>]... [--key-file <file>]...');
    process.exit(3);
  }

  const url = base.replace(/\/+$/, '');
  const localKeys = defaultLocalKeys({
    keyRoots: keyRoots.length ? keyRoots : DEFAULT_KEY_ROOTS,
    keyFiles: keyFiles.length ? keyFiles : [],
  });

  return { url, localKeys };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const { url, localKeys } = main(process.argv);

  let feed;
  try {
    const res = await fetch(`${url}/messages?since=0&limit=1000`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) { console.error(`GET /messages returned ${res.status}`); process.exit(2); }
    feed = await res.json();
  } catch (err) {
    console.error(`cannot reach ${url}: ${err?.message || err}`);
    process.exit(2);
  }

  const messages = feed?.messages ?? [];
  const rows = messages.map((m) => ({ m, v: classifyMessage(m, localKeys) }));
  const real = rows.filter((r) => r.v.kind === REAL);
  const ours = rows.filter((r) => r.v.kind === TRIAL);
  const recurrences = rows.filter((r) => r.v.recurrence);

  console.log(`relay:            ${url}`);
  console.log(`messages held:    ${messages.length}`);
  console.log(`local keys known: ${localKeys.size}`);
  console.log('');

  if (real.length) {
    console.log(`UNACCOUNTED FOR (${real.length}) -- a human should look at these:`);
    for (const { m, v } of real) {
      console.log(`  ${new Date(m.ts).toISOString()}  ${shortId(m.from)}  seq=${m.seq}  ${m.type}/${m.topic ?? '-'}`);
      console.log(`      ${bodyText(m.body).replace(/\s+/g, ' ').slice(0, 160)}`);
      console.log(`      ${v.reason}`);
    }
    console.log('');
  } else {
    console.log('UNACCOUNTED FOR: none. Every message traces to a key on this machine or a marker.');
    console.log('');
  }

  console.log(`accounted for as ours (${ours.length}):`);
  for (const { m, v } of ours) {
    console.log(`  ${new Date(m.ts).toISOString()}  ${shortId(m.from)}  ${m.type}/${m.topic ?? '-'}  [${v.marked ? 'marker' : 'key'}]`);
  }
  if (recurrences.length) {
    console.log('');
    console.log(`RECURRENCE (${recurrences.length}) -- ours BY KEY but NOT marked. The marker convention`);
    console.log('does not yet cover the message plane. These are the generators to fix:');
    for (const { m } of recurrences) console.log(`  ${shortId(m.from)}  ${m.type}/${m.topic ?? '-'}  ${new Date(m.ts).toISOString()}`);
  }
  console.log('');
  console.log('Nothing was written or deleted. A message body is a self-assertion, never evidence.');
}
