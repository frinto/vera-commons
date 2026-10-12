// Issue a permit FROM a granted admission. This is the last seam in the gate.
//
// Before this existed there were two disconnected halves: an admission record that proved someone
// passed, and a permit that granted authority. Nothing tied them together, so the grantee key on
// the permit came from a human remembering which record belonged to whom — and a mis-typed key
// here grants authority to the wrong agent with no record of the mistake.
//
// Reading the grantee OUT of the decided admission makes that impossible: the permit can only name
// a key that an admin explicitly granted. Refuses anything that is not an actual grant.
//
//   node tools/issue-permit.mjs --id <admissionId> --level poster [--stick E:\] [--dry]
//
// Authority is real, so this is deliberately a separate act from the decision: deciding is
// bookkeeping, permitting is the thing that lets a stranger speak.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadIdentity } from '../src/identity.mjs';
import { issuePermit, levelOf, PERMIT_LEVELS } from '../src/permit.mjs';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

const ID = arg('id');
const LEVEL = arg('level');
const STICK = arg('stick', process.env.AC_STICK || 'E:\\');
const DRY = arg('dry', false) === true;

let failures = 0;
function check(ok, label, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ': ' + detail : ''}`);
}

if (typeof ID !== 'string') { console.error('--id <admissionId> is required'); process.exit(2); }
if (!PERMIT_LEVELS.includes(LEVEL)) { console.error(`--level must be one of ${PERMIT_LEVELS.join(' | ')}`); process.exit(2); }

const STORE = join(STICK, 'data', 'admissions', 'admissions.json');
const TRUST = join(STICK, 'trust.json');
const ADMIN_KEY = join(STICK, 'user-admin.json');
for (const [label, path] of [['admissions store', STORE], ['trust bundle', TRUST], ['admin key', ADMIN_KEY]]) {
  if (!existsSync(path)) { console.error(`no ${label} at ${path}`); process.exit(2); }
}

// --- 1. the admission must actually be a GRANT --------------------------------
const rec = (JSON.parse(readFileSync(STORE, 'utf8')).admissions ?? []).find((r) => r.id === ID);
if (!rec) { console.error(`no admission ${ID} in ${STORE}`); process.exit(2); }

check(rec.status === 'decided', 'the admission is decided', `status=${rec.status}`);
check(rec.decision === 'grant', 'the decision is a GRANT, not a refusal', `decision=${rec.decision}`);
check(typeof rec.grantee === 'string' && rec.grantee.length === 43, 'the grant names a grantee key', String(rec.grantee).slice(0, 12) + '...');
if (failures > 0) { console.log('\nREFUSING: a permit may only be issued from a granted admission.'); process.exit(1); }

const GRANTEE = rec.grantee;
console.log(`admission: ${ID}`);
console.log(`grantee  : ${GRANTEE}`);
console.log(`level    : ${LEVEL} -> ${GRANTEE.slice(0, 12)}...`);
console.log('');

// --- 2. issue with the ADMIN key, seq continuing from the issuer's history ----
const admin = loadIdentity(ADMIN_KEY);
check(admin.agentId === rec.decidedBy, 'the admin key here is the admin who DECIDED', `${admin.agentId.slice(0, 12)}... vs ${String(rec.decidedBy).slice(0, 12)}...`);

const trust = JSON.parse(readFileSync(TRUST, 'utf8'));
trust.permits = Array.isArray(trust.permits) ? trust.permits : [];

const mine = trust.permits.filter((p) => p.issuer === admin.agentId);
const nextSeq = mine.reduce((max, p) => Math.max(max, Number(p.seq) || 0), 0) + 1;
check(nextSeq >= 1, 'the next permit seq is derived from the issuer history', `seq=${nextSeq}`);

// Refuse a duplicate: two live permits for the same grantee at the same level is a sign the
// operator lost track, and a permit log that quietly accumulates them cannot be audited.
const existing = trust.permits.find((p) => p.grantee === GRANTEE && p.type === 'grant' && !p.revoked);
if (existing) {
  check(false, 'this grantee does not already hold a permit', `already at level=${existing.level}, seq=${existing.seq}`);
  console.log('\nREFUSING: revoke the existing permit first, or the log will not say which one is live.');
  process.exit(1);
}
check(true, 'this grantee does not already hold a permit');

const permit = issuePermit(admin, { type: 'grant', grantee: GRANTEE, level: LEVEL, seq: nextSeq });

// --- 3. the permit must RESOLVE to a real level before it is written ----------
const roots = trust.roots ?? [];
check(levelOf([...trust.permits, permit], roots, GRANTEE) === LEVEL,
  'the new permit resolves to the intended level for the grantee',
  `levelOf=${levelOf([...trust.permits, permit], roots, GRANTEE)}`);
// Negative control: an unrelated key must be UNAFFECTED by this permit.
//
// Not "gets nothing" — `levelOf` returns `observer` for any key it does not know, because reading
// is open to everyone and only speaking is gated. So the invariant is a before/after comparison:
// if the stranger's level moves, the permit is matching the wrong key (a prefix match, or ignoring
// the grantee entirely), and a single-key check would never notice.
const stranger = 'B'.repeat(43);
const strangerBefore = levelOf(trust.permits, roots, stranger);
const strangerAfter = levelOf([...trust.permits, permit], roots, stranger);
check(strangerAfter === strangerBefore,
  'an unrelated key is UNAFFECTED by this permit (level unchanged)',
  `${strangerBefore} -> ${strangerAfter}`);
check(levelOf([...trust.permits, permit], roots, GRANTEE) !== strangerAfter || LEVEL === strangerAfter,
  'the grantee and a stranger do not resolve to the same level unless that level is the default',
  `grantee=${levelOf([...trust.permits, permit], roots, GRANTEE)}, stranger=${strangerAfter}`);

if (DRY) {
  console.log('\nDRY: the permit verifies but was NOT written.');
  process.exit(failures === 0 ? 0 : 1);
}

// --- 4. write, with a backup ------------------------------------------------
copyFileSync(TRUST, TRUST + '.bak');
trust.permits.push(permit);
trust.issuedAt = Date.now();
writeFileSync(TRUST, JSON.stringify(trust, null, 2) + '\n', 'utf8');

// Re-read from disk: a permit that only exists in this process's memory is not issued.
const reread = JSON.parse(readFileSync(TRUST, 'utf8'));
const back = (reread.permits ?? []).find((p) => p.grantee === GRANTEE && p.seq === nextSeq);
check(!!back, 'the permit is ON DISK after the write');
check(back?.sig === permit.sig, 'the persisted permit carries the same signature');
check(levelOf(reread.permits, reread.roots ?? [], GRANTEE) === LEVEL,
  'the persisted bundle resolves the grantee to the intended level',
  `levelOf=${levelOf(reread.permits, reread.roots ?? [], GRANTEE)}`);

console.log('');
console.log(failures === 0
  ? `PERMIT ISSUED: ${GRANTEE.slice(0, 12)}... is now "${LEVEL}" (seq ${nextSeq}), signed by ${admin.agentId.slice(0, 12)}...`
  : `PERMIT NOT CLEANLY ISSUED: ${failures} check(s) failed — inspect ${TRUST} (backup at ${TRUST}.bak).`);
process.exit(failures === 0 ? 0 : 1);
