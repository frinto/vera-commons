#!/usr/bin/env node
// Deploy the commons code to the USB stick, then PROVE the deployed copy actually runs.
//
// WHY THIS SCRIPT EXISTS — a real defect it was written to catch:
// An earlier sync copied `src/` to the stick root and then verified the copy by comparing file
// hashes against the repo. It reported "82 files, 0 mismatches" and every hash matched. The stick
// was still broken: `console/app.mjs` imports `./src/...`, which resolves to `console/src/`, and
// that directory did not exist on the stick, so the console died on startup with
// ERR_MODULE_NOT_FOUND. The check was internally consistent and structurally incapable of failing,
// because it verified that the files I copied equalled the files I copied FROM — never that the
// result RUNS. A layout fact is not a hash fact.
//
// So this script does both, and the second one is the point:
//   1. copy the code trees to the layout the console expects;
//   2. start the deployed console from the stick and assert it serves HTTP.
// A missing file, a drifted copy or a bad layout fails step 2 loudly.
//
// Secrets are NOT touched. verifier.json / user-admin.json / trust.json /
// relay-operator-secret.txt already live on the stick and are the operator's credential store;
// this script only ever writes CODE.
//
// Usage: node tools/deploy-stick.mjs [stickRoot] [--check]    (default E:\ — the DRIVE ROOT)
//
// --check ASKS THE DRIFT QUESTION WITHOUT WRITING ANYTHING, and it exists because the script could
// not previously answer it. The copy ran first and the comparison ran second, so the act of checking
// silently REPAIRED the thing being checked and the answer was always "in sync". That is not a
// hypothetical: a stick ran for hours with an OLDER src/policy.mjs (the admission rules the admin
// console enforces) and no src/frame.mjs at all, while every deploy reported success -- because every
// deploy had already overwritten the evidence by the time it looked. Drift is only observable BEFORE
// the copy, which is why --check stops short of it: no copy, no launcher write, and no start-check
// (the console creates its data dir on the stick as it runs, so starting it is a write).
//
// EXIT CODES — different situations, different codes, because the REMEDY differs and a single
// "it failed" verdict sent operators to debug code that was fine:
//   0  every check passed: the code is deployed AND the console runs (or, under --check, the stick
//      matches the repo and nothing was written).
//   1  the DEPLOYMENT is wrong: a file is missing, the copy drifted, the layout is wrong, or the
//      console will not serve (under --check: the stick has DRIFTED from the repo).
//   2  bad invocation: the target is not a drive root, or an unrecognised flag was passed.
//   3  PRECONDITION not met: the code deployed correctly, but this volume has no operator credentials
//      yet, so the checks that need an unlocked console are NOT RUN rather than failed. The remedy is
//      the key ceremony, not a code fix. See tools/stick-preconditions.mjs for why this is separate.
//   4  a SECOND COPY of this project is on the stick: the deployment itself is fine, but a folder this
//      tool never wrote carries its own app.mjs + src/, so a console started from it serves staler
//      code and its own data. The remedy is a human ruling on that folder, not a re-deploy, which is
//      exactly why it is not code 1. The rule is in tools/stick-scan.mjs; code 1 outranks code 4 and
//      both are always reported. This tool never deletes a tree it did not create.
//
// TRYING IT WITHOUT A PHYSICAL STICK. The drive-root rule below is load-bearing (the console resolves
// its own credentials from its own location), so a plain folder will not do — but a virtual drive will:
//     New-Item -ItemType Directory -Force .tmp\stick-v | Out-Null
//     subst V: (Join-Path (Get-Location) '.tmp\stick-v')
//     node tools/deploy-stick.mjs V:\
//     subst V: /d
// A freshly created virtual drive carries no credentials, so expect exit 3 and the NOT-RUN block above:
// that is the precondition working, not a broken build. This is also the only way to exercise the
// deployment path on a machine with no removable media.
//
// WHY THE ROOT AND NOT A SUBDIRECTORY. The console derives everything from its own location:
//     APP      = dirname(app.mjs)
//     USB_ROOT = resolve(APP, '..')
//     KEY_FILE = USB_ROOT/user-admin.json     TRUST_FILE = USB_ROOT/trust.json
//     VERIFIER = USB_ROOT/verifier.json       SECRET     = USB_ROOT/relay-operator-secret.txt
//     DATA_DIR = APP/data
// The operator's credentials already sit at the drive root, and verifier.json's own
// `dir: data/admissions` resolves relative to that same root. So the console has to live one
// level BELOW the credentials — i.e. in <root>/console/ — for USB_ROOT to come out as <root>.
// Deploying to <root>/AgentCommons/console/ makes USB_ROOT = <root>/AgentCommons, which has no
// credentials, so the app answers 503 "the USB stick is not present" while the stick is plugged in.

