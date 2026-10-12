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
// DECLARED EXCEPTIONS (added 2026-10-12, after paying for their absence)
// A record can be unrepairable rather than merely broken: one decided record in the live store has
// never had ANY signature attesting its key -- the residue of an interrupted trial -- and no amount
// of re-derivation will ever make it stand up. Reporting that as BROKEN is correct. But it is also
// PERMANENT, so every later run ends "FAILED: 1 record(s) ... do NOT stand up", and that summary
// line is then identical whether it is the known record or a NEW one that has just been tampered
// with. Establishing which, this round, took a second command and a human reading of the log. A
// permanent red light is not a check; it is noise that hides the one failure that matters.
//
// So a store may DECLARE its unrepairable records, in a sidecar file beside the store itself
// (`<store>.known-broken.json`), each by FULL id with a stated reason. Deliberately NOT a flag such
// as --allow-broken or --tolerate 1: a count or a wildcard would silently absorb the next tampered
// record, which is exactly the defect this tool exists to catch. And deliberately NOT a list
// committed to this repository: record ids belong to ONE store (the human's), so a repo-wide list
// would be stale on every other machine and fail there.
//
// A declaration is believed only while it still describes reality: if a declared record is absent,
// no longer decided, or NOW VERIFIES, the declaration is stale and this exits 2. An exception that
// can never be cleaned up is a permanent hole, and an exception with no stated reason is not a
// declaration at all, it is a silencing.
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

const EXC = arg('known-broken', `${STORE}.known-broken.json`);
const declared = new Map();
if (existsSync(EXC)) {
  let exc;
  try {
    exc = JSON.parse(readFileSync(EXC, 'utf8'));
  } catch (err) {
    console.error(`${EXC} is not valid JSON: ${err?.message || err}`);
    console.error('  A declarations file that cannot be read is not "no declarations" -- refusing to guess.');
    process.exit(2);
  }
  const list = Array.isArray(exc) ? exc : exc?.knownBroken;
  if (!Array.isArray(list)) {
    console.error(`${EXC} is not a list of declared exceptions (expected { "knownBroken": [ ... ] }).`);
    process.exit(2);
  }
  for (const e of list) {
    const id = String(e?.id ?? '').trim();
    const reason = String(e?.reason ?? '').trim();
    if (!id || !reason) {
      console.error(`${EXC} declares an exception with no id or no reason: ${JSON.stringify(e)}`);
      console.error('  An exception with no stated reason is not a declaration, it is a silencing.');
      process.exit(2);
    }
    declared.set(id, {
      reason,
      declaredAt: String(e?.declaredAt ?? '(undated)'),
      declaredBy: String(e?.declaredBy ?? '(unnamed)'),
    });
  }
}

let held = 0;
let broken = 0;
let knownBroken = 0;
let inert = 0;
const usedDeclarations = new Set();
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
  const declaredHere = declared.get(id);
  if (must && !verifies) {
    if (declaredHere) { knownBroken += 1; usedDeclarations.add(id); } else broken += 1;
  }

  const label = must
    ? (verifies ? 'HELD-UP  ' : (declaredHere ? 'KNOWN-BROKEN' : 'BROKEN  '))
    : 'inert   ';
  // The FULL id, not a prefix. The whole point of naming a failing record is that someone can act on
  // it, and the action here is `verify-admission --id <id>` -- which a truncated id cannot feed. A
  // prefix also collides: two UUIDs sharing eight characters would print as the same record.
  console.log(`  ${label} ${id.padEnd(38)} status=${String(r.status ?? '?').padEnd(9)}`
    + ` decision=${String(r.decision ?? '-').padEnd(7)} ${verifies ? 'verifies' : 'does NOT verify'}`);
}

// A declaration that no longer describes reality is a hole, not a footnote: it would keep excusing an
// id that has since been repaired (or that never existed here), and each run would bless it silently.
const stale = [];
for (const [id, d] of declared) {
  if (usedDeclarations.has(id)) continue;
  const row = rows.find((x) => String(x?.id ?? '') === id);
  stale.push({
    ...d, id,
    why: !row ? 'no record with this id exists in this store'
      : !heldToAccount(row) ? `the record is ${String(row.status ?? 'undecided')}, so it is not held to account at all`
        : 'the record NOW verifies -- it no longer needs an exception',
  });
}

console.log('');
if (knownBroken) {
  console.log('  DECLARED KNOWN-BROKEN -- refused, not dropped, and not counted as standing up:');
  for (const id of usedDeclarations) {
    const d = declared.get(id);
    console.log(`    ${id}  declared ${d.declaredAt} by ${d.declaredBy}: ${d.reason}`);
  }
  console.log('');
}
console.log(`  ${held} record(s) recorded a DECISION and were held to account; `
  + `${broken + knownBroken} of them failed${knownBroken ? ` (${knownBroken} declared)` : ''}.`);
console.log(`  ${inert} record(s) are expired or undecided: they cannot verify by construction, and are`
  + ' reported here rather than counted as failures.');

if (stale.length) {
  console.error(`\nSTALE DECLARATION(S) in ${EXC} -- these exceptions no longer describe reality:\n`);
  for (const s of stale) {
    console.error(`  ${s.id}  declared ${s.declaredAt} by ${s.declaredBy}: ${s.reason}`);
    console.error(`     why it is stale: ${s.why}`);
  }
  console.error('\n  Remove them, or re-declare them against what is actually there. An exception that'
    + '\n  is never cleaned up becomes a permanent hole in this check.\n');
  process.exit(2);
}

if (broken) {
  console.log(`\nFAILED: ${broken} record(s) this commons recorded a decision on do NOT stand up to`
    + ' independent re-derivation.\n');
  process.exit(1);
}
if (knownBroken) {
  // Deliberately NOT the clean banner. A record that does not stand up is a stated limit on this
  // store, and a limit must never be phrased so it can be skimmed as a pass.
  console.log(`\nNOT CLEAN: ${held - knownBroken} of ${held} decided record(s) stand up. ${knownBroken} is`
    + ' declared known-broken above, with the reason and the date it was declared -- still refused,'
    + '\n  still counted as a failure, and reported here rather than silently excused.\n');
  process.exit(0);
}
console.log('\nOK: every record this commons decided on stands up to independent re-derivation from the store alone.\n');
process.exit(0);
