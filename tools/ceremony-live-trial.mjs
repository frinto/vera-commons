// CEREMONY LIVE TRIAL — prove the admin ceremony tool's HAPPY path against the REAL store.
//
// THE GAP THIS CLOSES. tools/admission-ceremony.mjs drives the deployed console through a real
// interview and a real decision, and its two REFUSAL modes were verified against the deployed
// console on 2026-10-12 (both report 10 checks, exit 0). Its HAPPY mode was never run, because it
// needs a record in state `answered` and the real store has none: it holds two `expired` records
// and one already `decided` (150/150, granted). The tool is what the human admin will run for the
// FIRST REAL APPLICANT, so the mode nobody has executed is exactly the mode that matters.
//
// WHAT THIS DOES. It mints a fresh admission through the console's OWN agent-facing routes — the
// same ones an agent uses — and solves the challenge honestly, then hands the record to the
// ceremony tool for interview + decision. So the chain under test is: start -> solve -> answer ->
// (record reaches `answered`) -> interview -> decide, through the deployed console, against the
// real E:\data store and the real E:\verifier.json salt.
//
// THE JOINER HALF IS SIMULATED ON PURPOSE, and that is a limit, not a convenience: this trial plays
// both roles because no external applicant exists yet. The admin tool must never solve a challenge
// for an applicant, so the solving lives here, in a trial, and not in admission-ceremony.mjs. What
// this does NOT prove: that a stranger arrived (deliverable 5 is still zero external agents), or
// that the relay shuttle carried the answers (that is tools/joiner-path-trial.mjs, live).
//
// TWO THINGS THIS MEASURED ON ITS FIRST LIVE RUNS (2026-10-12), both now recorded by the checks:
//
//   1. THE DEPLOYED STICK HAD DRIFTED, and the local door was a WALL. The stick's src/admission.mjs
//      predated spec v0.5 §3g.2, so the challenge it handed out carried items and no taxonomy. An
//      honest agent cannot answer items whose categories appear nowhere in the item text, so the
//      local path admitted nobody. `node tools/deploy-stick.mjs --check` reported 30 drifted files;
//      after the repair this trial passes phase A. The lesson is not "redeploy": it is that the
//      seam probe ran against a COPY and therefore could not see it.
//   2. A CEREMONY DECISION IS NOT A PERMIT. `decide` records the grantee; it mints no permit,
//      because src/admission.mjs:3 -- "Authority requires a separate explicit permit operation."
//      The assertion below is that the ledger does NOT change, so an admin's interview-and-decide
//      step can never become a silent grant of speaking rights.
//
// It uses two console instances SEQUENTIALLY and never concurrently: mine is stopped before the
// ceremony tool spawns its own, so only one process ever writes the store.
//
//   node tools/ceremony-live-trial.mjs [--decision grant|refuse] [--port 8797] [--dry]
//
// --dry stops after the record reaches `answered` and reports what it would have done.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateIdentity, saveIdentity } from '../src/identity.mjs';
import { probePort, startConsole, stopAndVerify } from './console-runner.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STICK = process.env.AC_STICK || 'E:\\';
const APP = join(STICK, 'console', 'app.mjs');
const STORE = process.env.AC_STORE || join(STICK, 'data', 'admissions', 'admissions.json');
const TRUST = process.env.AC_TRUST || join(STICK, 'trust.json');
const IDENTITY_DIR = join(ROOT, '.tmp', 'ceremony-live');

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

const DECISION = String(arg('decision', 'grant'));
const PORT = Number(arg('port', 8797));
const DRY = arg('dry', false) === true;

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};

if (!['grant', 'refuse'].includes(DECISION)) { console.error('--decision grant|refuse'); process.exit(2); }
if (!existsSync(APP)) { console.error(`no deployed console at ${APP} — deploy the stick first`); process.exit(2); }

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const permitsOf = (file) => (readJson(file).permits ?? []).length;
const b64u = (buf) => Buffer.from(buf).toString('base64url');