import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// FAIL CLOSED ON FLAGS, BEFORE ANYTHING IS TOUCHED. This script writes to a physical device, so a
// flag it does not understand must stop it rather than be ignored: an operator who typed the wrong
// thing would otherwise believe they asked for one behaviour and get another -- and the other one
// was a write. (Same defect class as mint-verifier.mjs, where an unrecognised --dir was silently
// ignored and the command went to the real credential store.)
const ARGV = process.argv.slice(2);
const KNOWN_FLAGS = ['--check'];
const unknownFlags = ARGV.filter((a) => a.startsWith('-') && !KNOWN_FLAGS.includes(a));
if (unknownFlags.length) {
  console.log('refusing: unrecognised flag(s): ' + unknownFlags.join(', '));
  console.log('accepted: ' + KNOWN_FLAGS.join(', ') + '   plus an optional stick root, e.g. E:\\');
  process.exit(2);
}
const CHECK_ONLY = ARGV.includes('--check');
const STICK = resolve(ARGV.find((a) => !a.startsWith('-')) || 'E:\\');

// Refuse to deploy into a directory that is not a drive root: the whole 503 bug was a wrong root,
// and silently accepting one would reproduce it.
if (basename(STICK) !== '' && !/^[A-Za-z]:\\?$/.test(STICK)) {
  console.log('refusing: the stick root must be a drive root like E:\\ (got ' + STICK + ')');
  console.log('the console derives USB_ROOT from its own path, so a nested root breaks it.');
  process.exit(2);
}

// The console refuses to start from anything that is not removable media (console/media.mjs).
// That is correct, and it means the start-check below must know what it is deploying TO -- run
// unmodified against a fixed disk it would report the gate working as "the console exited".
const { volumeKind } = await import('../console/media.mjs');
const { classifyStickVolume } = await import('./stick-preconditions.mjs');
const TARGET_MEDIA = await volumeKind(STICK);
const TARGET_IS_STICK = TARGET_MEDIA.kind === 'removable';
console.log(`  target media   ${TARGET_MEDIA.kind}   (${TARGET_MEDIA.detail})`);
if (!TARGET_IS_STICK) {
  console.log(`  NOTE: ${STICK} is not removable media, so the console will refuse to run from it.`);
  console.log('        The start-check below therefore passes --allow-fixed-disk. On a real stick');
  console.log('        that flag is absent and the media gate is exercised for real.');
}
const PORT = Number(process.env.AC_DEPLOY_PORT || 7794);

// The console imports './src/...' relative to ITS OWN directory, so it needs a copy of src INSIDE
// console/. The top-level src/ is what tools/ and test/ import. Both are required; they are
// deployed from the same source in the same pass so they cannot drift from each other.
const TREES = [
  { from: join(ROOT, 'src'), to: join(STICK, 'src') },
  { from: join(ROOT, 'src'), to: join(STICK, 'console', 'src') },   // <- the one that was missing
  { from: join(ROOT, 'console', 'public'), to: join(STICK, 'console', 'public') },
  { from: join(ROOT, 'tools'), to: join(STICK, 'tools') },
  { from: join(ROOT, 'docs'), to: join(STICK, 'docs') },
  { from: join(ROOT, 'spec'), to: join(STICK, 'spec') },
  { from: join(ROOT, 'test'), to: join(STICK, 'test') },
  { from: join(ROOT, 'worker'), to: join(STICK, 'worker') },
];
const FILES = [
  // Every top-level module in console/ is carried BY RULE, not by name. The named version meant a
  // new sibling module (console/media.mjs) could reach the repository, pass every test in the
  // checkout, and then be absent on the stick -- where app.mjs imports it and the console dies
  // with ERR_MODULE_NOT_FOUND. That is the same failure the console/src entry above already
  // documents once. A name can be forgotten; a rule cannot.
  ...readdirSync(join(ROOT, 'console'))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => ({ from: join(ROOT, 'console', f), to: join(STICK, 'console', f) })),
  { from: join(ROOT, 'package.json'), to: join(STICK, 'package.json') },
];

