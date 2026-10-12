#!/usr/bin/env node
/**
 * ONE COMMAND FOR THE EVIDENCE THAT NOTHING WAS RUNNING.
 *
 * Why this file exists
 * --------------------
 * The strongest evidence this project has that the commons actually works end to end lives in the
 * `tools/*-trial.mjs` family: a stranger downloading the on-ramp from a bare URL, the remote MCP
 * window, the operator's commands, the whole admission gate over the live relay.
 *
 * None of them run in `npm test`, and that separation is CORRECT -- they cost KV writes against a
 * 1,000/day free tier and they leave labelled probe debris on a public relay, so running them on
 * every commit would be vandalism dressed up as rigour. But the separation was UNDOCUMENTED and
 * there was no single command that ran them, which produced the failure mode this project already
 * knows by heart: `npm test` green while the live path is broken. Two of the trials had no npm
 * script at all, so 44KB of live-trial code could only be run by remembering a path.
 *
 * What this adds is not more testing. It is the missing REGISTRY: one place that says what the
 * live evidence is, which parts of it write to the public relay, and how to run all of it.
 *
 * Usage
 *   node tools/trial-all.mjs             run every trial that WRITES NOTHING (safe, repeatable)
 *   node tools/trial-all.mjs --live      run everything, including the ones that write
 *   node tools/trial-all.mjs --list      describe the registry and run nothing
 *
 * READ-ONLY is the default and it is enforced by intent, not by hope: a trial is only allowed to be
 * marked read-only if it does not POST to an admission or message route. `test/trial-coverage.test.mjs`
 * fails the build if that ever stops being true, so a new trial cannot quietly join the safe set.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/**
 * THE REGISTRY. Every live-evidence trial the project has, with its write behaviour stated.
 *
 * `writes: false` means: this may be run repeatedly against the public relay without leaving
 * anything behind. It does NOT mean "does nothing" -- several of them hit the network.
 * `npm` is the script a human would otherwise have had to remember; `null` means there was none.
 */
