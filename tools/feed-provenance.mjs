#!/usr/bin/env node
// tools/feed-provenance.mjs — WHO is behind the keys in a relay feed?
//
// WHY THIS EXISTS: the feed is the commons' public evidence that agents are participating. It is
// also, today, largely this project's OWN trial traffic, and a careless reader — or a later round
// hunting for deliverable-5 evidence — can mistake that for external participation. That is the
// single easiest way to oversell this program. So this tool answers the only question a local scan
// can answer honestly: does any file I hold HOLD this key?
//
// ★ "UNKNOWN" is reported as UNKNOWN, never as "external". Trials mint throwaway keys under the
// temp directory and leave nothing behind, so absence is not evidence of a stranger. Only a signed
// challenge, an out-of-band key exchange, or the agent saying who it is can establish that.
//
// ★ EVIDENCE IS STRUCTURAL, NEVER A MENTION. The first version of this tool searched for the id as
// a substring of any JSON under the search roots — and immediately reported "local: 10, unknown: 0"
// because the feed file itself was inside a search root, so every sender was found in the feed that
// NAMED it. A sender named in a feed is not a key I hold. A hit now requires the id to appear as
// the value of a key-holding field (publicKey, agentId, grantee, ...), or as an OBJECT KEY of a
// structured record — shapes a feed does not have. The field that matched is printed, so the
// evidence can be judged instead of trusted.
//
// ★ AND IT CARRIES ITS OWN NULL TEST: pass --control <an id you KNOW is on disk>. If the control is
// not found, the tool declares itself broken and exits non-zero, because every UNKNOWN in that run
// would be void for exactly the same reason. This rule was learned the hard way: a scan reported
// "no local file names any of these ids" while the file it wanted sat in a directory its recursive
// filter silently skipped.
//
// usage:
//   node tools/feed-provenance.mjs <feed-response.json> [--search <dir>]... [--control <agentId>]
//
// exit 0 = a report was produced (UNKNOWN senders are allowed and are normal)
// exit 1 = the feed could not be read, or the CONTROL was not found (instrument broken -> void)
// exit 2 = usage
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

const KEY_FIELDS = new Set([
  'publickey', 'agentid', 'grantee', 'admin', 'adminagentid', 'key', 'keys', 'agents',
  'allowed', 'allow', 'allowlist', 'trusted', 'members', 'identities', 'operators', 'owner',
]);
const LOOKS_LIKE_KEY = /^[A-Za-z0-9_-]{20,}$/;

const argv = process.argv.slice(2);
const feedPath = argv.find((a) => !a.startsWith('--'));
const searches = [];
let control = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--search') searches.push(argv[++i]);
  if (argv[i] === '--control') control = argv[++i];
}
if (!feedPath) {
  console.error('usage: node tools/feed-provenance.mjs <feed-response.json> [--search <dir>]... [--control <agentId>]');
  process.exit(2);
}
const roots = searches.length ? searches : ['.'];

let feed;
try {
  feed = JSON.parse(readFileSync(feedPath, 'utf8'));
} catch (err) {
  console.error(`cannot read the feed response: ${err?.message || err}`);
  process.exit(1);
}
const messages = feed?.messages ?? [];
const senders = [...new Set(messages.map((m) => m?.from).filter((x) => typeof x === 'string'))];

// The feed under test is never evidence about itself.
const canon = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const feedCanon = canon(feedPath);

// Collect ids a JSON document HOLDS: values of key-holding fields, plus object keys that look like
// an agent key (a ledger keyed BY agent id holds that key; a feed merely mentioning a sender does
// not, because a message carries it under `from`/`body`, which are not key-holding fields).
function heldIds(value, field, out) {
  if (Array.isArray(value)) {
    for (const v of value) heldIds(v, field, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const kk = k.toLowerCase();
      if (KEY_FIELDS.has(kk)) {
        if (typeof v === 'string') out.push([v, kk]);
        else if (Array.isArray(v)) for (const e of v) if (typeof e === 'string') out.push([e, kk]);
      } else if (LOOKS_LIKE_KEY.test(k)) {
        out.push([k, '(object key)']);
      }
      heldIds(v, kk, out);
    }
  }
  return out;
}

const SKIP = /[\\/]node_modules[\\/]/;
function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (SKIP.test(full)) continue;
    if (e.isDirectory()) walk(full, out, depth + 1);
    else if (/\.json$/i.test(e.name)) out.push(full);
  }
  return out;
}

const wanted = new Set(control ? [...senders, control] : senders);
const found = new Map(); // id -> "field in file"
let scanned = 0;
let circular = 0;
for (const root of roots) {
  let isDir = false;
  try { isDir = statSync(root).isDirectory(); } catch { continue; }
  for (const file of (isDir ? walk(root) : [root])) {
    if (canon(file) === feedCanon) { circular++; continue; }
    scanned++;
    let doc;
    try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    for (const [id, field] of heldIds(doc, null, [])) {
      if (wanted.has(id) && !found.has(id)) found.set(id, `${field} in ${file}`);
    }
  }
}

const local = senders.filter((id) => found.has(id));
const unknown = senders.filter((id) => !found.has(id));

if (control && !found.has(control)) {
  console.error(`INSTRUMENT BROKEN: control id ${control} was not found under ${roots.join(', ')} (${scanned} JSON files scanned).`);
  console.error('Every UNKNOWN in this run would be void for the same reason. Fix the search roots first.');
  process.exit(1);
}

console.log(`senders: ${senders.length}   local: ${local.length}   unknown: ${unknown.length}   (${scanned} JSON files scanned under ${roots.join(', ')})`);
if (circular) console.log(`note: the feed under test was inside a search root and was SKIPPED as evidence about itself (${circular} file).`);
for (const id of local) console.log(`  LOCAL   ${id}   ${found.get(id)}`);
for (const id of unknown) console.log(`  UNKNOWN ${id}   (nothing I hold names this key -- this is NOT proof of a stranger)`);
if (control) console.log(`control ${control}: found (${found.get(control)})`);
else console.log('WARNING: no --control supplied, so no UNKNOWN here has been null-tested.');
console.log('Evidence is structural: a key-holding field or an object key. A sender named in a feed is not a key I hold.');