// Never deployed and never compared. wrangler rewrites worker/.wrangler/tmp/** on every dev run, so
// shipping it puts files on the stick that change ON THEIR OWN: the first --check run after this flag
// was added reported drift for four of them, a false alarm about code that was perfectly in sync. A
// drift report nobody can trust is worse than no drift report, so build output is excluded BY RULE
// here rather than by remembering to clean it up.
const SKIP_DIRS = new Set(['.wrangler', 'node_modules']);

const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
let failures = 0;
const ok = (m) => console.log('  PASS ' + m);
const bad = (m) => { failures++; console.log('  FAIL ' + m); };
// A second copy of the project gets its OWN verdict and its own exit code: the remedy is a human
// ruling on a folder, not the re-deploy that code 1 tells the operator to run. Folding it into
// `failures` would make the two situations indistinguishable at the exit code, which is the one
// thing the operator acts on.
let straysFound = 0;
const stray = (m) => { straysFound++; console.log('  FAIL ' + m); };

function copyTree(from, to) {
  // Guarded: mkdirSync on an existing DIRECTORY is a no-op, but on a Windows drive root it throws
  // EPERM even with recursive:true. Since the deploy root IS a drive root here, the unguarded call
  // made the whole deploy fail at the first file.
  if (!existsSync(to)) mkdirSync(to, { recursive: true });
  let n = 0;
  for (const e of readdirSync(from)) {
    if (SKIP_DIRS.has(e)) continue;   // build output: not ours to ship, and it would drift on its own
    const s = join(from, e), d = join(to, e);
    if (statSync(s).isDirectory()) n += copyTree(s, d);
    else { copyFileSync(s, d); n++; }
  }
  return n;
}

console.log('stick: ' + STICK);
if (!existsSync(STICK)) {
  console.log('  the stick is not mounted at that path — nothing to do.');
  process.exit(2);
}

// --- 1. copy -----------------------------------------------------------------
// Skipped entirely under --check. This is the whole point of the flag: the comparison in step 2
// cannot report drift that step 1 has already overwritten.
if (!CHECK_ONLY) {
  console.log('');
  console.log('--- copying code (secrets are never touched) ---');
  let copied = 0;
  for (const t of TREES) {
    if (!existsSync(t.from)) { bad('missing source tree: ' + relative(ROOT, t.from)); continue; }
    copied += copyTree(t.from, t.to);
  }
  for (const f of FILES) {
    if (!existsSync(f.from)) { bad('missing source file: ' + relative(ROOT, f.from)); continue; }
    const parent = dirname(f.to);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    copyFileSync(f.from, f.to);
    copied++;
  }
  console.log('  copied ' + copied + ' file(s)');
}

// --- 1b. every relative import in the deployed console must resolve ON THE STICK ---------------
// The checkout CANNOT catch this class of bug: the missing file is sitting right there in the
// repository, so the console runs fine locally and dies only on the stick. Only the deployed tree
// can answer the question, so it is asked of what was actually copied.
{
  const deployedDir = join(STICK, 'console');
  // The guard is here because --check does not copy: in deploy mode this directory has just been
  // created above, so an unguarded readdir would work in the only mode that used to exist and throw
  // ENOENT the first time the new mode met an empty volume. A missing directory must be REPORTED.
  const deployed = existsSync(deployedDir) ? readdirSync(deployedDir).filter((f) => f.endsWith('.mjs')) : [];
  let checked = 0;
  for (const f of deployed) {
    const src = readFileSync(join(deployedDir, f), 'utf8');
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      checked++;
      const target = resolve(deployedDir, m[1]);
      if (!existsSync(target)) bad(`console/${f} imports ${m[1]}, which is NOT on the stick`);
    }
  }
  if (deployed.length === 0) bad('no console modules were deployed at all');
  ok(`resolved ${checked} relative import(s) across ${deployed.length} deployed console module(s)`);
}