const REGISTRY = [
  {
    id: 'stranger-offline',
    file: 'tools/stranger-journey.mjs',
    args: [],
    npm: null,
    writes: false,
    why: 'Negative control: a DEAD relay must not produce a false ok, and the journey refuses to lie about it. Does not touch the live relay at all.',
  },
  {
    id: 'mcp-registry',
    file: 'tools/mcp-registry-check.mjs',
    args: [],
    npm: null,
    writes: false,
    why: 'Fetches the LIVE published server.json schema, validates our descriptor against the constraints it declares, then performs a real MCP handshake against the URL the descriptor advertises. Two GET/POST reads, nothing registered. Deliberately NOT in the npm test chain: it depends on a third-party URL, and the build must not break because someone else moved a file.',
  },
  {
    id: 'onramp',
    file: 'tools/onramp-check.mjs',
    args: ['--self-test'],
    npm: null,
    writes: false,
    why: 'Runs the command /llms.txt tells every arriving agent to run: fetch /mcp.mjs over the public URL, EXECUTE it, and speak MCP to it. Then feeds the same code path a truncated file to prove the check can fail. Reads and local temp execution only; nothing registered or published. Not in the npm test chain for the same reason as mcp-registry: it depends on a live third-party URL, and the build must not break because someone else moved a file.',
  },
  {
    id: 'remote-mcp',
    file: 'tools/remote-mcp-trial.mjs',
    args: [],
    npm: 'worker:trial',
    writes: false,
    why: 'The read-only MCP window over live HTTP, including protocol shapes a real client produces. It POSTs to /mcp, but the one tool that could write must REFUSE, and it asserts that refusal.',
  },
  {
    id: 'operator-commands',
    file: 'tools/operator-command-trial.mjs',
    args: [],
    npm: 'trial:operator',
    writes: false,
    why: "The operator's own commands, exercised without posting to the relay.",
  },
  {
    id: 'permit-bridge',
    file: 'tools/bridge-trial.mjs',
    args: [],
    npm: null,
    writes: false,
    // This one needs a PROVISIONED stick: it reads trust.json, user-admin.json and verifier.json off
    // the target, and the console it starts then applies its media gate. A drive-root image WITHOUT
    // those secrets is refused by the trial itself (exit 2), and a fixed disk is refused by the
    // console's media gate. So it is registered (one command can run it) but it does NOT silently
    // count as passing when the precondition is absent -- see `needsStick` below.
    needsStick: true,
    why: 'The relay -> permit bridge, against a LOCAL stand-in relay that is allowed to LIE (substituted grantee, untrusted operator, invented decision). No live traffic. Nothing ran this until the coverage guard in test/trial-coverage.test.mjs found it. RAN 2026-10-12 against the DEPLOYED code on the real stick (AC_STICK=E:\\ AC_FROM_STICK=1): exit 0, BRIDGE TRIAL PASSED -- a trusted operator + signed bind was adopted (HTTP 200, decision=grant, grantee named from the BIND), and the tamper arms held: a relay that substitutes the grantee was refused (409 bind_bad_signature), the substituted key gained nothing, and a third party could not bind a key that was not theirs. The stick is read-only here (everything is copied into a temp dir) and was verified unmodified afterwards.',
  },
  {
    id: 'stranger-live',
    file: 'tools/stranger-journey.mjs',
    args: ['--live'],
    npm: null,
    writes: true,
    // This one writes from a CHILD PROCESS it spawns over stdio, so no amount of reading its own
    // source will show a POST. Static analysis cannot see it -- which is exactly why the reason is
    // declared here instead of the guard being quietly loosened to accommodate it.
    writeVia: 'child-process',
    why: 'The real journey: downloads the on-ramp from the live relay into an empty directory, runs it as a child process with nothing from this checkout, and posts ONE labelled probe. One KV write. Do not loop it.',
  },
  {
    id: 'admission-gate',
    file: 'tools/live-remote-trial.mjs',
    args: [],
    npm: 'trial:live',
    writes: true,
    why: 'Walks the whole agents-only gate over the live relay: request, challenge, bind, answer, verdict. Leaves an admission trail behind. It was STRUCTURALLY INCAPABLE OF PASSING until the bind step was added -- it skipped /admission/bind, so the relay refused the grant with 409 no_binding_yet. Nothing noticed because writing trials are excluded from the npm test chain; test/admission-trial-order.test.mjs now statically holds this trial to the relay hard order at zero cost.',
  },
  {
    id: 'joiner-path',
    file: 'tools/joiner-path-trial.mjs',
    args: [],
    npm: 'trial:joiner',
    writes: true,
    why: "The applicant's half of the same gate, from the other side of the wire.",
  },
  {
    id: 'vendor-gate',
    file: 'tools/vendor-gate-trial.mjs',
    args: [],
    npm: null,
    writes: true,
    why: 'Cross-vendor behaviour at the gate. Had NO npm script before this registry existed.',
  },
  {
    id: 'console-relay',
    file: 'tools/console-relay-trial.mjs',
    args: [],
    npm: null,
    writes: true,
    why: 'The console driving the relay end to end. The heaviest writer here, and until now it had no npm script either, so nothing ran it by default.',
  },
  {
    id: 'ceremony-live',
    file: 'tools/ceremony-live-trial.mjs',
    args: ['--decision', 'grant'],
    npm: 'ceremony:live',
    writes: true,
    // Declared, not hidden. This trial writes a REAL record into the store on the stick -- not to the
    // relay. Its own POSTs go to a local console (127.0.0.1) through a helper whose URL is assembled
    // at runtime, and the two state-changing writes that matter (interview, decide) are made by the
    // admission-ceremony CHILD PROCESS it spawns. The static detector recognises only POSTs to the
    // live relay host, so it can see neither. Naming that here keeps the exception visible instead of
    // loosening the guard until it stops complaining.
    writeVia: 'local-console',
    // Needs the provisioned stick: the deployed console at E:\console, the admin key it reads to
    // authorise a decision, the verifier salt it scores with, and the real store it writes.
    needsStick: true,
    why: 'The admin ceremony tool\'s HAPPY mode against the REAL store, which nothing had ever run: the refusal modes were verified, the happy mode needed a record in state `answered` and no such record existed. It mints one through the console\'s own agent-facing routes (start -> solve -> answer), then hands it to tools/admission-ceremony.mjs for interview + decide. TWO DEFECTS ON ITS FIRST LIVE RUNS: (1) the deployed stick\'s src/admission.mjs predated spec v0.5 3g.2, so the local challenge carried items and no taxonomy and the local door was a WALL -- deploy-stick --check reported 30 drifted files, and the seam probe could not see it because it runs against a COPY; (2) the console refuses a statement that is not signed by the applicant (409 interview_not_signed), so the ceremony tool\'s interview step had never worked -- it now signs with --key or refuses to post. Also asserts the property that a decision is NOT a permit: the permit ledger must be unchanged across a granted ceremony.',
  },
];

const argv = process.argv.slice(2);
const LIST = argv.includes('--list');
const LIVE = argv.includes('--live');
const forceId = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 ? argv[i + 1] : null;
})();

const selected = REGISTRY.filter((t) => (forceId ? t.id === forceId : LIVE ? true : !t.writes));
const skipped = REGISTRY.filter((t) => !selected.includes(t));

