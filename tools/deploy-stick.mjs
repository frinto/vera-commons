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
// Usage: node tools/deploy-stick.mjs [stickRoot]     (default E:\ — the DRIVE ROOT, not a subdir)
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
import { spawn } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STICK = resolve(process.argv[2] || 'E:\\');

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

const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
let failures = 0;
const ok = (m) => console.log('  PASS ' + m);
const bad = (m) => { failures++; console.log('  FAIL ' + m); };

function copyTree(from, to) {
  // Guarded: mkdirSync on an existing DIRECTORY is a no-op, but on a Windows drive root it throws
  // EPERM even with recursive:true. Since the deploy root IS a drive root here, the unguarded call
  // made the whole deploy fail at the first file.
  if (!existsSync(to)) mkdirSync(to, { recursive: true });
  let n = 0;
  for (const e of readdirSync(from)) {
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

// --- 1b. every relative import in the deployed console must resolve ON THE STICK ---------------
// The checkout CANNOT catch this class of bug: the missing file is sitting right there in the
// repository, so the console runs fine locally and dies only on the stick. Only the deployed tree
// can answer the question, so it is asked of what was actually copied.
{
  const deployedDir = join(STICK, 'console');
  const deployed = readdirSync(deployedDir).filter((f) => f.endsWith('.mjs'));
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
writeFileSync(LAUNCHER, [
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
console.log('  wrote ' + relative(STICK, LAUNCHER) + ' (the thing to double-click)');

// --- 2. the deployed bytes must equal the repo ---------------------------------
console.log('');
console.log('--- the deployed copy matches the repo ---');
let drift = 0, checked = 0;
for (const t of TREES) {
  if (!existsSync(t.from)) continue;
  const walk = (dir, rel = '') => {
    for (const e of readdirSync(dir)) {
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
console.log('');
console.log('--- the layout the console actually imports from ---');
for (const required of [
  join(STICK, 'console', 'app.mjs'),
  join(STICK, 'console', 'src', 'identity.mjs'),
  join(STICK, 'console', 'src', 'retract.mjs'),
  join(STICK, 'console', 'public', 'index.html'),
  join(STICK, 'src', 'identity.mjs'),
  join(STICK, 'START-HERE.cmd'),
  join(STICK, 'user-admin.json'),        // the operator's key: without it the app answers 503
  join(STICK, 'trust.json'),
]) {
  if (existsSync(required)) ok('present: ' + relative(STICK, required));
  else bad('MISSING: ' + relative(STICK, required) + '  (the console will not start without this)');
}

// --- 3. START IT. This is the check that can actually fail ---------------------
console.log('');
console.log('--- starting the DEPLOYED console from the stick ---');
const child = spawn(process.execPath, [join(STICK, 'console', 'app.mjs'), '--port', String(PORT), '--no-browser',
  ...(TARGET_IS_STICK ? [] : ['--allow-fixed-disk'])], {
  cwd: join(STICK, 'console'), stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '', err = '', exited = null;
child.stdout.on('data', (c) => { out += String(c); });
child.stderr.on('data', (c) => { err += String(c); });
child.on('exit', (code) => { exited = code; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => { try { child.kill(); } catch { /* already gone */ } };
process.on('exit', cleanup);

await sleep(4000);

if (exited !== null) {
  // Distinguish the media gate working from a genuinely broken deployment. On a fixed-disk target
  // the gate firing is EXPECTED and is already accounted for above; if it fires anyway, the reason
  // is worth stating rather than reporting as "the console exited".
  if (/REFUSING TO START/.test(out + err)) {
    bad('the deployed console refused to start (media gate) even though --allow-fixed-disk was passed');
  } else {
    bad('the deployed console EXITED immediately (code ' + exited + ')');
  }
  const firstLines = (err || out).split('\n').filter(Boolean).slice(0, 8);
  for (const l of firstLines) console.log('       | ' + l);
} else {
  ok('the deployed console is still running after 4s (it did not crash on startup)');

  // The console prints its one-time URL containing the per-run token; without it every route
  // answers 401, which is the CSRF defence and must stay closed.
  const tokenMatch = /\?t=([A-Za-z0-9_-]{10,})/.exec(out);
  const TOKEN = tokenMatch ? tokenMatch[1] : null;

  if (!TOKEN) {
    bad('the console never printed a per-run token — it may have started but not be serving');
    console.log('       | ' + (out || err).split('\n').filter(Boolean).slice(0, 6).join('\n       | '));
  } else {
    ok('the console issued a per-run token');
  }

  const base = 'http://127.0.0.1:' + PORT;
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
  cleanup();
}

console.log('');
if (failures) {
  console.log(failures + ' check(s) FAILED — the stick is NOT deployable as it stands.');
  process.exit(1);
}
console.log('All checks passed: the stick copy is deployed AND it runs.');
