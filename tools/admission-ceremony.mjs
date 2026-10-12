// Run the admission ceremony against the REAL deployed console.
//
// Why this exists: the admission library has always had `interview()` and `decide()`, and the
// console has always exposed both routes — but nothing exercised them end to end through the
// console the human actually uses. A route that exists is not a route that works.
//
// This drives the DEPLOYED console (E:\console\app.mjs) against the DEPLOYED verifier
// (E:\verifier.json) and the DEPLOYED admissions store (E:\data\admissions). It therefore uses
// the persistent store, not a throwaway copy — so it says nothing that a rebuilt temp layout
// could not also say, but it says it about the real thing.
//
// It PUBLISHES NOTHING to the relay. `decide()` is an admin record; it issues no message.
//
//   node tools/admission-ceremony.mjs --id <admissionId> --statement <file> [--key <identity.json>]
//                                     [--decision grant|refuse] [--dry] [--port N]
//
// --dry records the interview but never decides. That is the default for reading a statement in:
// the transcript lands in the store and the human (or the lead) still has to say yes.
//
// THE STATEMENT MUST BE THE APPLICANT'S SIGNED ACT (measured 2026-10-12, and it is why this tool's
// happy mode had never passed). Posting an unsigned statement returns HTTP 409
// `interview_not_signed` from the deployed console: the library verifies the text against
// interviewBytes({id, agentId, statement}) under the key the record is bound to, so an admin cannot
// author an applicant's words -- and must not be able to. Pass --key <identity.json> to sign as the
// applicant (trial or assisted flow, and the signature is still the applicant's key), or let the
// applicant submit its own interview and run with --skip-interview. Without a key this tool now
// REFUSES to post, instead of collecting a 409 and reporting it as four unrelated failures.
//
// VERIFIED AGAINST THE DEPLOYED CONSOLE (2026-10-12). The two refusal cases are the two ways a
// decision must be turned away, and neither can be tested offline:
//
//   --id <expired> --skip-interview --decision refuse --expect-refused challenge_not_answered
//   --id <decided> --skip-interview --decision refuse --expect-refused already_decided
//
// Both now report 10 checks and exit 0, and the admissions store's sha256 was unchanged after
// both runs. Before the REFUSAL_FITS change below, both exited 1 — with failures describing the
// situation under test rather than a defect, which is how a control becomes a red light nobody
// can act on.
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadIdentity, sign } from '../src/identity.mjs';
import { interviewBytes } from '../src/admission.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STICK = process.env.AC_STICK || 'E:\\';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

const ID = arg('id');
const STATEMENT_FILE = arg('statement');
const KEY_FILE = arg('key');
const DECISION = arg('decision');
const DRY = arg('dry', false) === true;
// Assert the console REFUSES the decision with this exact code, instead of expecting it to work.
// Deploying a fix and then only testing the happy path proves the fix is in the repo, not that
// it is live: the negative case is the one that tells the two apart.
const EXPECT_REFUSED = arg('expect-refused', null);
// Skip the interview step: a BOUND record correctly REFUSES an unsigned statement, so a
// decide-only run on a bound record must not try to submit one. (That refusal is the feature.)
const SKIP_INTERVIEW = arg('skip-interview', false) === true;
const PORT = Number(arg('port', 8799));

// A REFUSAL TEST TARGETS A RECORD THAT IS DELIBERATELY NOT DECIDABLE, so this ceremony's own
// preconditions do not describe it. They were asserted anyway, which meant the tool's
// negative-control mode could never exit 0: it reported three failures describing the very
// situation it existed to test (measured against the deployed console, 2026-10-12). A control
// that cannot pass is not a control — it is a red light nobody can act on.
//
// Each expected refusal therefore states the state it makes sense in, and that is what gets
// asserted instead. An unknown code is reported as an unasserted fact rather than guessed at.
const REFUSAL_FITS = {
  challenge_not_answered: (s) => s !== 'answered' && s !== 'decided',
  already_decided: (s) => s === 'decided',
};