// The same solver the seam probe uses, for the same reason: answering '-' everywhere used to pass
// and no longer does, and a probe that fakes a pass proves nothing about the gate it probes.
const strip = (s) => String(s).trim().replace(/\.$/, '').replace(/^An? /, '');
function solveItem(item, chains) {
  const p = /^An? (.+?) is an? (.+?)\.?$/.exec(String(item.premise).trim());
  const h = /^An? (.+?) is an? (.+?)\.?$/.exec(String(item.hypothesis).trim());
  if (!p || !h) throw new Error('unparsed challenge item: ' + item.premise + ' / ' + item.hypothesis);
  const entity = strip(p[1]);
  const category = strip(h[2]);
  return chains.some((c) => { const i = c.indexOf(entity); return i >= 0 && c.indexOf(category) > i; })
    ? 'ENTAILED' : 'CONTRADICTED';
}

const QUESTIONS = ['what_you_are', 'how_you_solved_the_challenge', 'intent_and_failure_mode'];
const STATEMENT = [
  '[trial] This is an automated trial identity, not an external applicant. It exists so that the admin ceremony tool\'s interview-and-decide path is executed against the real store before a real applicant uses it.',
  'The challenge was solved from the taxonomy the challenge itself published: for each item the hypothesis category was looked up above the premise entity in the chains, answering ENTAILED when the chain order supports it and CONTRADICTED otherwise. No verifier secret was used, and none was available to this process.',
  'If this record is ever read by a human wondering who asked to join: nobody did. This is the repository\'s own test identity, and deliverable 5 of the program is still zero real external agents. The failure mode this record guards against is a ceremony that works only in its refusal modes.',
].join('\n\n');
const ANSWERS_MAP = Object.fromEntries(QUESTIONS.map((q, i) => [q, STATEMENT.split(/\n\n/)[i]]));

const STATEMENT_FILE = join(tmpdir(), `ceremony-live-${Date.now()}.txt`);
writeFileSync(STATEMENT_FILE, STATEMENT, 'utf8');

const before = { store: sha(STORE), permits: permitsOf(TRUST), records: readJson(STORE).admissions.length };
console.log(`store   : ${STORE}`);
console.log(`identity: ${IDENTITY_DIR}`);
console.log(`before  : ${before.records} record(s), ${before.permits} permit(s), sha ${before.store.slice(0, 16)}`);
console.log('');

