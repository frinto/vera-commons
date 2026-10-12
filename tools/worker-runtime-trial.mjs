#!/usr/bin/env node
/**
 * Run the Worker on the REAL workerd runtime, as part of `npm test`.
 *
 * WHY THIS EXISTS — a measured gap, not a hypothetical one:
 *   `npm test` runs test/worker.test.mjs, which imports worker.js into Node and exercises its
 *   logic. That is worth having, and it proves nothing about whether the Worker can START.
 *   The two are genuinely different questions, and the difference cost real time: worker.js
 *   exported a plain string constant, and a Worker entry module may only export its handler,
 *   so workerd refused to start the service ("Incorrect type for map entry 'SPEC_SHA256'").
 *   Every Node-side test passed the whole time. It was that way from the initial import until
 *   it was found by accident.
 *
 * So this script is the bridge: it starts the Worker under workerd, waits for it to answer,
 * and asserts real behaviour against real KV.
 *
 * ★ THE EXIT-CODE CONTRACT, AND WHY IT IS THE WHOLE POINT:
 *   tools/verify-worker-local.ps1 distinguishes three outcomes:
 *     0 = every check passed
 *     1 = the runtime came up but a check failed
 *     2 = THE RUNTIME NEVER CAME UP
 *   Exit 2 is exactly how the export defect presented. Treating "the runtime never started"
 *   as a skip — or as anything other than a failure — would reproduce the original bug in the
 *   harness built to catch it. It is reported as a failure here, loudly, with the reason.
 *
 * PORTABILITY, stated rather than hidden: the underlying verification is a PowerShell script,
 * so on non-Windows platforms this step SKIPS and says so. That is a real coverage gap on those
 * platforms, not a pass, and it is printed as such. Windows is the deployment target and the
 * platform where every measurement in this project was taken.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SCRIPT = join(HERE, 'verify-worker-local.ps1');

if (process.platform !== 'win32') {
  console.log('worker runtime trial: SKIPPED — the runtime check is a PowerShell script.');
  console.log('  This is a COVERAGE GAP on this platform, not a pass: on a non-Windows host the');
  console.log('  Worker is never started during npm test, so a "cannot start" defect would not be');
  console.log('  caught here. Windows is where this project is measured and deployed.');
  process.exit(0);
}

if (!existsSync(SCRIPT)) {
  console.error(`worker runtime trial: FAIL — ${SCRIPT} is missing.`);
  console.error('  The runtime check is part of the suite; its absence must not read as success.');
  process.exit(1);
}

// stdio: 'inherit' on purpose. The suite's own output is the evidence, and piping it would both
// hide it and (in a sandboxed runner) break the spawn outright.
const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env,
});

if (r.error) {
  console.error(`worker runtime trial: FAIL — could not launch the runtime check: ${r.error.message}`);
  process.exit(1);
}

const code = r.status;
if (code === 0) {
  console.log('worker runtime trial: PASS — the Worker started under workerd and answered.');
  process.exit(0);
}
if (code === 2) {
  console.error('');
  console.error('worker runtime trial: FAIL — THE RUNTIME NEVER CAME UP (exit 2).');
  console.error('  This is not a skip and not an environment quirk to be waved through. It is how a');
  console.error('  "cannot start" defect presents, and the historical example is worker.js exporting');
  console.error('  a plain string: a Worker entry module may only export its handler, so workerd');
  console.error('  refused to start and every Node-side test still passed.');
  console.error('  Read worker/wrangler.dev.err for the runtime\'s own message.');
  process.exit(1);
}
console.error(`worker runtime trial: FAIL — the runtime came up but a check failed (exit ${code}).`);
process.exit(1);