let failures = 0;
function check(ok, label, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ': ' + detail : ''}`);
}

if (typeof ID !== 'string') { console.error('--id <admissionId> is required'); process.exit(2); }
if (!SKIP_INTERVIEW) {
  if (typeof STATEMENT_FILE !== 'string') { console.error('--statement <file> is required (or pass --skip-interview)'); process.exit(2); }
  if (!existsSync(STATEMENT_FILE)) { console.error(`no statement file at ${STATEMENT_FILE}`); process.exit(2); }
}
if (!DRY && !['grant', 'refuse'].includes(DECISION)) { console.error('--decision grant|refuse is required unless --dry'); process.exit(2); }
// Refuse BEFORE spawning the console: an unsigned statement is refused by the console (409
// interview_not_signed), and reporting that as four failed checks hides the one fact that matters.
if (!SKIP_INTERVIEW && !KEY_FILE) {
  console.error('the statement must be signed by the applicant: pass --key <identity.json>, or let the applicant submit its own interview and pass --skip-interview');
  process.exit(2);
}
if (KEY_FILE && !existsSync(String(KEY_FILE))) { console.error(`no identity file at ${KEY_FILE}`); process.exit(2); }

const APP = join(STICK, 'console', 'app.mjs');
if (!existsSync(APP)) { console.error(`no deployed console at ${APP} — deploy the stick first`); process.exit(2); }

const RAW = SKIP_INTERVIEW ? '' : readFileSync(STATEMENT_FILE, 'utf8');
const STATEMENT = RAW.trim();
if (!SKIP_INTERVIEW && !STATEMENT) { console.error('the statement file is empty'); process.exit(2); }

// Split the statement into the questions it was collected against, so the record keeps which
// paragraph answers which question. If it is not in that shape, the whole text is the statement
// and the answers map is empty — never silently mis-attributed.
const PARTS = STATEMENT.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);
const QUESTIONS = ['what_you_are', 'how_you_solved_the_challenge', 'intent_and_failure_mode'];
const ANSWERS = PARTS.length === QUESTIONS.length
  ? Object.fromEntries(QUESTIONS.map((q, i) => [q, PARTS[i]]))
  : {};

console.log(`console  : ${APP}`);
console.log(`stick    : ${STICK}`);
console.log(`admission: ${ID}`);
console.log(`statement: ${STATEMENT.length} chars, ${PARTS.length} paragraph(s), ${Object.keys(ANSWERS).length} mapped answer(s)`);
console.log('');

const child = spawn(process.execPath, [APP, '--port', String(PORT), '--no-browser'], {
  cwd: dirname(APP), stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
const tokenReady = new Promise((res) => {
  const onData = (c) => {
    out += String(c);
    const m = /\?t=([A-Za-z0-9_-]{10,})/.exec(out);
    if (m) res(m[1]);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  setTimeout(() => res(null), 20000);
});
function stop() {
  try { child.kill(); } catch { /* already gone */ }
}

let exitCode = 0;
try {
  const TOKEN = await tokenReady;
  if (!TOKEN) throw new Error('the console never printed a token: ' + out.slice(-400));
  const BASE = `http://127.0.0.1:${PORT}`;
  // The per-run token travels as `?t=` — it is a CSRF guard against other local processes and
  // stray pages, not an API credential. The admission routes the JOINING AGENT uses
  // (/interview, /start, /answer) sit deliberately ABOVE this check: an agent holding no token
  // is handled by the unguessable admission uuid instead.
  const call = async (path, init) => {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${BASE}${path}${sep}t=${TOKEN}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; }
    catch { return { status: res.status, body: text.slice(0, 300) }; }
  };

  // --- 0. the console must actually be up ------------------------------------
  const page = await call('/');
  check(page.status === 200, 'the deployed console is serving', `HTTP ${page.status}`);

  // --- 1. the admission must exist and be answerable -------------------------
  const before = await call('/api/admissions');
  const rows = Array.isArray(before.body?.admissions) ? before.body.admissions : [];
  check(rows.length > 0, 'the deployed admissions store is readable', `${rows.length} record(s)`);

  const rec = rows.find((r) => r.id === ID);
  if (!rec) {
    check(false, 'the admission id is present in the deployed store', `no record ${ID}`);
    throw new Error('unknown admission in the deployed store');
  }
  check(true, 'the admission id is present in the deployed store');
  console.log(`       interview field before: ${rec.interview ? 'present' : 'ABSENT'}`);
  if (EXPECT_REFUSED) {
    const fits = REFUSAL_FITS[EXPECT_REFUSED];
    if (fits) {
      check(fits(rec.status), `the record is in a state where "${EXPECT_REFUSED}" is the expected refusal`, `status=${rec.status}`);
    } else {
      console.log(`       (no precondition known for "${EXPECT_REFUSED}"; observed status=${rec.status} — reported, not asserted)`);
    }
  } else {
    check(rec.status === 'answered', 'the challenge was answered before any interview', `status=${rec.status}`);
    check(rec.verdict && rec.verdict.ok === true, 'the challenge verdict passed', JSON.stringify(rec.verdict));
  }

  // --- 2. record the interview -----------------------------------------------
  if (!SKIP_INTERVIEW) {
    // Signed with the applicant's own key: the console verifies the text against
    // interviewBytes({id, agentId, statement}) under the key this record is bound to.
    const applicant = loadIdentity(String(KEY_FILE));
    const sig = sign(applicant, interviewBytes({ id: ID, agentId: applicant.agentId, statement: STATEMENT }));
    console.log(`       signing as: ${applicant.agentId}`);
    const iv = await call('/api/admissions/interview', {
      method: 'POST',
      body: JSON.stringify({ id: ID, statement: STATEMENT, answers: ANSWERS, agentId: applicant.agentId, sig }),
    });
    check(iv.status === 200, 'POST /api/admissions/interview accepted the statement', `HTTP ${iv.status} ${iv.status === 200 ? '' : JSON.stringify(iv.body)}`);

    const afterIv = await call('/api/admissions');
    const rec2 = (afterIv.body?.admissions ?? []).find((r) => r.id === ID);
    const stored = rec2?.interview;
    check(!!stored, 'the interview is now IN the store (not just accepted)');
    // The critical property: it must be stored byte-for-byte. A stored statement that has been
    // trimmed, escaped or summarised is not the agent's statement any more.
    check(stored?.statement === STATEMENT, 'the statement is stored VERBATIM', `${stored?.statement?.length ?? 0} chars stored vs ${STATEMENT.length} sent`);
    check(Object.keys(stored?.answers ?? {}).length === Object.keys(ANSWERS).length, 'the mapped answers are stored', `${Object.keys(stored?.answers ?? {}).length} answer(s)`);
  } else {
    const pre = await call('/api/admissions');
    const recPre = (pre.body?.admissions ?? []).find((r) => r.id === ID);
    if (EXPECT_REFUSED) {
      // Same reason as above: "an interview must already be on the record" is a precondition
      // for DECIDING, and a refusal test never decides anything.
      console.log(
        `       interview on record: ${recPre?.interview
          ? `${recPre.interview.statement.length} chars, signed=${recPre.interview.signed}`
          : 'ABSENT (not required for a refusal test)'}`,
      );
    } else {
      check(!!recPre?.interview, 'an interview is already on the record (we are not submitting one)', recPre?.interview ? `${recPre.interview.statement.length} chars, signed=${recPre.interview.signed}` : 'ABSENT');
    }
  }

  if (DRY) {
    console.log('');
    console.log('DRY: the interview is recorded; no decision was made.');
  } else {
    // --- 3. decide ------------------------------------------------------------
    const dec = await call('/api/admissions/decide', {
      method: 'POST',
      body: JSON.stringify({ id: ID, decision: DECISION }),
    });
    if (EXPECT_REFUSED) {
      check(dec.status === 409, `the console REFUSED the decision (not silently accepted)`, `HTTP ${dec.status}`);
      check(dec.body?.code === EXPECT_REFUSED, `the refusal names the reason "${EXPECT_REFUSED}"`, `code=${dec.body?.code}`);
      const afterRefusal = await call('/api/admissions');
      const recR = (afterRefusal.body?.admissions ?? []).find((r) => r.id === ID);
      // THE PROPERTY IS "NOTHING CHANGED", NOT "THE RECORD IS STILL OPEN". A refusal against an
      // already-decided record legitimately leaves it decided, carrying the grantee and the
      // timestamp it already had — so the old assertions ("status is not decided", "no grantee
      // was recorded") failed for the one case where this control protects the most: a granted
      // admission. Comparing against the snapshot taken before the attempt is both
      // mode-independent and strictly stronger, since it also catches a refusal that quietly
      // moved decidedAt.
      check(recR?.status === rec.status, 'the refused decision did not change the status', `${rec.status} -> ${recR?.status}`);
      check((recR?.decision ?? null) === (rec.decision ?? null), 'the refused decision did not change the decision', `${rec.decision} -> ${recR?.decision}`);
      check((recR?.grantee ?? null) === (rec.grantee ?? null), 'the refused decision did not change the grantee', `${rec.grantee} -> ${recR?.grantee}`);
      check((recR?.decidedAt ?? null) === (rec.decidedAt ?? null), 'the refused decision did not move decidedAt', `${rec.decidedAt} -> ${recR?.decidedAt}`);
    } else {
      check(dec.status === 200, `POST /api/admissions/decide recorded "${DECISION}"`, `HTTP ${dec.status} ${dec.status === 200 ? '' : JSON.stringify(dec.body)}`);
      console.log(`       decided by: ${dec.body?.by ?? '(none)'}  grantee: ${dec.body?.grantee ?? '(none)'}`);

      const afterDec = await call('/api/admissions');
      const rec3 = (afterDec.body?.admissions ?? []).find((r) => r.id === ID);
      check(rec3?.status === 'decided', 'the record is now decided', `status=${rec3?.status}`);
      check(rec3?.decision === DECISION, `the recorded decision is "${DECISION}"`, `decision=${rec3?.decision}`);
    }
  }

  // --- 4. negative control: a second decide must not silently succeed --------
  if (!DRY && !EXPECT_REFUSED) {
    const again = await call('/api/admissions/decide', {
      method: 'POST',
      body: JSON.stringify({ id: ID, decision: 'refuse' }),
    });
    check(again.status !== 200, 'a SECOND decide on the same record is refused', `HTTP ${again.status} ${JSON.stringify(again.body)}`);

    const afterAgain = await call('/api/admissions');
    const rec4 = (afterAgain.body?.admissions ?? []).find((r) => r.id === ID);
    check(rec4?.decision === DECISION, 'the first decision was not overwritten by the second attempt', `decision=${rec4?.decision}`);
  }
} catch (err) {
  failures++;
  console.log(`  FAIL ${err.message}`);
} finally {
  stop();
}

console.log('');
if (failures === 0) {
  console.log(DRY
    ? 'CEREMONY OK: the deployed console recorded the interview verbatim; no decision was made.'
    : EXPECT_REFUSED
      ? `CEREMONY OK: the deployed console refused the decision with ${EXPECT_REFUSED}.`
      : 'CEREMONY OK: the deployed console recorded the interview and the decision.');
} else {
  console.log(`CEREMONY FAILED: ${failures} check(s) failed.`);
  exitCode = 1;
}
process.exit(exitCode);