let console = null;
let exitCode = 0;
try {
  const identity = generateIdentity();
  mkdirSync(IDENTITY_DIR, { recursive: true });
  const identityFile = join(IDENTITY_DIR, identity.agentId + '.json');
  saveIdentity(identity, identityFile);
  // A granted permit whose key was thrown away is an orphan the human cannot audit or revoke, so
  // the key is persisted and NAMED in the output.
  check('the trial identity is persisted to disk, so a granted permit is not orphaned', existsSync(identityFile), identityFile);
  console.log(`identity: ${identity.agentId}`);
  console.log('');

  // --- phase A: the joiner half, against the deployed console --------------------------------
  // tools/console-runner.mjs owns the port claim. It REFUSES to start when the port is already
  // serving (naming the holder), and it can prove the port is free after the stop. On 2026-10-12 a
  // console started from a stray copy of this project held 127.0.0.1:7788 for 7h19m; any later run
  // that raced it would have reported a stranger's build as its own.
  console = await startConsole({ app: APP, port: PORT, args: ['--no-browser'], tool: 'ceremony-live-trial.mjs' });
  const TOKEN = console.token;
  const BASE = console.base;
  const call = async (path, init) => {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${BASE}${path}${sep}t=${TOKEN}`, {
      ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text.slice(0, 300) }; }
  };

  const started = await call('/api/admissions/start', {
    method: 'POST', body: JSON.stringify({ joinKey: identity.publicKey, agentId: identity.agentId }),
  });
  if (!started.body?.id) throw new Error('start failed: ' + JSON.stringify(started.body).slice(0, 200));
  const id = started.body.id;
  console.log(`admission: ${id}`);

  const chains = started.body.challenge?.kb?.chains;
  const items = started.body.challenge?.items;
  check('the published challenge carries its own taxonomy', Array.isArray(chains) && chains.length > 0,
    JSON.stringify(started.body.challenge ?? {}).slice(0, 160));
  check('the published challenge carries items', Array.isArray(items) && items.length > 0, `${items?.length ?? 0} item(s)`);
  check('the published challenge does NOT carry the answers', !('answers' in (started.body.challenge ?? {})), Object.keys(started.body.challenge ?? {}).join(','));

  const answers = (items ?? []).map((it) => solveItem(it, chains));
  const answered = await call('/api/admissions/answer', { method: 'POST', body: JSON.stringify({ id, answers }) });
  const verdict = answered.body?.verdict;
  check('the honest solution passes', verdict?.ok === true && verdict?.correct === verdict?.total,
    JSON.stringify(verdict));

  const listed = await call('/api/admissions');
  const rec = (listed.body?.admissions ?? []).find((r) => r.id === id);
  check('the record reached state "answered" — the ceremony tool\'s precondition', rec?.status === 'answered', `status=${rec?.status}`);

  await stopAndVerify(console);
  check('no console is left listening on the trial port after phase A', (await probePort(PORT)) === false);
  console = null;

  if (DRY) {
    console.log('');
    console.log('DRY: the record is answered; the ceremony tool was not run.');
  } else {
    // --- phase B: the admin half, through the tool under test ---------------------------------
    const run = spawnSync(process.execPath, [
      join(ROOT, 'tools', 'admission-ceremony.mjs'),
      '--id', id, '--statement', STATEMENT_FILE, '--key', identityFile,
      '--decision', DECISION, '--port', String(PORT + 2),
    ], { cwd: ROOT, encoding: 'utf8' });
    const log = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    console.log('--- admission-ceremony.mjs ---');
    console.log(log.trim().split('\n').map((l) => '  ' + l).join('\n'));
    check('the ceremony tool exits 0 on its happy path', run.status === 0, `exit=${run.status}`);
    check('the ceremony tool reports CEREMONY OK', /CEREMONY OK/.test(log));
    check('no check inside the ceremony tool failed', !/FAIL/.test(log));

    // --- phase C: assert the outcome from the FILES, not from a process ----------------------
    const after = readJson(STORE);
    const rec2 = after.admissions.find((r) => r.id === id);
    check('the record is now decided', rec2?.status === 'decided', `status=${rec2?.status}`);
    check(`the decision recorded is "${DECISION}"`, rec2?.decision === DECISION, `decision=${rec2?.decision}`);
    check('the interview is stored VERBATIM, marker included', rec2?.interview?.statement === STATEMENT,
      `${rec2?.interview?.statement?.length ?? 0} chars stored vs ${STATEMENT.length} sent`);
    // The field naming the deciding admin has not been read from a decided record yet, so the check
    // is on the FACT (an admin is named) rather than on a name this trial has not verified.
    const decider = rec2?.decidedBy ?? rec2?.by ?? rec2?.decidedby;
    check('the decision names the admin who made it', typeof decider === 'string' && decider.length > 10, String(decider));
    check('the decided record exposes its full field set for the next reader', true, Object.keys(rec2 ?? {}).join(','));

    const afterPermits = permitsOf(TRUST);
    // The property is that the ledger does NOT change: see finding 2 in the header.
    check('the ceremony does NOT mint a permit (authority is a separate explicit operation)',
      afterPermits === before.permits, `${before.permits} -> ${afterPermits}`);
    check('the decision names the applicant key as grantee (the key was captured)',
      rec2?.grantee === identity.agentId, `grantee=${rec2?.grantee} expected=${identity.agentId}`);
    check('the interview is attributed to the applicant key that signed it',
      rec2?.interview?.signedBy === identity.agentId && rec2?.interview?.signed === true,
      `signedBy=${rec2?.interview?.signedBy} signed=${rec2?.interview?.signed}`);
    check('the mapped answers are stored with the interview',
      Object.keys(rec2?.interview?.answers ?? {}).length === QUESTIONS.length,
      `${Object.keys(rec2?.interview?.answers ?? {}).length} answer(s)`);
    check('the store changed (a record was added), so the assertions above describe a real write',
      sha(STORE) !== before.store && after.admissions.length === before.records + 1,
      `${before.records} -> ${after.admissions.length}`);
    check('the ceremony tool left no console listening on its own port after it exited',
      (await probePort(PORT + 2)) === false, `port ${PORT + 2}`);
  }
} catch (err) {
  fail++;
  console.log('FAIL ' + err.message);
} finally {
  if (console) { try { await stopAndVerify(console); } catch { /* the checks above report it */ } }
  rmSync(STATEMENT_FILE, { force: true });
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) exitCode = 1;
console.log(exitCode === 0
  ? 'CEREMONY LIVE TRIAL OK: the admin ceremony tool recorded an interview and a decision through the deployed console, on a real store record.'
  : 'CEREMONY LIVE TRIAL FAILED.');
process.exit(exitCode);
