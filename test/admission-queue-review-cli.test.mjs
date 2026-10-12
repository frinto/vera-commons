// The admission queue review CLI -- the path a HUMAN runs when deciding a real applicant.
//
// Why this file exists: the tool's functions are unit-tested, but nothing ran its command-line path,
// and that is where the contract that matters lives. The one wrong answer here is a real applicant
// silently reported as "no real applicants waiting", so the rule under test is:
//   a read that did not actually happen must FAIL, never render as an empty queue.
//
// Every case points the tool at a LOCAL server, so this test needs no network, no real relay and no
// real operator secret. The 200-without-a-requests-array case is deliberately included: it is the
// shape that used to slip past the 401 guard.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(ROOT, 'tools', 'admission-queue-review.mjs');
const REAL_ID = 'req-real-applicant';
const TRIAL_ID = 'req-our-own-trial';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

// One canned answer, then one run of the CLI against it.
async function runCli({ body, status = 200, secret = 'test-token', args = ['--json'] }) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-review-cli-'));
  const secretFile = join(dir, 'operator-secret.txt');
  // The no-secret case must point at a path that CANNOT exist, or the run would fall back to the
  // operator's real secret file and test the wrong branch.
  if (secret !== null) writeFileSync(secretFile, `${secret}\n`, 'utf8');
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization ?? null });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = {
    ...process.env,
    COMMONS_URL: `http://127.0.0.1:${server.address().port}`,
    AC_OPERATOR_SECRET_FILE: secret === null ? join(dir, 'does-not-exist.txt') : secretFile,
  };
  // NOT spawnSync. It blocks this process's event loop, and the fixture server lives in this same
  // process, so the child's request could never be answered: a deadlock that HANGS the test instead
  // of failing it (measured -- the first block passed only because it exits before any HTTP call).
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [TOOL, ...args], { cwd: ROOT, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    // A hung tool must fail the test, not stall the suite: no fetch timeout exists in the tool.
    const timer = setTimeout(() => child.kill(), 20000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, out, err }); });
  });
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
  return { ...r, seen };
}

const FIXTURE = {
  requests: [
    { requestId: REAL_ID, note: 'I am a research agent, may I join?', at: 1750000000000 },
    { requestId: TRIAL_ID, note: '[trial] joiner-path-trial', at: 1750000001000 },
  ],
};
// A queue is only "empty" when the route SAID so. Absent, null and non-array are all "did not read".
const notAQueue = [
  ['a body with no requests field at all', {}],
  ['a body whose requests field is null', { requests: null }],
  ['a body whose requests field is a string', { requests: 'nope' }],
];

console.log('admission-queue-review CLI');

// --- 1. the guards that already exist, pinned so they cannot regress ---------------------------
{
  const r = await runCli({ body: FIXTURE, secret: null });
  check('a missing operator secret exits 2', r.status === 2, `status=${r.status}`);
  check('...names the 401 it would otherwise get', /401/.test(r.err), r.err.trim());
  check('...and prints no queue at all', !r.out.includes('"total"') && !r.out.includes('waiting'),
    `stdout=${JSON.stringify(r.out.slice(0, 120))}`);
  check('...and never reaches the relay', r.seen.length === 0, `requests seen=${r.seen.length}`);
}
{
  const r = await runCli({ body: { requests: [] }, status: 401 });
  check('an unauthorised read exits 2 rather than reporting an empty queue', r.status === 2,
    `status=${r.status} stdout=${JSON.stringify(r.out.slice(0, 120))}`);
  check('an unauthorised read is not rendered as zero waiting', !r.out.includes('"total"')
    && !r.out.includes('waiting'), `stdout=${JSON.stringify(r.out.slice(0, 120))}`);
}

// --- 2. a read that DID happen, and the judgement the human relies on ---------------------------
{
  const r = await runCli({ body: FIXTURE });
  let parsed = null;
  try { parsed = JSON.parse(r.out); } catch { /* left null, reported below */ }
  check('a healthy read exits 0', r.status === 0, `status=${r.status} err=${r.err.trim()}`);
  check('the real applicant is reported as real', parsed?.real === 1, JSON.stringify(parsed?.total));
  check('our own trial debris is separated, not counted as an applicant', parsed?.trials === 1);
  check('the real applicant survives to the output by id',
    JSON.stringify(parsed?.rows ?? []).includes(REAL_ID));
  check('it actually asked the operator route for the queue',
    r.seen.length === 1 && /\/admission\/requests/.test(r.seen[0].url ?? ''), JSON.stringify(r.seen));
  check('...and authenticated with the operator secret',
    r.seen[0]?.auth === 'Bearer test-token', JSON.stringify(r.seen[0]?.auth));
}
{
  const r = await runCli({ body: FIXTURE, args: [] });   // the human-readable path
  check('the human path names the real applicant count', /REAL APPLICANTS: 1/.test(r.out), r.out.slice(0, 200));
  check('the human path shows the applicant id a human must act on', r.out.includes(REAL_ID));
}

// --- 3. the hole: a 200 that is not a queue ----------------------------------------------------
for (const [label, body] of notAQueue) {
  const r = await runCli({ body });
  check(`${label} FAILS instead of reporting an empty queue`, r.status === 2,
    `status=${r.status} stdout=${JSON.stringify(r.out.slice(0, 160))}`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