// The launcher a non-technical user actually double-clicks. The deploy WRITES it, rather than
// shipping a hand-written file, so it cannot drift from the layout: an earlier hand-written
// launcher sat at the stick root doing `cd /d "%~dp0"` + `node app.mjs` while the app lived in
// console/, so double-clicking it printed a Node module error and nothing opened.
const LAUNCHER = join(STICK, 'START-HERE.cmd');
// Not written under --check. It is a write, and writing it would also MASK a stick whose launcher is
// missing -- the layout check below is supposed to notice exactly that.
if (!CHECK_ONLY) writeFileSync(LAUNCHER, [
  '@echo off',
  'title Agent Commons Console',
  'cd /d "%~dp0console"',
  '',
  'where node >nul 2>nul',
  'if errorlevel 1 (',
  '  echo.',
  '  echo   ============================================================',
  '  echo    Node.js is not installed on this computer.',
  '  echo.',
  '  echo    Install it once from  https://nodejs.org',
  '  echo    Click the big green "LTS" button, run the installer,',
  '  echo    click Next through everything, then run this file again.',
  '  echo   ============================================================',
  '  echo.',
  '  pause',
  '  exit /b 1',
  ')',
  '',
  'echo.',
  'echo   Starting the Agent Commons Console...',
  'echo   A browser window should open by itself in a moment.',
  'echo.',
  'node app.mjs',
  '',
  'echo.',
  'echo   The console has stopped.',
  'pause',
  '',
].join('\r\n'), 'utf8');
if (!CHECK_ONLY) console.log('  wrote ' + relative(STICK, LAUNCHER) + ' (the thing to double-click)');

// --- 2. the deployed bytes must equal the repo ---------------------------------
console.log('');
console.log('--- the deployed copy matches the repo ---');
let drift = 0, checked = 0;
for (const t of TREES) {
  if (!existsSync(t.from)) continue;
  const walk = (dir, rel = '') => {
    for (const e of readdirSync(dir)) {
      if (SKIP_DIRS.has(e)) continue;   // must match copyTree, or the walk reports drift the copy ignored
      const s = join(dir, e), r = rel ? rel + '/' + e : e;
      if (statSync(s).isDirectory()) { walk(s, r); continue; }
      const dst = join(t.to, r);
      checked++;
      if (!existsSync(dst) || sha(s) !== sha(dst)) { drift++; bad('drift: ' + r + ' under ' + t.to); }
    }
  };
  walk(t.from);
}
if (drift === 0) ok(checked + ' file(s) identical to the repo');

// The layout facts the console depends on. These are the assertions whose absence caused the bug.
// The two SECRET entries are marked, because their absence is a precondition rather than a fault --
// see the gate immediately below, and tools/stick-preconditions.mjs for why the distinction matters.
console.log('');
console.log('--- the layout the console actually imports from ---');
const LAYOUT = [
  { p: join(STICK, 'console', 'app.mjs') },
  { p: join(STICK, 'console', 'src', 'identity.mjs') },
  { p: join(STICK, 'console', 'src', 'retract.mjs') },
  { p: join(STICK, 'console', 'public', 'index.html') },
  { p: join(STICK, 'src', 'identity.mjs') },
  { p: join(STICK, 'START-HERE.cmd') },
  { p: join(STICK, 'user-admin.json'), secret: true },   // the operator's key: without it the app answers 503
  { p: join(STICK, 'trust.json'), secret: true },
];
for (const { p, secret } of LAYOUT) {
  if (existsSync(p)) ok('present: ' + relative(STICK, p));
  else if (secret) console.log('  ----  absent, and this tool will not create it: ' + relative(STICK, p));
  else bad('MISSING: ' + relative(STICK, p) + '  (the console will not start without this)');
}

