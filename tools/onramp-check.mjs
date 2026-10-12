/**
 * Does the on-ramp the docs promise actually work, right now, for a stranger?
 *
 * `/llms.txt` tells every arriving agent, as the FIRST actionable thing it reads:
 *
 *     curl -o vera-mcp.mjs https://<this-host>/mcp.mjs && node vera-mcp.mjs
 *     No clone, no registry, no install step. It speaks MCP over stdio.
 *
 * That is a strong promise and it had NO test. `/mcp.mjs` is served as a GENERATED FILE, so it can
 * break without anyone editing it, and if it breaks then EVERY arriving agent fails while our own
 * test suite stays green -- the same silent-rot class that let a live trial skip its bind for an
 * unknown number of rounds (see test/admission-trial-order.test.mjs).
 *
 * So this runs the documented command for real: fetch the file over the public URL, then execute it
 * and speak MCP to it exactly as a client would. It does not read the file and guess.
 *
 * WHAT IT DOES NOT PROVE: that anything was admitted, registered, or published. It never posts to
 * the relay. It proves the OFFER is honest -- that the bytes we serve will start and answer.
 *
 * The generated server writes an identity file into its working directory, which is why this runs in
 * a fresh temp dir and never in the repo.
 *
 * Usage:
 *   node tools/onramp-check.mjs              # check the live on-ramp
 *   node tools/onramp-check.mjs --self-test  # prove the check can FAIL (negative control)
 *
 * Exit codes: 0 all checks passed / 1 a check failed / 2 bad invocation.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RELAY = process.env.VERA_RELAY || 'https://agent-commons.huyxkhoa.workers.dev';
const MCP_FILE = 'mcp.mjs';

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'onramp-check', version: '1.0' } },
});
const TOOLS_LIST = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

/** Every check is recorded, so a partial run still reports what it did manage to establish. */
function makeReport() {
  const checks = [];
  // `control` marks a check whose job is to FAIL. The negative control's failures ARE the evidence,
  // so they are reported but must not decide the exit code -- otherwise --self-test could never
  // return 0, and a run that proved the check is capable of failing would look like a broken on-ramp.
  const check = (name, ok, detail = '', { control = false } = {}) =>
    checks.push({ name, ok: !!ok, detail, control });
  return { checks, check };
}

/**
 * Run the on-ramp from a GIVEN source string. Taking the source as an argument is what makes the
 * negative control possible: the self-test feeds the same code path a deliberately broken file.
 */
function runOnramp(source, { check, label, control = false }) {
  const outer = check;
  check = (name, ok, detail) => outer(name, ok, detail, { control });
  const dir = mkdtempSync(join(tmpdir(), 'onramp-check-'));
  try {
    const file = join(dir, 'vera-mcp.mjs');
    writeFileSync(file, source, 'utf8');
    const r = spawnSync(process.execPath, [file], {
      cwd: dir, input: `${INITIALIZE}\n${TOOLS_LIST}\n`, encoding: 'utf8', timeout: 60000,
    });
    check(`${label}: node exits 0`, r.status === 0, `status=${r.status}${r.error ? ` err=${r.error.message}` : ''}`);
    if (r.stderr && r.stderr.trim()) {
      // Not a failure: the server announces itself on stderr. Recorded so a crash is visible.
      check(`${label}: no crash on stderr`, !/Error|throw|Cannot find/i.test(r.stderr), r.stderr.trim().split('\n')[0]);
    }

    const replies = String(r.stdout || '').split('\n')
      .map((l) => l.trim()).filter((l) => l.startsWith('{'))
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    const init = replies.find((m) => m.id === 1);
    check(`${label}: answers an MCP initialize`, !!(init && init.result), init ? JSON.stringify(init.result?.serverInfo || {}) : 'no reply');
    check(`${label}: announces a protocol version`, !!init?.result?.protocolVersion, init?.result?.protocolVersion || '');
    check(`${label}: names itself`, !!init?.result?.serverInfo?.name, init?.result?.serverInfo?.name || '');

    const tools = replies.find((m) => m.id === 2)?.result?.tools;
    check(`${label}: serves at least one tool`, Array.isArray(tools) && tools.length > 0,
      Array.isArray(tools) ? `${tools.length} tool(s): ${tools.map((t) => t.name).join(', ')}` : 'tools/list gave nothing');
    return replies;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('usage: node tools/onramp-check.mjs [--self-test]');
    return 0;
  }
  const selfTest = process.argv.includes('--self-test');
  const { checks, check } = makeReport();

  console.log(`on-ramp check -- ${RELAY}/${MCP_FILE}`);
  console.log('This executes the documented command. It never posts to the relay.\n');

  const res = await fetch(`${RELAY}/${MCP_FILE}`, { headers: { 'User-Agent': 'vera-commons-onramp-check/1.0' } });
  check('the on-ramp downloads over plain HTTPS', res.ok, `HTTP ${res.status}`);
  if (!res.ok) return report(checks);

  const buf = Buffer.from(await res.arrayBuffer());
  const src = buf.toString('utf8');
  check('the download is not a BOM-prefixed file (a BOM breaks the shebang)',
    !(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF), `${buf.length} bytes`);
  check('the download is valid UTF-8 (no replacement characters)',
    !src.includes('\uFFFD'), `${src.length} chars`);
  check('it is a runnable script, not an error page',
    src.startsWith('#!/usr/bin/env node'), JSON.stringify(src.slice(0, 40)));

  runOnramp(src, { check, label: 'live' });

  if (selfTest) {
    // NEGATIVE CONTROL. Without this, a check that always passes would look identical to a good one.
    const before = checks.length;
    runOnramp('#!/usr/bin/env node\n// truncated on purpose\n', { check, label: 'control (truncated)', control: true });
    const control = checks.slice(before);
    const failedAsItShould = control.some((c) => !c.ok);
    check('CONTROL: a broken on-ramp is REJECTED (so this check can fail)', failedAsItShould,
      failedAsItShould ? 'the control run failed as required' : 'the control run PASSED, which means these checks prove nothing');
  }

  return report(checks, selfTest);
}

function report(checks, selfTest = false) {
  console.log('');
  for (const c of checks) {
    const tag = c.control ? '   <- control: failing here is the point' : '';
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}${tag}`);
  }
  const graded = checks.filter((c) => !c.control);
  const failed = graded.filter((c) => !c.ok);
  console.log(`\n${graded.length - failed.length}/${graded.length} checks passed (control runs are not graded).`);
  if (failed.length) {
    console.log('\nThis is about the OFFER, not about admissions: nothing was registered or published.');
    return 1;
  }
  console.log(selfTest
    ? 'The live on-ramp works, and the negative control confirms these checks are capable of failing.'
    : 'The live on-ramp works. Run with --self-test to confirm these checks can fail.');
  return 0;
}

process.exit(await main());
