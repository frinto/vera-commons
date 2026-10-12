/**
 * Guards the fix for a verdict that blamed the code for a missing ceremony.
 *
 * On a volume with no operator key, `deploy-stick.mjs` used to fail 8 checks and end with
 * "the stick is NOT deployable as it stands" -- while the deployment was in fact perfect and the tool
 * itself refuses to create those secrets. The remedy for the two situations is completely different
 * (run the key ceremony vs. debug code), so they must not share a verdict or an exit code.
 *
 * The decisive assertions here are: an unmet precondition NEVER produces the deployment-failed exit
 * code, and the wiring in deploy-stick is what the tests claim it is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { classifyStickVolume, PRECONDITION_EXIT } = await import('../tools/stick-preconditions.mjs');
const DEPLOY = readFileSync(join(ROOT, 'tools', 'deploy-stick.mjs'), 'utf8');

const met = { hasUserAdmin: true, hasTrust: true };

test('a fully provisioned volume is an operator volume, with no complaint', () => {
  const v = classifyStickVolume(met);
  assert.equal(v.ok, true);
  assert.equal(v.code, 'operator_volume');
  assert.equal(v.exitCode, 0);
  assert.equal(v.missing.length, 0);
  assert.equal(v.verdict, '');
});

test('a missing key is a PRECONDITION, not a deployment failure', () => {
  const v = classifyStickVolume({ hasUserAdmin: false, hasTrust: true });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'no_operator_credentials');
  assert.equal(v.exitCode, PRECONDITION_EXIT);
  // The whole point: this must not be confused with "the deployment failed" (exit 1).
  assert.notEqual(v.exitCode, 1);
  assert.notEqual(v.exitCode, 0);
});

test('each missing secret is named, and both are named when both are absent', () => {
  assert.deepEqual(classifyStickVolume({ hasUserAdmin: false, hasTrust: true }).missing, ['user-admin.json']);
  assert.deepEqual(classifyStickVolume({ hasUserAdmin: true, hasTrust: false }).missing, ['trust.json']);
  assert.deepEqual(
    classifyStickVolume({ hasUserAdmin: false, hasTrust: false }).missing,
    ['user-admin.json', 'trust.json'],
  );
});

test('the message must not read as code breakage, and must say the code deployed', () => {
  for (const facts of [{ hasUserAdmin: false, hasTrust: true }, { hasUserAdmin: true, hasTrust: false }, { hasUserAdmin: false, hasTrust: false }]) {
    const v = classifyStickVolume(facts);
    const all = [v.headline, ...v.detail, v.verdict].join('\n');
    assert.match(all, /THE CODE IS DEPLOYED/, 'the operator must be told the deployment itself worked');
    assert.match(all, /not yet an operator volume/i);
    // The exact wording that caused the bug, in any casing, must not reappear.
    assert.doesNotMatch(all, /NOT deployable/i, 'the false verdict must never be produced for a missing key');
    assert.doesNotMatch(all, /is broken/i);
  }
});

test('it explains WHY it will not just create the missing file', () => {
  const v = classifyStickVolume({ hasUserAdmin: false, hasTrust: false });
  const all = [v.headline, ...v.detail, v.verdict].join('\n');
  assert.match(all, /SECRETS/);
  assert.match(all, /SECOND commons authority/, 'the real reason not to mint a key must be stated');
  assert.match(all, /503/, 'and the operator must be told the console is right to refuse');
});

test('it points at a remedy rather than only at the problem', () => {
  const v = classifyStickVolume({ hasUserAdmin: false, hasTrust: false });
  const all = [v.headline, ...v.detail, v.verdict].join('\n');
  assert.match(all, /admission-ceremony\.mjs/);
  assert.match(all, /run this tool again/i, 're-running must be presented as safe');
});

test('the drive is named in the listing, so a multi-drive machine cannot be ambiguous', () => {
  const v = classifyStickVolume({ hasUserAdmin: false, hasTrust: true, drive: 'V:\\' });
  // Assert on the LISTING line specifically. Asserting on the whole message would be wrong: the remedy
  // paragraph legitimately says the credentials belong "at the drive root", which is not a fallback.
  assert.equal(v.detail[0], 'absent from V:\\: user-admin.json');
  // ...and it falls back sensibly when no drive is supplied.
  const fallback = classifyStickVolume({ hasUserAdmin: false, hasTrust: true });
  assert.equal(fallback.detail[0], 'absent from the drive root: user-admin.json');
});

test('deploy-stick is actually WIRED to the classifier, and exits on its code', () => {
  assert.match(DEPLOY, /import\('\.\/stick-preconditions\.mjs'\)/, 'the module must be imported');
  assert.match(DEPLOY, /classifyStickVolume\(\{/, 'the classifier must be called');
  assert.match(DEPLOY, /process\.exit\(pre\.exitCode\)/, 'the exit code must come from the verdict');
  // RED ARM: if the gate is passed over, the old false verdict returns for a keyless volume.
  assert.match(DEPLOY, /if \(!pre\.ok\) \{/, 'an unmet precondition must take the gate branch');
});

test('the gate runs BEFORE the console is started, not after', () => {
  const gate = DEPLOY.indexOf('if (!pre.ok) {');
  const start = DEPLOY.indexOf('--- 3. START IT');
  const layout = DEPLOY.indexOf('--- the layout the console actually imports from ---');
  assert.ok(layout > 0 && gate > 0 && start > 0, 'all three sections must exist to be ordered');
  assert.ok(layout < gate, 'the layout is reported before the precondition is judged');
  assert.ok(gate < start, 'the gate must precede the console start, or the failures it prevents still happen');
});

test('an absent secret is not printed as a failed file check', () => {
  // The two secret entries must be flagged, so a missing key prints a neutral line instead of "MISSING".
  assert.match(DEPLOY, /\{ p: join\(STICK, 'user-admin\.json'\), secret: true \}/);
  assert.match(DEPLOY, /\{ p: join\(STICK, 'trust\.json'\), secret: true \}/);
  assert.match(DEPLOY, /for \(const \{ p, secret \} of LAYOUT\)/);
  assert.match(DEPLOY, /else if \(secret\) console\.log\(/, 'a secret entry must have its own non-failure branch');
});