// --- 2c. a SECOND COPY of the project on the stick (read-only) ----------------------------------
// Written because of a measured incident, not a hypothesis: a console process started from
// E:\AgentCommons\ -- a stale second copy of this project left on the volume by an earlier layout --
// held 127.0.0.1:7788 for 7h19m. On Windows two processes can hold ONE port, so a later trial could
// have been answered by THAT build while every check in this tool reported the deployment healthy.
// Everything above compares the files this tool DEPLOYS, which is precisely why a tree it never wrote
// was invisible to it. The rule lives in tools/stick-scan.mjs and is narrow on purpose (it must not
// cry wolf about the operator's own code); this section supplies the evidence and the verdict.
const { findStrayCopies } = await import('./stick-scan.mjs');
const DEPLOYED_TOP = ['console', 'src', 'tools', 'docs', 'spec', 'test', 'worker', 'data'];
console.log('');
console.log('--- no second copy of the project on the stick ---');
for (const s of findStrayCopies(STICK, { deployedTop: DEPLOYED_TOP, skipDirs: [...SKIP_DIRS] })) {
  const detail = s.marks.map((m) => {
    const mine = join(STICK, ...m.split('/'));
    const theirs = join(s.dir, ...m.split('/'));
    const cmp = existsSync(mine) ? ' (' + sha(theirs).slice(0, 12) + ' here vs ' + sha(mine).slice(0, 12) + ' deployed)' : '';
    return m + cmp;
  }).join(', ');
  stray('SECOND COPY of this project: ' + relative(STICK, s.dir) + '\\ carries ' + detail);
}
if (straysFound === 0) ok('nothing outside the deployed layout carries this project\'s shape');

function reportStrays() {
  console.log('');
  console.log(straysFound + ' SECOND COPY of this project is on the stick. The deployed copy is fine, so this');
  console.log('is NOT a re-deploy problem: a console started from that folder serves ITS OWN staler code and');
  console.log('its own data, and on Windows two processes can hold one port.');
  console.log('  Decide by hand whether to keep it. This tool never deletes a tree it did not create.');
  console.log('  Nothing was written.');
}

// --- CHECK-ONLY STOPS HERE ----------------------------------------------------------------------
// Everything below STARTS the deployed console, and starting it is not free of side effects: the
// console creates its own data dir on the stick (DATA_DIR = <stick>/console/data). --check promised
// to write nothing, so it ends here, having answered both questions it can answer without writing:
// do the deployed bytes still equal the repo, and is the layout the console needs present.
if (CHECK_ONLY) {
  console.log('');
  if (failures) {
    console.log(failures + ' check(s) FAILED — the stick has DRIFTED from the repo. Nothing was written.');
    console.log('Run the same command without --check to repair it.');
    if (straysFound) console.log('ALSO reported above: ' + straysFound + ' second copy of this project (its own code 4).');
    process.exit(1);
  }
  if (straysFound) {
    reportStrays();
    process.exit(4);
  }
  console.log('CHECK OK: the stick matches the repo. Nothing was written.');
  process.exit(0);
}

// --- 2b. THE PRECONDITION. Everything below starts the console and asserts what it SERVES, and the
// console reads the operator key on every request. With no key on the volume it answers 503 to
// everything, so every page check fails on the locked page and the run ends declaring the stick
// undeployable -- which blamed the code for a missing ceremony. Gate it here instead.
const pre = classifyStickVolume({
  hasUserAdmin: existsSync(join(STICK, 'user-admin.json')),
  hasTrust: existsSync(join(STICK, 'trust.json')),
  drive: STICK,
});
if (!pre.ok) {
  console.log('');
  console.log('  ' + pre.headline);
  for (const line of pre.detail) console.log(line ? '  ' + line : '');
  console.log('');
  console.log('  ' + pre.verdict);
  console.log('');
  process.exit(pre.exitCode);
}

// --- 3. START IT. This is the check that can actually fail ---------------------
console.log('');
console.log('--- starting the DEPLOYED console from the stick ---');
// Through tools/console-runner.mjs rather than a bare spawn. The runner pre-flights the port -- it
// REFUSES one that is already served and NAMES the holder -- takes an attributed lock, waits for the
// token, and can PROVE the port was released afterwards. A bare spawn could do none of those: on
// Windows two processes can hold one port, so an unguarded run would talk to a squatter's console
// and report it as this deployment, and nothing would show a listener was left behind. That is not
// hypothetical -- a console held 127.0.0.1:7788 for 7h19m while every check reported healthy.
const { startConsole, stopAndVerify } = await import('./console-runner.mjs');
let live = null;
try {
  live = await startConsole({
    app: join(STICK, 'console', 'app.mjs'),
    port: PORT,
    args: ['--no-browser', ...(TARGET_IS_STICK ? [] : ['--allow-fixed-disk'])],
    cwd: join(STICK, 'console'),
    tool: 'deploy-stick.mjs',
    readyTimeoutMs: 12000,
  });
} catch (e) {
  const msg = String((e && e.message) || e);
  // The media gate working must stay distinguishable from a genuinely broken deployment; the runner
  // throws both for "it exited before printing a token" and for "that port is already taken".
  if (/REFUSING TO START/.test(msg)) {
    bad('the deployed console refused to start (media gate) even though --allow-fixed-disk was passed');
  } else {
    bad('the deployed console did not come up: ' + msg.split('\n')[0]);
  }
  for (const l of msg.split('\n').filter(Boolean).slice(0, 8)) console.log('       | ' + l);
}

