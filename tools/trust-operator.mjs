// TRUST-OPERATOR — manage the relay-operator keys that a node will accept verdicts from.
//
// WHY THIS EXISTS. `admissionFromVerdict` refuses any verdict whose signer is not in
// `trust.json.operators`. The live stick was measured with `operators: []`, which means the whole
// relay → permit bridge was unreachable on the real deployment while looking perfectly healthy in
// tests — the bridge trial passed because it WROTE an operator into its own temp copy of trust.json.
// A test that configures the thing under test cannot report on the thing as deployed.
//
// Operators are part of the TRUST ANCHOR, so this tool is deliberately loud and reversible:
//   - it never edits in place without first writing a timestamped backup beside the file,
//   - it prints the sha256 before and after, so a third party can confirm what changed,
//   - adding an operator that is already present is a no-op that says so, and
//   - it refuses to touch a file it cannot parse as a trust document.
//
// Usage:
//   node tools/trust-operator.mjs list   --trust <trust.json>
//   node tools/trust-operator.mjs add    --trust <trust.json> (--key <operator-key.json> | --pub <b64u>)
//   node tools/trust-operator.mjs remove --trust <trust.json>  --pub <b64u>
//
// Zero npm dependencies.
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import crypto from 'node:crypto';
import { isAgentId } from '../src/admission.mjs';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

const CMD = process.argv[2];
const TRUST = arg('trust', 'E:\\trust.json');
const KEY_FILE = arg('key', null);
const PUB = arg('pub', null);

const sha = (p) => crypto.createHash('sha256').update(readFileSync(p)).digest('hex');
function die(msg, code = 1) { console.error(msg); process.exit(code); }

if (!['list', 'add', 'remove'].includes(CMD)) {
  die('usage: trust-operator.mjs <list|add|remove> --trust <trust.json> [--key <f> | --pub <b64u>]');
}
if (!existsSync(resolve(String(TRUST)))) die(`no trust file at ${resolve(String(TRUST))}`);
const TRUST_PATH = resolve(String(TRUST));

let doc;
try { doc = JSON.parse(readFileSync(TRUST_PATH, 'utf8')); }
catch (e) { die(`${TRUST_PATH} is not valid JSON: ${e.message}`); }
// A trust document without these is not one, and guessing would be the worst outcome here.
if (!Array.isArray(doc.permits) || !Array.isArray(doc.roots)) {
  die(`${TRUST_PATH} does not look like a trust document (needs permits[] and roots[])`);
}
if (!Array.isArray(doc.operators)) {
  console.log(`note: ${TRUST_PATH} has no operators[] array; treating it as empty.`);
  doc.operators = [];
}

const show = (label) => {
  console.log(`${label}`);
  console.log(`  roots     : ${doc.roots.length}  ${doc.roots.map((r) => String(r).slice(0, 12) + '...').join(' ') || '(none)'}`);
  console.log(`  permits   : ${doc.permits.length}`);
  console.log(`  operators : ${doc.operators.length}`);
  for (const o of doc.operators) console.log(`      ${o}${o === PUB ? '   <- this one' : ''}`);
};

if (CMD === 'list') {
  console.log(`trust file: ${TRUST_PATH}`);
  console.log(`sha256    : ${sha(TRUST_PATH)}`);
  show('');
  console.log('');
  if (doc.operators.length === 0) {
    console.log('NO OPERATOR IS TRUSTED. Every relay verdict will be refused with `operator_not_trusted`,');
    console.log('because admissionFromVerdict requires the verdict signer to appear in this list.');
    console.log('Register one with:  node tools/trust-operator.mjs add --trust <file> --key <operator-key.json>');
  }
  process.exit(0);
}

// --- resolve the key we are adding or removing -----------------------------------------------
let target = PUB;
if (CMD === 'add' && typeof KEY_FILE === 'string') {
  if (!existsSync(resolve(KEY_FILE))) die(`--key: cannot read ${resolve(KEY_FILE)}`);
  let k;
  try { k = JSON.parse(readFileSync(resolve(KEY_FILE), 'utf8')); }
  catch (e) { die(`--key is not valid JSON: ${e.message}`); }
  if (!isAgentId(k.agentId)) die(`--key holds no usable agentId (got ${JSON.stringify(k.agentId)})`);
  target = k.agentId;
}
if (typeof target !== 'string' || !isAgentId(target)) {
  die('--pub <b64u agentId> is required (43 chars), or --key <operator-key.json> for `add`');
}

const before = sha(TRUST_PATH);

if (CMD === 'add') {
  if (doc.operators.includes(target)) {
    console.log(`already trusted: ${target}`);
    console.log(`trust file: ${TRUST_PATH}  (unchanged, sha256 ${before})`);
    process.exit(0);
  }
  doc.operators.push(target);
} else {
  if (!doc.operators.includes(target)) {
    console.log(`not trusted: ${target}  (nothing to remove)`);
    console.log(`trust file: ${TRUST_PATH}  (unchanged, sha256 ${before})`);
    process.exit(0);
  }
  doc.operators = doc.operators.filter((o) => o !== target);
}

// Backup BEFORE the write, named so it sorts next to the original and says when it was taken.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = join(dirname(TRUST_PATH), `${basename(TRUST_PATH)}.${stamp}.bak`);
copyFileSync(TRUST_PATH, backup);

// Preserve the file's original formatting convention: 2-space JSON, trailing newline.
writeFileSync(TRUST_PATH, JSON.stringify(doc, null, 2) + '\n', 'utf8');
const after = sha(TRUST_PATH);

console.log(`${CMD === 'add' ? 'registered' : 'removed'}: ${target}`);
console.log(`trust file : ${TRUST_PATH}`);
console.log(`backup     : ${backup}`);
console.log(`sha256     : ${before}  ->  ${after}`);
console.log('');
show('');
console.log('');
console.log(CMD === 'add'
  ? 'This node will now accept a SIGNED VERDICT from that key. It does not make the key an admin:\n' +
    'a verdict still has to be correctly signed, carry a valid bind, and use a known decision.'
  : 'This node will no longer accept verdicts from that key. Existing permits are unaffected —\n' +
    'revoking a permit is a separate, transitive operation.');
