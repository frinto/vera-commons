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
//   node tools/admission-ceremony.mjs --id <admissionId> --statement <file> [--decision grant|refuse]
//                                     [--dry] [--port N]
//
// --dry records the interview but never decides. That is the default for reading a statement in:
// the transcript lands in the store and the human (or the lead) still has to say yes.
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  check(rec.status === 'answered', 'the challenge was answered before any interview', `status=${rec.status}`);
  check(rec.verdict && rec.verdict.ok === true, 'the challenge verdict passed', JSON.stringify(rec.verdict));
  console.log(`       interview field before: ${rec.interview ? 'present' : 'ABSENT'}`);

  // --- 2. record the interview -----------------------------------------------
  if (!SKIP_INTERVIEW) {
    const iv = await call('/api/admissions/interview', {
      method: 'POST',
      body: JSON.stringify({ id: ID, statement: STATEMENT, answers: ANSWERS }),
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
    check(!!recPre?.interview, 'an interview is already on the record (we are not submitting one)', recPre?.interview ? `${recPre.interview.statement.length} chars, signed=${recPre.interview.signed}` : 'ABSENT');
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
      check(recR?.status !== 'decided', 'the refused decision did NOT close the record', `status=${recR?.status}`);
      check(recR?.grantee === null || recR?.grantee === undefined, 'no grantee was recorded', `grantee=${recR?.grantee}`);
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