if (live) {
  ok('the deployed console came up and is running (pid ' + live.child.pid + ')');
  // The runner returns a handle only once the console has PRINTED ITS TOKEN; without that token
  // every route answers 401, which is the CSRF defence and must stay closed.
  ok('the console issued a per-run token');

  const base = live.base;
  const TOKEN = live.token;
  try {
    // 1. The gate is CLOSED without the token. This is the correct behaviour, not a failure —
    //    an earlier version of this script asserted 200 here and reported the gate as "open"
    //    when it got a refusal, which is the opposite of what the number meant.
    const noTok = await fetch(base + '/');
    if (noTok.status === 401 || noTok.status === 403) ok('GET / without the token is refused (' + noTok.status + ')');
    else bad('GET / without the token returned ' + noTok.status + ' — expected 401/403');

    if (TOKEN) {
      // 2. With the token it serves the real page...
      const res = await fetch(base + '/?t=' + TOKEN);
      if (res.status === 200) ok('GET / with the token served HTTP 200');
      else bad('GET / with the token returned ' + res.status + ', expected 200');

      const html = await res.text();
      if (/[Ww]ithdraw/.test(html)) ok('the served page contains the withdrawal UI');
      else bad('the served page has no withdrawal UI — is this a stale build?');

      // The revocation UI is checked by its BEHAVIOUR, not by the word "Revoke" — that word was
      // already on the page when the only way to revoke was to retype a 43-character id from
      // memory. What must be present is the per-holder control and the root being excluded from it.
      if (/revokeHolder/.test(html)) ok('the served page revokes by clicking a listed holder');
      else bad('the served page has no per-holder revoke control — is this a stale build?');
      if (/root — revoke by editing trust\.json/.test(html)) ok('and it tells the admin a root is not revocable from the console');
      else bad('the page does not say that a root cannot be revoked from here');

      // 3. ...and the live state must actually carry the retraction fields the UI reads.
      const st = await fetch(base + '/api/state?t=' + TOKEN);
      if (st.status === 200) {
        const s = await st.json();
        if (Array.isArray(s.withdrawn)) ok('live state exposes a `withdrawn` list');
        else bad('live state has no `withdrawn` list — the UI would render nothing');

        // THE decisive one: the stick must be VISIBLE. The whole wrong-root bug showed up here as
        // locked:true / a 503, with every file hash matching perfectly.
        if (s.locked === false && s.stick && s.stick.present) {
          ok('the console can SEE the stick (locked=false, key file found at ' + s.stick.keyFile + ')');
        } else {
          bad('the console reports locked=' + s.locked + ' — USB_ROOT resolved to the wrong folder');
        }
        if (s.me && s.me.agentId) ok('it read the operator identity: ' + s.me.short);
        else bad('no operator identity — the credential file was not found');
      } else {
        bad('/api/state with the token returned ' + st.status);
      }
    }
  } catch (e) {
    bad('could not reach the deployed console over HTTP: ' + e.message);
  }
  // Stop it -- and PROVE the port was released. A run that leaves a listener behind is the failure
  // this file was taught to report, not a detail to skip on the way out.
  try {
    await stopAndVerify(live);
    ok('the console was stopped and port ' + PORT + ' is free again');
  } catch (e) {
    bad('a console is STILL listening on port ' + PORT + ' after this run: ' + String((e && e.message) || e));
  }
}

console.log('');
if (failures) {
  console.log(failures + ' check(s) FAILED — the stick is NOT deployable as it stands.');
  if (straysFound) console.log('ALSO reported above: ' + straysFound + ' second copy of this project (its own code 4).');
  process.exit(1);
}
if (straysFound) {
  reportStrays();
  process.exit(4);
}
console.log('All checks passed: the stick copy is deployed AND it runs.');
