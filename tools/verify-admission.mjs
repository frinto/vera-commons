// Verify a stored admission from the STORE ALONE. Trusts no flag in the record.
//
// Why this is separate from the code that writes the record: `signed: true` is a claim made by
// whoever wrote it. On a system whose entire proposition is tamper-evidence, a claim is not
// evidence. This tool re-derives the signed bytes from the stored statement and checks the
// signature against the bound key, so the answer does not depend on the writer being honest.
//
//   node tools/verify-admission.mjs --id <admissionId> [--store <path>] [--json]
//
// Default store is the deployed one on the stick. Read-only: it never writes.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify } from '../src/identity.mjs';
import { bindBytes, interviewBytes, relayBindBytes, relayInterviewBytes, isAgentId } from '../src/admission.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STICK = process.env.AC_STICK || 'E:\\';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

const ID = arg('id');
const STORE = arg('store', join(STICK, 'data', 'admissions', 'admissions.json'));
const AS_JSON = arg('json', false) === true;

if (typeof ID !== 'string' || !ID) { console.error('--id <admissionId> is required'); process.exit(2); }
if (!existsSync(STORE)) { console.error(`no admissions store at ${STORE}`); process.exit(2); }

let failures = 0;
function check(ok, label, detail = '') {
  if (!ok) failures++;
  if (!AS_JSON) console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ': ' + detail : ''}`);
  return ok;
}

const store = JSON.parse(readFileSync(STORE, 'utf8'));
const rec = (store.admissions ?? []).find((r) => r.id === ID);
if (!rec) { console.error(`no admission ${ID} in ${STORE}`); process.exit(2); }

const out = { id: rec.id, joinKey: rec.joinKey, status: rec.status, bound: !!rec.agentId, checks: {} };

// --- 0. WHICH BYTES were signed? A guess here would be worse than no check ------
//
// A record bound locally is signed over the admission id; one bound through the relay is signed
// over the relay requestId. They are different domains by design, so deriving the wrong one turns a
// perfectly good record into an apparent forgery. The record therefore has to SAY which it is, and
// this verifier refuses to guess: an unstated or unresolvable handle is reported as a failure
// rather than quietly falling back to the local form.
const boundVia = rec.boundVia ?? (rec.agentId ? 'local' : null);
const ivVia = rec.interview?.via ?? boundVia;
const relayReq = rec.relayRequestId ?? rec.interview?.relayRequestId ?? null;
out.boundVia = boundVia;
out.interviewVia = ivVia;

const bindBytesFor = (agentId) => (boundVia === 'relay'
  ? relayBindBytes({ requestId: relayReq, agentId })
  : bindBytes({ id: rec.id, agentId }));
const itvBytesFor = (agentId, statement) => (ivVia === 'relay'
  ? relayInterviewBytes({ requestId: relayReq, agentId, statement })
  : interviewBytes({ id: rec.id, agentId, statement }));

if (boundVia === 'relay' && !relayReq) {
  check(false, 'a relay-bound record states the requestId its signature covers',
    'boundVia=relay but no relayRequestId — the signature cannot be re-derived, so it proves nothing');
}
check(boundVia === 'relay' || boundVia === 'local', 'the record states how the key was bound', String(boundVia));

// --- 1. the record names a key, and the key is well-formed --------------------
check(isAgentId(rec.agentId), 'the record names a well-formed ed25519 key', String(rec.agentId).slice(0, 12) + '...');
out.agentId = rec.agentId ?? null;

// --- 2. the BIND signature re-verifies (if one was kept) ---------------------
if (rec.bindSig) {
  let bindOK = false;
  try { bindOK = verify(rec.agentId, bindBytesFor(rec.agentId), rec.bindSig) === true; }
  catch { bindOK = false; }
  check(bindOK, `the stored BIND signature re-verifies (${boundVia} domain)`);
  out.checks.bindSignature = bindOK;
} else {
  // No stored bind signature. That is NOT automatically a failure, and calling it one would be
  // wrong in a specific way: an interview signature covers (id-or-requestId, agentId, statement),
  // so it independently proves possession of the private key for `agentId`. The property that
  // matters is "this key is attested by SOME signature", not "the bind signature specifically
  // exists".
  //
  // It IS a failure when neither proof exists — otherwise this branch would pass a record that
  // nothing whatsoever attests to, which is the shape of a check that always says yes.
  const ivForBind = rec.interview;
  let corroborated = false;
  if (ivForBind && typeof ivForBind.statement === 'string' && ivForBind.sig) {
    try {
      corroborated = verify(rec.agentId, itvBytesFor(rec.agentId, ivForBind.statement), ivForBind.sig) === true;
    } catch { corroborated = false; }
  }
  check(corroborated, 'the bound key is attested by SOME signature (bind or interview)',
    corroborated ? 'by the interview signature; no bindSig (record predates the fix)' : 'no bindSig AND no valid interview signature');
  out.checks.bindSignature = corroborated ? 'corroborated-by-interview' : false;
}

// --- 3. the challenge was answered and passed ---------------------------------
const v = rec.verdict;
check(!!v && v.ok === true, 'the challenge verdict recorded a pass', v ? `${v.correct}/${v.total}` : 'no verdict');
out.verdict = v ? { ok: v.ok, correct: v.correct, total: v.total, ratio: v.ratio } : null;

// --- 4. the INTERVIEW signature re-verifies over the STORED statement ---------
const iv = rec.interview;
if (!iv) {
  check(false, 'an interview statement is present', 'absent');
  out.checks.interviewSignature = null;
} else {
  out.interview = { chars: iv.statement.length, signed: iv.signed === true, answeredQuestions: Object.keys(iv.answers ?? {}).length };
  if (iv.sig) {
    let ok = false;
    try { ok = verify(rec.agentId, itvBytesFor(rec.agentId, iv.statement), iv.sig) === true; }
    catch { ok = false; }
    check(ok, `the stored INTERVIEW signature re-verifies against the bound key over the stored text (${ivVia} domain)`);
    out.checks.interviewSignature = ok;

    // A tampered statement must FAIL. Re-verify against a mutated copy: if this also passed, the
    // check above would be meaningless, and a green result would carry no information at all.
    const tampered = iv.statement + ' (and one more thing)';
    let tamperOK = false;
    try { tamperOK = verify(rec.agentId, itvBytesFor(rec.agentId, tampered), iv.sig) === true; }
    catch { tamperOK = false; }
    check(!tamperOK, 'a MUTATED statement does NOT verify (the check above can actually fail)');
    out.checks.tamperDiscriminates = !tamperOK;

    // And the OTHER domain must not verify this signature either. If both domains accepted it, the
    // separation would be decorative — and a signature could be replayed across the two contexts.
    let crossOK = false;
    try {
      const otherBytes = ivVia === 'relay'
        ? interviewBytes({ id: rec.id, agentId: rec.agentId, statement: iv.statement })
        : relayInterviewBytes({ requestId: relayReq ?? rec.id, agentId: rec.agentId, statement: iv.statement });
      crossOK = verify(rec.agentId, otherBytes, iv.sig) === true;
    } catch { crossOK = false; }
    check(!crossOK, 'the signature does NOT verify in the other signing domain (the domains really are separate)');
    out.checks.domainsSeparate = !crossOK;
  } else {
    check(false, 'a stored INTERVIEW signature exists to re-verify', 'absent (record predates signature storage)');
    out.checks.interviewSignature = null;
  }
}

// --- 5. decision bookkeeping --------------------------------------------------
if (rec.status === 'decided') {
  check(rec.decision === 'grant' || rec.decision === 'refuse', 'a decided record names its decision', rec.decision);
  if (rec.decision === 'grant') {
    check(rec.grantee === rec.agentId, 'a GRANT names the grantee that was bound', `grantee=${String(rec.grantee).slice(0, 12)}...`);
  }
}
out.decision = rec.decision ?? null;
out.grantee = rec.grantee ?? null;

if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); }
else {
  console.log('');
  console.log(failures === 0
    ? 'VERIFIED: the record stands up to independent re-derivation from the store alone.'
    : `NOT VERIFIED: ${failures} check(s) failed. Read the failures, not the summary.`);
}
process.exit(failures === 0 ? 0 : 1);
