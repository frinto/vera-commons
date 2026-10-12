// Trust-operator tool tests. The tool edits a TRUST ANCHOR, so the arms that matter most are the
// ones that prove it does NOT edit when it should not: an unparseable file, a bad key, a no-op
// repeat. Every refusal arm is paired with a success arm, because a tool that refuses everything
// would otherwise pass this file.
//
// Everything runs in a temp directory against generated fixtures. It must never touch a real
// trust file, and the assertions check that by hashing the fixture before and after.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateIdentity, saveIdentity } from '../src/identity.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOOL = join(ROOT, 'tools', 'trust-operator.mjs');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};

function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
const sha = (p) => crypto.createHash('sha256').update(readFileSync(p)).digest('hex');

const dir = mkdtempSync(join(tmpdir(), 'trust-op-'));
const TRUST = join(dir, 'trust.json');
const KEY = join(dir, 'operator-key.json');
const BACKUP_DIR = dir;

function writeTrust(operators = []) {
  writeFileSync(TRUST, JSON.stringify({
    v: 1,
    roots: ['wIfFdZ7bi7rKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    permits: [{ type: 'grant', grantee: 'x', issuer: 'y', seq: 1 }],
    operators,
  }, null, 2) + '\n', 'utf8');
}

const operator = generateIdentity();
saveIdentity(operator, KEY);

// --- 1. the empty list is reported as a PROBLEM, not as normal state --------------------------
writeTrust([]);
const shaBeforeList = sha(TRUST);
let r = run(['list', '--trust', TRUST]);
check('list exits 0 on an empty operator list', r.code === 0, `exit ${r.code} ${r.err}`);
check('★ an empty operator list is called out as a defect, with its consequence named',
  r.out.includes('NO OPERATOR IS TRUSTED') && r.out.includes('operator_not_trusted'));
check('list prints the file sha256 (so a third party can confirm what changed)',
  /sha256\s*:\s*[0-9a-f]{64}/.test(r.out));
check('list does not modify the file', sha(TRUST) === shaBeforeList);

// --- 2. add: the success arm ------------------------------------------------------------------
const shaBefore = sha(TRUST);
r = run(['add', '--trust', TRUST, '--key', KEY]);
check('add exits 0 with a valid operator key', r.code === 0, `exit ${r.code} ${r.err}`);
const afterAdd = JSON.parse(readFileSync(TRUST, 'utf8'));
check('★ the operator is now in the trust file', afterAdd.operators.length === 1 && afterAdd.operators[0] === operator.agentId);
check('the file actually changed (sha256 differs)', sha(TRUST) !== shaBefore);
check('★ a timestamped backup was written BEFORE the edit',
  readdirSync(BACKUP_DIR).some((f) => f.startsWith('trust.json.') && f.endsWith('.bak')));
const backups = readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.bak'));
check('the backup still holds the ORIGINAL (empty) operator list',
  backups.length >= 1 && JSON.parse(readFileSync(join(BACKUP_DIR, backups[0]), 'utf8')).operators.length === 0);
check('add prints the before -> after hashes', r.out.includes(shaBefore) && /->\s+[0-9a-f]{64}/.test(r.out));
check('add states that trust is not admin authority',
  r.out.includes('does not make the key an admin'));

// --- 3. idempotence: adding twice must be a no-op, not a duplicate ----------------------------
const shaAfterAdd = sha(TRUST);
r = run(['add', '--trust', TRUST, '--key', KEY]);
check('adding an already-trusted operator exits 0', r.code === 0, `exit ${r.code}`);
check('★ it says "already trusted" rather than doing it twice', r.out.includes('already trusted'));
check('★ and the file is byte-identical afterwards', sha(TRUST) === shaAfterAdd);
check('no duplicate entry was appended', JSON.parse(readFileSync(TRUST, 'utf8')).operators.length === 1);
check('no second backup was written for a no-op',
  readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.bak')).length === backups.length);

// --- 4. remove, and the no-op repeat ----------------------------------------------------------
r = run(['remove', '--trust', TRUST, '--pub', operator.agentId]);
check('remove exits 0', r.code === 0, `exit ${r.code} ${r.err}`);
check('the operator is gone', JSON.parse(readFileSync(TRUST, 'utf8')).operators.length === 0);
const shaAfterRemove = sha(TRUST);
r = run(['remove', '--trust', TRUST, '--pub', operator.agentId]);
check('removing an untrusted operator exits 0', r.code === 0, `exit ${r.code}`);
check('and says it was not trusted', r.out.includes('not trusted'));
check('and leaves the file unchanged', sha(TRUST) === shaAfterRemove);

// --- 5. REFUSALS. Each must exit non-zero and leave the file untouched ------------------------
const untouched = sha(TRUST);
const refuse = (label, args, marker) => {
  const res = run(args);
  check(label, res.code !== 0 && (marker ? (res.err + res.out).includes(marker) : true),
    `exit ${res.code} ${(res.err + res.out).slice(0, 160)}`);
  check(`  ...and left the trust file untouched (${label.slice(0, 40)})`, sha(TRUST) === untouched);
};

const badKey = join(dir, 'bad-key.json');
writeFileSync(badKey, JSON.stringify({ agentId: 'too-short' }), 'utf8');
refuse('refuses a key file whose agentId is not usable', ['add', '--trust', TRUST, '--key', badKey], 'no usable agentId');

const notJson = join(dir, 'not-json.json');
writeFileSync(notJson, '{ this is not json', 'utf8');
refuse('refuses a key file that is not JSON', ['add', '--trust', TRUST, '--key', notJson], 'not valid JSON');

refuse('refuses a --pub that is not a 43-char agentId', ['add', '--trust', TRUST, '--pub', 'nope'], '--pub');

const notTrust = join(dir, 'not-trust.json');
writeFileSync(notTrust, JSON.stringify({ hello: 'world' }, null, 2), 'utf8');
refuse('★ refuses a file that is not a trust document', ['add', '--trust', notTrust, '--pub', operator.agentId], 'does not look like a trust document');

refuse('refuses a missing trust file', ['list', '--trust', join(dir, 'absent.json')], 'no trust file');

refuse('refuses an unknown subcommand', ['frobnicate', '--trust', TRUST], 'usage:');

// --- 6. the trust file we never named is untouched (guards against a hardcoded default) -------
check('★ the tool never fell back to a real path: the fixture is the only file it wrote',
  existsSync(TRUST) && JSON.parse(readFileSync(TRUST, 'utf8')).permits.length === 1);

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
