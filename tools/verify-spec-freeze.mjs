#!/usr/bin/env node
// verify-spec-freeze.mjs — make "frozen" a verifiable fact about the wire spec.
//
//   node tools/verify-spec-freeze.mjs             verify the freeze holds
//   node tools/verify-spec-freeze.mjs --freeze    record a NEW freeze (see the rule)
//   node tools/verify-spec-freeze.mjs --self-test prove the check can fail
//
// WHY THIS EXISTS
//   `spec/COMMONS-SPEC.md` says sections are "FROZEN" and that changing one means a
//   version bump. That was a promise in prose, and a promise in prose is not a control:
//   nothing detected a silent edit, and nothing stopped one. Peers implement against
//   this document. If it can drift without anyone noticing, the guarantee is decoration.
//
// THE RULE (enforced, not documented)
//   --freeze REFUSES to re-record the spec if its content changed but its version did
//   not. So the only way to move a frozen spec is to bump its version. That is what
//   "frozen" is supposed to mean, and it is now mechanical rather than aspirational.
//
// EXIT CODES
//   0  the spec matches the recorded freeze
//   1  the spec CHANGED without a version bump (drift), or the freeze is missing
//   2  instrument failure (spec or freeze file unreadable/malformed)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = join(ROOT, 'spec', 'COMMONS-SPEC.md');
const FREEZE = join(ROOT, 'spec', 'SPEC-FREEZE.json');

const has = (f) => process.argv.includes(f);

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

/** The version declared on line 1: "# Agent Commons — specification v0.1" */
function specVersion(text) {
  const m = text.match(/specification\s+v([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i);
  return m ? m[1] : null;
}

function load() {
  if (!existsSync(SPEC)) { console.error(`instrument failure: ${SPEC} not found`); process.exit(2); }
  const bytes = readFileSync(SPEC);
  const text = bytes.toString('utf8');
  const version = specVersion(text);
  if (!version) { console.error('instrument failure: no "specification vX.Y" line found in the spec'); process.exit(2); }
  return { bytes, text, version, sha256: sha256(bytes) };
}

function loadFreeze() {
  if (!existsSync(FREEZE)) return null;
  try { return JSON.parse(readFileSync(FREEZE, 'utf8')); }
  catch (e) { console.error(`instrument failure: ${FREEZE} is not valid JSON: ${e.message}`); process.exit(2); }
}

// ---------------------------------------------------------------------------
// SELF-TEST — prove the drift check can FAIL, and that it passes when clean.
// ---------------------------------------------------------------------------
if (has('--self-test')) {
  const cur = load();
  const frozen = loadFreeze();
  if (!frozen) {
    console.log('SELF-TEST SKIP - no freeze recorded yet; run --freeze first.');
    process.exit(2);
  }
  // Arm 1: simulate a silent edit — same version, different bytes. MUST be caught.
  const tampered = { ...cur, sha256: sha256(Buffer.from(cur.text + '\n<!-- silent edit -->')) };
  const driftCaught = !(tampered.sha256 === frozen.sha256 && tampered.version === frozen.version);
  // Arm 2: the real spec must currently match its freeze.
  const cleanOK = cur.sha256 === frozen.sha256 && cur.version === frozen.version;

  console.log(`  DRIFT arm : tampered content ${driftCaught ? 'was detected' : 'was NOT detected -- check is decorative'}`);
  console.log(`  CLEAN arm : recorded freeze ${cleanOK ? 'matches the spec on disk' : 'does NOT match the spec on disk'}`);
  const pass = driftCaught && cleanOK;
  console.log(pass ? 'SELF-TEST PASS' : 'SELF-TEST FAIL');
  process.exit(pass ? 0 : 1);
}

const cur = load();
const frozen = loadFreeze();

if (has('--freeze')) {
  if (frozen && frozen.sha256 !== cur.sha256 && frozen.version === cur.version) {
    console.error(`REFUSED: the spec changed but its version is still v${cur.version}.`);
    console.error('A frozen spec may only move by a version bump. Bump the version line in');
    console.error(`${SPEC} (currently "# Agent Commons — specification v${cur.version}") and re-run --freeze.`);
    process.exit(1);
  }
  const record = {
    protocol: 'agent-commons/1',
    version: cur.version,
    sha256: cur.sha256,
    bytes: cur.bytes.length,
    frozenAt: new Date().toISOString(),
    previousVersion: frozen && frozen.version !== cur.version ? frozen.version : undefined,
  };
  writeFileSync(FREEZE, JSON.stringify(record, null, 2) + '\n');
  console.log(`frozen: spec v${cur.version}  ${record.bytes} B  sha256 ${cur.sha256}`);
  process.exit(0);
}

if (!frozen) {
  console.error(`FAIL: no freeze recorded at ${FREEZE}. The spec is not frozen.`);
  console.error('Record one with:  node tools/verify-spec-freeze.mjs --freeze');
  process.exit(1);
}

const sameBytes = cur.sha256 === frozen.sha256;
const sameVersion = cur.version === frozen.version;

if (sameBytes && sameVersion) {
  console.log(`OK  spec v${cur.version} is frozen and unchanged  (${frozen.bytes} B, sha256 ${frozen.sha256.slice(0, 16)}...)`);
  console.log(`    frozen ${frozen.frozenAt}`);
  process.exit(0);
}

if (!sameVersion) {
  console.error(`FAIL: spec version moved v${frozen.version} -> v${cur.version} but the freeze was not updated.`);
  console.error('A version bump is the sanctioned way to change a frozen spec; re-record it with --freeze.');
  process.exit(1);
}

console.error('FAIL: THE FROZEN WIRE SPEC CHANGED WITHOUT A VERSION BUMP.');
console.error(`  recorded : ${frozen.bytes} B  sha256 ${frozen.sha256}`);
console.error(`  on disk  : ${cur.bytes.length} B  sha256 ${cur.sha256}`);
console.error('  Peers implement against this document. Either revert the edit, or bump the');
console.error(`  version in spec/COMMONS-SPEC.md and run:  node tools/verify-spec-freeze.mjs --freeze`);
process.exit(1);
