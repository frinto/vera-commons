// OPERATOR COMMAND TRIAL — both halves of the gate, each run as the shipped COMMAND.
//
// Round 14 proved the joiner's command worked by spawning it. Round 15 added the operator's command,
// and this closes the pair: neither side is a function call, both are child processes, and neither is
// told what the other is doing beyond the relay. `operator-serve` has to DISCOVER the request off the
// queue by itself — if it needed the requestId handed to it, it would not be a tool anyone could use.
//
// ARMS: grant (answers derived from the published taxonomy) and refuse (same path, corrupted answers).
// A one-armed version would pass on a tool that always grants.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RELAY = process.env.AC_RELAY || 'https://agent-commons.huyxkhoa.workers.dev';
const ITEMS = Number(process.env.AC_ITEMS || 20);

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSolver(kb) {
  const chains = kb.chains;
  const ART = /^An? /;
  const strip = (s) => String(s).trim().replace(/\.$/, '').replace(ART, '');
  const parseClaim = (text) => {
    const m = /^An? (.+?) is an? (.+?)\.?$/.exec(String(text).trim());
    if (!m) throw new Error('unparsed item: ' + text);
    return { subject: strip(m[1]), object: strip(m[2]) };
  };
  return (item) => {
    const entity = parseClaim(item.premise).subject;
    const category = parseClaim(item.hypothesis).object;
    const entailed = chains.some((c) => {
      const i = c.indexOf(entity);
      return i >= 0 && c.indexOf(category) > i;
    });
    return entailed ? 'ENTAILED' : 'CONTRADICTED';
  };
}

const WORK = join(tmpdir(), 'op-cmd-' + crypto.randomBytes(4).toString('hex'));
mkdirSync(WORK, { recursive: true });

// One run of the pair. `corrupt` flips a decisive share of the derived answers.
async function runPair(tag, { corrupt }) {
  console.log(`--- ${tag} ---`);
  const keyFile = join(WORK, `${tag}-identity.json`);

  // The operator, running as its own command, knowing nothing about the joiner.
  const opChild = spawn(process.execPath,
    [join(ROOT, 'tools', 'operator-serve.mjs'), '--url', RELAY, '--once', '--seconds', '300', '--items', String(ITEMS)],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let opOut = '';
  opChild.stdout.on('data', (d) => { opOut += d; });
  opChild.stderr.on('data', (d) => { opOut += d; });

  // Let the operator take its baseline BEFORE the joiner requests. Otherwise it could count the new
  // request as pre-existing and skip it — a race that would look like "the tool does nothing".
  await sleep(6000);

  const joinerChild = spawn(process.execPath,
    [join(ROOT, 'tools', 'join-apply.mjs'), 'apply', '--url', RELAY, '--key', keyFile, '--note', '[trial] operator-command-trial', '--wait', '180'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let jOut = '';
  joinerChild.stdout.on('data', (d) => { jOut += d; });
  joinerChild.stderr.on('data', (d) => { jOut += d; });

  const jExit = await new Promise((res) => { joinerChild.on('exit', (c) => res(c)); setTimeout(() => res(null), 240000); });
  check(`${tag}: the joiner command exited 0 (it was served by a tool it never spoke to)`, jExit === 0, `exit ${jExit}\n${jOut.slice(-300)}`);
  // NOTE: the operator's stdout is asserted only AFTER it exits. Node buffers a piped stdout, so a
  // check taken while it is still running reads a partial view and fails for a reason that has
  // nothing to do with the behaviour under test. (This file did exactly that once.)

  const challengeFile = join(WORK, `${tag}-identity.challenge.json`);
  if (!existsSync(challengeFile)) { check(`${tag}: the joiner received a challenge`, false, 'no challenge file'); return null; }
  const got = JSON.parse(readFileSync(challengeFile, 'utf8'));
  const solve = makeSolver(got.kb);
  let answers = got.items.map(solve);
  if (corrupt) {
    const flip = Math.ceil(answers.length * 0.3);
    for (let i = 0; i < flip; i++) answers[i] = answers[i] === 'ENTAILED' ? 'CONTRADICTED' : 'ENTAILED';
  }
  const answersFile = join(WORK, `${tag}-answers.json`);
  writeFileSync(answersFile, JSON.stringify({ answers }, null, 2), 'utf8');

  const ans = spawnSync(process.execPath,
    [join(ROOT, 'tools', 'join-apply.mjs'), 'answer', '--url', RELAY, '--key', keyFile, '--answers-file', answersFile],
    { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  check(`${tag}: the joiner submitted answers`, ans.status === 0, `exit ${ans.status} ${String(ans.stderr).slice(-200)}`);

  const opExit = await new Promise((res) => { opChild.on('exit', (c) => res(c)); setTimeout(() => res(null), 300000); });
  check(`${tag}: the operator command exited 0`, opExit === 0, `exit ${opExit}`);
  // Now that it has exited, its output is complete.
  check(`${tag}: ★ the operator DISCOVERED the request off the queue by itself`,
    opOut.includes('challenge published'), opOut.slice(-400));
  check(`${tag}: ★ the operator verified the bind names the requesting key`,
    opOut.includes('matches the requesting key'), opOut.slice(-400));
  check(`${tag}: the operator never saw the joiner as anything but an unauthenticated queue entry`,
    opOut.includes('those are skipped, not re-served'), opOut.slice(-200));
  const want = corrupt ? 'refused' : 'granted';
  check(`${tag}: ★ the operator's own command decided "${want}"`, opOut.includes(`verdict SIGNED and published: ${want}`),
    opOut.slice(-500));
  check(`${tag}: the operator scored locally and reported the ratio`, /scored LOCALLY: \d+\/\d+/.test(opOut));

  const vd = spawnSync(process.execPath,
    [join(ROOT, 'tools', 'join-apply.mjs'), 'verdict', '--url', RELAY, '--key', keyFile, '--wait', '60'],
    { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  check(`${tag}: ★ the joiner's own command VERIFIED the signature`, String(vd.stdout).includes('VERIFIES against the operator key'),
    String(vd.stdout).slice(-300));
  check(`${tag}: and sees the decision "${want}"`, String(vd.stdout).includes(`decision : ${want}`));

  // The salt must never appear anywhere the joiner or the wire could see it.
  check(`${tag}: ★ the operator's output NEVER contains the salt`, !opOut.includes(JSON.parse(readFileSync(process.env.AC_VERIFIER || 'E:\\verifier.json', 'utf8')).salt));
  check(`${tag}: the joiner's output never contains the salt`, !jOut.includes(JSON.parse(readFileSync(process.env.AC_VERIFIER || 'E:\\verifier.json', 'utf8')).salt));
  return { want };
}

const a = await runPair('grant', { corrupt: false });
console.log('');
const b = await runPair('refuse', { corrupt: true });

console.log('');
console.log(`${pass} assertions passed${fail ? ', ' + fail + ' FAILED' : ''}.`);
if (a && b) {
  console.log(`Discrimination: grant arm decided "${a.want}", refuse arm decided "${b.want}" — the pair differs, so neither arm is vacuous.`);
}
process.exit(fail === 0 ? 0 : 1);
