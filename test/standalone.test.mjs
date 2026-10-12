// Agent Commons — the standalone entry point, tested as a PROCESS.
//
// Why this file exists. The server had this guard:
//
//     if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) { ... }
//
// On Windows that is ALWAYS false: import.meta.url is `file:///C:/...` (three
// slashes) and the template produces `file://C:/...`. So the block never ran,
// the process exited 0, and `npm run serve` looked successful while the port
// stayed dead and silent.
//
// No in-process test can catch that. `createCommonsServer()` works perfectly —
// the discovery and e2e suites cover it — because they call it directly and
// never touch the guard. The defect lives strictly in "does the program, when
// launched the way a user launches it, actually serve?". So this test launches
// it as a real child process and insists that it answers.
//
// Run: node test/standalone.test.mjs

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

import { verifyDiscovery } from '../src/discovery.mjs';

// COMMONS_SERVER exists only so the negative control can point this test at a
// deliberately-broken copy of the server and prove the test actually fails.
const SERVER = process.env.COMMONS_SERVER || fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const BASE = join(import.meta.dirname, '..', '.tmp', `standalone-${Date.now()}`);
mkdirSync(BASE, { recursive: true });

let n = 0;
const pass = (s) => { n++; console.log(`PASS ${s}`); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [SERVER, '--dir', join(BASE, 'node'), '--port', String(port)], {
    stdio: 'ignore', // no pipes: keep this working under any file-sandbox mode
    windowsHide: true,
  });

  let exitedEarly = null;
  child.on('exit', (code) => { exitedEarly = code; });

  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await sleep(150);
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) up = true;
    } catch { /* not up yet */ }
  }

  try {
    if (!up) {
      // This is the exact signature of the Windows main-guard bug: exit code 0,
      // no error, no output, and nothing listening.
      assert.fail(
        exitedEarly === 0
          ? 'the server exited 0 without ever listening — the main-module guard is broken again (see the comment at the top of this file)'
          : `the server never answered on ${base}/health (exitedEarly=${exitedEarly})`,
      );
    }
    pass('the standalone entry point actually serves when launched as a process');

    assert.equal(exitedEarly, null, 'the server must still be running while it serves');
    pass('it stays running rather than exiting after binding');

    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true, `health must report ok, got ${JSON.stringify(health)}`);
    pass('health reports ok');

    const wk = await (await fetch(`${base}/.well-known/agent-commons.json`)).json();
    const verdict = verifyDiscovery(wk);
    assert.equal(verdict.ok, true, `discovery must validate: ${JSON.stringify(verdict)}`);
    assert.equal(verdict.signed, true, 'the standalone node publishes a signed document');
    pass('the standalone server serves a signed discovery document');

    const list = await (await fetch(`${base}/messages?since=0`)).json();
    assert.ok(Array.isArray(list.messages), 'the message feed must be a list');
    pass('the message feed is served');

    console.log(`\n${n} assertions passed.`);
  } finally {
    child.kill();
    await sleep(200);
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  }
}

main().catch((err) => {
  console.error('\nFAIL:', err?.message || err);
  process.exit(1);
});
