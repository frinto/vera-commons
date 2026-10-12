// Live probe: can an agent actually bind itself to an admission on the DEPLOYED console?
//
// This deliberately uses a SCRATCH admission, never a real candidate's. Binding is the one step
// that must be performed by the key's owner: if the verifier binds on the agent's behalf, the
// verifier is the identity, and the whole binding proves nothing. So this probe creates its own
// throwaway record to exercise the plumbing, and leaves real candidates alone.
//
//   node tools/binding-live-probe.mjs
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STICK = process.env.AC_STICK || 'E:\\';
const PORT = Number(process.env.AC_PORT || 8798);
const APP = join(STICK, 'console', 'app.mjs');

let failures = 0;
function check(ok, label, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ': ' + detail : ''}`);
}

if (!existsSync(APP)) { console.error(`no deployed console at ${APP}`); process.exit(2); }

const WORK = mkdtempSync(join(tmpdir(), 'ac-bind-'));
const KEY_FILE = join(WORK, 'probe-agent.json');

const child = spawn(process.execPath, [APP, '--port', String(PORT), '--no-browser'], {
  cwd: dirname(APP), stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
const tokenReady = new Promise((res) => {
  const onData = (c) => { out += String(c); const m = /\?t=([A-Za-z0-9_-]{10,})/.exec(out); if (m) res(m[1]); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  setTimeout(() => res(null), 20000);
});

function runJoinBind(extra = []) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [join(ROOT, 'tools', 'join-bind.mjs'), '--id', ADMISSION_ID, '--key', KEY_FILE,
      '--console', `http://127.0.0.1:${PORT}`, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    p.stdout.on('data', (c) => { text += String(c); });
    p.stderr.on('data', (c) => { text += String(c); });
    p.on('close', (code) => res({ code, text }));
  });
}

let ADMISSION_ID = null;
let exitCode = 0;
try {
  const TOKEN = await tokenReady;
  if (!TOKEN) throw new Error('the console never printed a token: ' + out.slice(-300));
  const BASE = `http://127.0.0.1:${PORT}`;
  const call = async (path, init) => {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${BASE}${path}${sep}t=${TOKEN}`, {
      ...init, headers: { 'content-type': 'application/json' },
    });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 200); }
    return { status: res.status, body: parsed };
  };

  check((await call('/')).status === 200, 'the deployed console is serving');

  // --- scratch admission, started WITHOUT a key so there is something to bind --------
  const started = await call('/api/admissions/start', {
    method: 'POST',
    body: JSON.stringify({ joinKey: 'binding-probe-' + Date.now() }),
  });
  check(started.status === 200, 'a scratch admission was issued', `HTTP ${started.status}`);
  ADMISSION_ID = started.body?.id;
  check(typeof ADMISSION_ID === 'string' && ADMISSION_ID.length > 0, 'the scratch admission has an id', String(ADMISSION_ID));

  const before = await call('/api/admissions');
  const recBefore = (before.body?.admissions ?? []).find((r) => r.id === ADMISSION_ID);
  check(recBefore?.bound === false, 'the scratch admission starts UNBOUND', `bound=${recBefore?.bound}`);

  // --- the agent binds itself --------------------------------------------------------
  const first = await runJoinBind();
  check(first.code === 0, 'tools/join-bind.mjs exited 0', `exit ${first.code}`);
  check(/BOUND OK/.test(first.text), 'it reported BOUND OK', first.text.trim().split('\n').slice(-1)[0]);

  const after = await call('/api/admissions');
  const recAfter = (after.body?.admissions ?? []).find((r) => r.id === ADMISSION_ID);
  check(recAfter?.bound === true, 'the record is now BOUND', `bound=${recAfter?.bound}`);
  check(typeof recAfter?.agentId === 'string' && recAfter.agentId.length === 43, 'the bound key is recorded', String(recAfter?.agentId));

  // The key file must exist and must not be re-generated on the second run: an agent that
  // silently gets a NEW identity on a retry has lost the ability to prove anything.
  const key1 = JSON.parse((await import('node:fs')).readFileSync(KEY_FILE, 'utf8')).agentId;

  const second = await runJoinBind();
  check(second.code === 0, 'a SECOND bind attempt exits 0 (already_bound is not an error)', `exit ${second.code}`);
  check(/already bound/.test(second.text), 'the second attempt reports the admission was already bound');
  const key2 = JSON.parse((await import('node:fs')).readFileSync(KEY_FILE, 'utf8')).agentId;
  check(key1 === key2, 'the key file is REUSED, not regenerated, on retry', `${key1.slice(0, 8)} vs ${key2.slice(0, 8)}`);

  const afterAgain = await call('/api/admissions');
  const recFinal = (afterAgain.body?.admissions ?? []).find((r) => r.id === ADMISSION_ID);
  check(recFinal?.agentId === key1, 'the bound key was NOT replaced by the second attempt', `${String(recFinal?.agentId).slice(0, 8)} vs ${key1.slice(0, 8)}`);
} catch (err) {
  failures++;
  console.log(`  FAIL ${err.message}`);
} finally {
  try { child.kill(); } catch { /* gone */ }
  try { rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log('');
if (failures === 0) {
  console.log('BINDING LIVE OK: an agent can bind itself on the deployed console, once, and cannot be displaced.');
} else {
  console.log(`BINDING LIVE FAILED: ${failures} check(s) failed.`);
  exitCode = 1;
}
process.exit(exitCode);
