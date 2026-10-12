#!/usr/bin/env node
// Verify EVERY stored admission from the store alone -- and say which records are even claiming to be
// admissions. Run it with: npm run verify:store
//
// WHY THIS EXISTS
// tools/verify-admission.mjs already does the hard part: it re-derives a record's standing from the
// store alone, trusting no flag the record sets about itself, with a sideband that mutates the
// statement to prove its own check can fail, and a cross-domain check that the interview signature
// cannot be replayed as a relay signature. But it takes `--id <admissionId>`, so running it required
// already knowing which id to ask about -- and nothing in this repository ever did.
//
// Measured 2026-10-12: a working, discriminating verifier that had NEVER BEEN RUN. A verifier you have
// to remember to invoke is not verifying anything. This runs it over the whole store.
//
// A FRESH PROCESS PER RECORD, deliberately. Each id is re-verified by its own `node` process, so no
// record's verdict can be influenced by state left over from another's -- the same reason
// tools/verify-relay-verdict.mjs re-verifies "from a FRESH process ... without reusing any of the
// trial's in-memory state".
//
// WHAT COUNTS AS A FAILURE
// Expired and never-completed records live in the SAME FILE as real ones, and they CANNOT verify --
// that is the correct answer for them, not a defect. So a record is HELD TO ACCOUNT only when this
// commons actually recorded a decision on it (`status === 'decided'`). Those must stand up. Everything
// else is reported as inert WITH ITS STATUS NAMED, so a green summary can never be misread as "all of
// these are admissions".
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STICK = process.env.AC_STICK || 'E:\\';
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const STORE = arg('store', join(STICK, 'data', 'admissions', 'admissions.json'));

if (!existsSync(STORE)) { console.error(`no admissions store at ${STORE}`); process.exit(2); }
let raw;
try {
  raw = JSON.parse(readFileSync(STORE, 'utf8'));
} catch (err) {
  console.error(`${STORE} is not valid JSON: ${err?.message || err}`);
  console.error('  A truncated or half-written store cannot be verified -- and it must not be reported as');
  console.error('  an empty one either. This tool prints a clean bill of health, and one over a file that');
  console.error('  could not be read is worse than no check at all.');
  process.exit(2);
}
// The store has ONE shape: an object with an admissions array (a bare array is tolerated because an
// older export wrote that). `?? []` here turned any other JSON -- {}, {"admissions":null}, a relay or
// error response saved by mistake -- into "verifying 0 record(s)" and then the OK banner with exit 0:
// a tamper check blessing a file it never read. A wrong shape and an empty store are both "nothing
// was verified", so both fail.
if (!Array.isArray(raw) && !Array.isArray(raw?.admissions)) {
  const what = raw === null || typeof raw !== 'object'
    ? JSON.stringify(raw)?.slice(0, 40) ?? String(raw)
    : `top-level keys: ${Object.keys(raw).join(',') || 'none'}`;
  console.error(`${STORE} is not an admissions store (${what}).`);
  console.error('  Expected { "admissions": [ ... ] }. Nothing was verified, so this is a failure, not a pass.');
  process.exit(2);
}
const rows = Array.isArray(raw) ? raw : raw.admissions;
if (rows.length === 0) {
  console.error(`${STORE} is shape-valid but holds 0 records: nothing was verified.`);
  console.error('  If records were expected here, this is the wrong file; either way there is no evidence to report.');
  process.exit(2);
}

const heldToAccount = (r) => r.status === 'decided';

let held = 0;
let broken = 0;
let inert = 0;
console.log(`\n--- verifying ${rows.length} record(s) in ${STORE} ---\n`);

for (const r of rows) {
  const id = String(r.id ?? '(no id)');
  let verifies = false;
  try {
    // `--store` is passed THROUGH, and that is not decoration. The first version of this runner listed
    // records from the store it was pointed at but let each child fall back to the DEFAULT store, so
    // pointing it at a tampered copy verified the tampered copy's ROWS against the untouched original
    // -- and reported "HELD-UP". A verifier that silently checks a different file than the one it was
    // given is worse than no verifier, because it produces a green result with a straight face.
    // Caught by the tamper test in .tmp/, which is the only reason it is not still there.
    execFileSync(process.execPath,
      [join(HERE, 'verify-admission.mjs'), '--id', id, '--json', '--store', STORE],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    verifies = true;
  } catch { verifies = false; }

  const must = heldToAccount(r);
  if (must) held += 1; else inert += 1;
  if (must && !verifies) broken += 1;

  const label = must ? (verifies ? 'HELD-UP ' : 'BROKEN  ') : 'inert   ';
  // The FULL id, not a prefix. The whole point of naming a failing record is that someone can act on
  // it, and the action here is `verify-admission --id <id>` -- which a truncated id cannot feed. A
  // prefix also collides: two UUIDs sharing eight characters would print as the same record.
  console.log(`  ${label} ${id.padEnd(38)} status=${String(r.status ?? '?').padEnd(9)}`
    + ` decision=${String(r.decision ?? '-').padEnd(7)} ${verifies ? 'verifies' : 'does NOT verify'}`);
}

console.log('');
console.log(`  ${held} record(s) recorded a DECISION and were held to account; ${broken} of them failed.`);
console.log(`  ${inert} record(s) are expired or undecided: they cannot verify by construction, and are`
  + ' reported here rather than counted as failures.');
console.log(broken
  ? `\nFAILED: ${broken} record(s) this commons recorded a decision on do NOT stand up to independent re-derivation.\n`
  : '\nOK: every record this commons decided on stands up to independent re-derivation from the store alone.\n');
process.exit(broken ? 1 : 0);