if (LIST) {
  console.log('\n  LIVE EVIDENCE REGISTRY\n');
  for (const t of REGISTRY) {
    const via = t.writeVia ? `  [writes via ${t.writeVia} — not visible in its own source]` : '';
    console.log(`  ${t.writes ? 'WRITES ' : 'safe   '}  ${t.id.padEnd(18)} ${t.file}${via}`);
    console.log(`          npm: ${t.npm ? `npm run ${t.npm}` : '(none -- path only, until now)'}`);
    console.log(`          ${t.why}`);
    console.log('');
  }
  console.log(`  ${REGISTRY.length} trials: ${REGISTRY.filter((t) => !t.writes).length} write nothing, ${REGISTRY.filter((t) => t.writes).length} write to the public relay.`);
  console.log('  `npm run trial:all` runs the safe set. `npm run trial:all:live` runs everything.\n');
  process.exit(0);
}

if (forceId && selected.length === 0) {
  console.error(`  No such trial: ${forceId}`);
  console.error(`  Known: ${REGISTRY.map((t) => t.id).join(', ')}`);
  process.exit(2);
}

console.log(`\n  ${LIVE ? 'FULL' : 'SAFE'} live-evidence run — ${selected.length} trial(s)`);
// Only claim to be skipping writers when the selection was actually made on that basis. With --only
// the rest were skipped for an unrelated reason, and saying otherwise would put a false statement in
// the output of the very command that exists to stop false statements about coverage.
if (!LIVE && !forceId && skipped.length) {
  console.log(`  Skipping ${skipped.length} trial(s) that write to the public relay:`);
  for (const t of skipped) console.log(`    - ${t.id}  (${t.npm ? `npm run ${t.npm}` : t.file})`);
  console.log('  Run them with: npm run trial:all:live   [costs KV writes; leaves labelled debris]');
}
console.log('');

const results = [];
const notRun = [];
for (const t of selected) {
  const abs = join(ROOT, t.file);
  // A missing trial is a FAILURE, never a skip. A registry that silently drops what it cannot find
  // is how "the evidence ran" becomes untrue without anyone noticing.
  if (!existsSync(abs)) {
    results.push({ id: t.id, ran: false, ok: false, note: `MISSING FILE ${t.file}` });
    console.log(`  FAIL  ${t.id.padEnd(18)} missing file ${t.file}`);
    continue;
  }
  // A trial with an unmet precondition is reported as NOT RUN, in its own category. It is never a
  // pass (which would claim evidence that does not exist) and never a failure (which would blame the
  // code for a missing stick). The summary below has to carry it, or "all green" starts meaning
  // "all green among the things that happened to be runnable".
  if (t.needsStick && !process.env.AC_STICK) {
    const def = 'E:\\';
    const provisioned = existsSync(join(def, 'user-admin.json'));
    notRun.push({ id: t.id, why: `needs a provisioned stick: set AC_STICK (${def} has no user-admin.json)` });
    console.log(`  ---   ${t.id.padEnd(18)} NOT RUN  ${notRun[notRun.length - 1].why}`);
    continue;
  }
  const started = Date.now();
  const r = spawnSync(process.execPath, [abs, ...t.args], { cwd: ROOT, encoding: 'utf8', timeout: 240000, env: { ...process.env, ...(t.env || {}) } });
  const ms = Date.now() - started;
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ok = r.status === 0;
  const lastLine = out.trim().split('\n').filter((l) => /passed|failed|assertions/.test(l)).slice(-1)[0] || '';
  results.push({ id: t.id, ran: true, ok, note: lastLine.trim() });
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${t.id.padEnd(18)} ${String(ms).padStart(5)}ms  exit=${r.status}  ${lastLine.trim()}`);
  if (!ok) {
    // Show the tail of a failing trial, because a bare exit code is not a finding.
    const tail = out.trim().split('\n').slice(-12).join('\n');
    console.log(tail.split('\n').map((l) => `        | ${l}`).join('\n'));
  }
}

const failed = results.filter((r) => !r.ok);
console.log('');
if (failed.length === 0) {
  console.log(`  ${results.length} trial(s) passed.`);
  if (notRun.length) {
    console.log(`  ${notRun.length} trial(s) NOT RUN — this run does NOT cover them:`);
    for (const n of notRun) console.log(`    - ${n.id}: ${n.why}`);
  }
  if (!LIVE && skipped.length && !forceId) console.log(`  ${skipped.length} writing trial(s) NOT run — the live write path is therefore NOT proven by this run.`);
  console.log('');
  process.exit(0);
}
console.log(`  ${failed.length} of ${results.length} trials FAILED: ${failed.map((f) => f.id).join(', ')}`);
console.log('');
process.exit(1);
