// The relay feed review CLI -- the tool that answers "is anything on the relay NOT ours?".
//
// Its one wrong answer is "UNACCOUNTED FOR: none" printed on the strength of a read that never
// happened, because that sentence clears the relay. So the rule under test is:
//   a body that is not a feed must FAIL, and only a feed that really said "no messages" may be
//   reported as clean.
// The two cases are asserted TOGETHER on purpose: if only the failure case were tested, a tool that
// always exits 2 would pass just as well.
//
// A local server answers every case, so this test needs no network and no relay. `--keys` points at
// an EMPTY directory: without it the tool walks this machine's real key roots and the result would
// depend on whose machine runs the test.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(ROOT, 'tools', 'relay-feed-review.mjs');
const FOREIGN = 'f'.repeat(64);

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

async function runCli({ body, status = 200, args = [] }) {
  const emptyKeys = mkdtempSync(join(tmpdir(), 'ac-feed-keys-'));
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  // Async spawn, never spawnSync: the fixture server is in THIS process, and spawnSync would block
  // the loop that has to answer the child's request (a hang, not a failure -- measured).
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [TOOL, url, '--keys', emptyKeys, ...args], { cwd: ROOT });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill(), 25000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, out, err }); });
  });
  server.closeAllConnections();
  server.close();
  rmSync(emptyKeys, { recursive: true, force: true });
  return { ...r, seen };
}

const CLEAN = 'UNACCOUNTED FOR: none';
const ONE_FOREIGN = {
  messages: [{
    from: FOREIGN, seq: 1, type: 'hello', topic: 'general', ts: 1750000000000,
    body: { text: 'a message from a key that is not on this machine' },
  }],
};

console.log('relay-feed-review CLI');

// --- 1. the legitimate empty feed: the only body allowed to say "none" -------------------------
{
  const r = await runCli({ body: { messages: [] } });
  check('a feed that really is empty exits 0', r.status === 0, `status=${r.status} err=${r.err.trim()}`);
  check('...and may then say none are unaccounted for', r.out.includes(CLEAN), r.out.slice(0, 200));
  check('...because it did read the feed route',
    /^\/messages\?/.test(r.seen[0] ?? ''), JSON.stringify(r.seen));
}

// --- 2. bodies that are NOT a feed: none of them may be reported as clean ----------------------
const notAFeed = [
  ['a body with no messages field', {}],
  ['a body whose messages field is null', { messages: null }],
  ['a body whose messages field is an object', { messages: { nope: true } }],
];
for (const [label, body] of notAFeed) {
  const r = await runCli({ body });
  check(`${label} exits non-zero rather than clearing the relay`, r.status === 2,
    `status=${r.status} stdout=${JSON.stringify(r.out.slice(0, 120))}`);
  check(`${label} never prints "${CLEAN}"`, !r.out.includes(CLEAN),
    JSON.stringify(r.out.slice(0, 160)));
}
{
  const r = await runCli({ body: { ok: false, reason: 'operator_only' }, status: 401 });
  check('a 401 exits 2 and does not clear the relay', r.status === 2 && !r.out.includes(CLEAN),
    `status=${r.status} stdout=${JSON.stringify(r.out.slice(0, 120))}`);
}

// --- 3. it can still report what it is for -----------------------------------------------------
{
  const r = await runCli({ body: ONE_FOREIGN });
  check('a message from a foreign key is counted', /messages held:\s+1/.test(r.out), r.out.slice(0, 300));
  check('a foreign key is NOT reported as accounted for', !r.out.includes(CLEAN), r.out.slice(0, 300));
  check('...and it names the message a human must look at', r.out.includes('UNACCOUNTED FOR (1)'),
    r.out.slice(0, 300));
}

// --- 4. the usage contract that was already there ----------------------------------------------
{
  const r = await runCli({ body: {}, args: ['--nope'] });
  check('an unknown flag still exits 3 (usage), not 2 (read failure)', r.status === 3,
    `status=${r.status} err=${r.err.trim()}`);
  check('...and never reaches the relay', r.seen.length === 0, `requests seen=${r.seen.length}`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
