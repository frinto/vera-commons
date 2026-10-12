/**
 * tools/console-runner.mjs — one console at a time, always attributed, always stopped.
 *
 * WHY THIS EXISTS (measured 2026-10-12). A console process started from a STALE copy of this project
 * on the stick (E:\AgentCommons\app.mjs) held 127.0.0.1:7788 for 7h19m after the round that started it
 * had moved on. Nothing noticed: every console-booting tool spawns its child, reads the token from
 * stdout, and hopes. A listener that is ALREADY there does not stop the spawn -- on Windows two
 * processes can hold the same port -- so a later run can talk to a stranger's console and report the
 * result as its own. The per-run token on stdout is what keeps that from being SILENT. This module is
 * what makes it LOUD, and leaves a record of who started what:
 *
 *   1. assertPortFree(port) BEFORE spawn -- a live listener, or a lock whose pid is still alive, is a
 *      refusal that names the holder instead of a race.
 *   2. a lock file at .tmp/console-locks/<port>.json recording tool, pid, app and start time.
 *   3. stop() that waits for the process to actually exit, clears the lock, and can PROVE the port was
 *      released (assertNoListener), so a leak is a failed check rather than a mystery.
 *
 * A tool using this module can still leak its own logic. It cannot leak a listener.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');
export const LOCK_DIR = join(ROOT, '.tmp', 'console-locks');

/** True when something answers on 127.0.0.1:<port>. A connect (not a bind) is the honest test: it is
 *  exactly what a later fetch would do. */
export const probePort = (port, timeoutMs = 800) => new Promise((done) => {
  const s = createConnection({ host: '127.0.0.1', port });
  let settled = false;
  const finish = (v) => {
    if (settled) return;
    settled = true;
    try { s.destroy(); } catch { /* already closed */ }
    done(v);
  };
  s.setTimeout(timeoutMs);
  s.once('connect', () => finish(true));
  s.once('timeout', () => finish(false));
  s.once('error', () => finish(false));
});

export const lockPath = (port) => join(LOCK_DIR, `${port}.json`);

export function readLock(port) {
  const p = lockPath(port);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { unreadable: true, path: p }; }
}

export function listLocks() {
  if (!existsSync(LOCK_DIR)) return [];
  return readdirSync(LOCK_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(readFileSync(join(LOCK_DIR, f), 'utf8')); } catch { return { unreadable: true, file: f }; } });
}

/** process.kill(pid, 0) is the portable liveness probe; EPERM means it exists but is not ours. */
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function describeHolder(port) {
  const l = readLock(port);
  if (!l) return 'no lock file: nothing in this repo claims it';
  if (l.unreadable) return `an unreadable lock file at ${l.path}`;
  const alive = pidAlive(l.pid);
  return `locked by ${l.tool} (pid ${l.pid}, started ${l.startedAt}, app ${l.app})${alive ? '' : ' -- that pid is GONE, so this lock is stale'}`;
}

/** Throws -- with attribution -- when the port is not ours to take. Clears a lock whose pid is dead. */
export async function assertPortFree(port, { tool = 'unknown' } = {}) {
  const listening = await probePort(port);
  const lock = readLock(port);
  if (lock && !lock.unreadable && pidAlive(lock.pid)) {
    throw new Error(`port ${port} is held by a live console: ${describeHolder(port)}. Refusing to start ${tool}: it would either fail to bind or race the holder for the socket. Stop that console first.`);
  }
  if (listening) {
    throw new Error(`port ${port} is SERVING something, and ${describeHolder(port)}. Refusing to start ${tool}: a listener nothing here started is how a run silently reports a stranger's build as its own.`);
  }
  // Nothing is listening and no live pid owns it: a leftover lock is debris, not a claim.
  if (lock) rmSync(lockPath(port), { force: true });
  return true;
}

/** Spawn a console, claim the port, and wait for the token it prints. Throws (and cleans up) on timeout. */
export async function startConsole({ app, port, args = [], cwd, tool = 'unknown', readyTimeoutMs = 20000 }) {
  await assertPortFree(port, { tool });
  mkdirSync(LOCK_DIR, { recursive: true });
  const child = spawn(process.execPath, [app, '--port', String(port), ...args], {
    cwd: cwd ?? dirname(app),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  writeFileSync(lockPath(port), JSON.stringify({
    pid: child.pid, port, tool, app, startedAt: new Date().toISOString(),
  }, null, 1));
  let out = '';
  const token = await new Promise((done) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; done(v); } };
    const onData = (c) => {
      out += String(c);
      const m = /\?t=([A-Za-z0-9_-]{10,})/.exec(out);
      if (m) finish(m[1]);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', () => finish(null));
    setTimeout(() => finish(null), readyTimeoutMs);
  });
  const handle = {
    child, port, tool, app, token, base: `http://127.0.0.1:${port}`,
    get out() { return out; },
    startedAt: new Date().toISOString(),
  };
  if (!token) {
    await stopConsole(handle);
    throw new Error(`${tool}: the console on port ${port} never printed a token: ${out.slice(-400)}`);
  }
  return handle;
}

/** Kill it, wait for the process to really exit, clear the lock. Safe to call twice. */
export async function stopConsole(handle, { timeoutMs = 4000 } = {}) {
  if (!handle) return true;
  const { child, port } = handle;
  if (child && child.exitCode === null) {
    try { child.kill(); } catch { /* already gone */ }
    const exited = await new Promise((done) => {
      if (child.exitCode !== null) return done(true);
      const t = setTimeout(() => done(false), timeoutMs);
      child.once('exit', () => { clearTimeout(t); done(true); });
    });
    if (!exited) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  if (port) rmSync(lockPath(port), { force: true });
  return true;
}

/** True only if nothing is listening any more. The post-run half of the contract. */
export async function assertNoListener(port, tool = 'unknown') {
  if (await probePort(port)) {
    throw new Error(`after ${tool} finished, port ${port} is STILL serving: something it started outlived it`);
  }
  return true;
}

/** stopConsole + the proof, in one call, for tools that want the whole contract. */
export async function stopAndVerify(handle, opts = {}) {
  const port = handle?.port;
  const tool = handle?.tool ?? opts.tool ?? 'unknown';
  await stopConsole(handle, opts);
  if (port) await assertNoListener(port, tool);
  return true;
}
