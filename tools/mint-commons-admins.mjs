// Mint the Agent Commons administrative keys.
//
// STRUCTURE (and why it is not just two keys):
//
//     commons root  (held by the user, break-glass, offline)
//          |
//          +--grant admin-->  user admin key      (daily use)
//          +--grant admin-->  Vera admin key      (the agent)
//
// The root is deliberately SEPARATE from the user's daily key. If the daily key is ever
// exposed, the root can revoke it — and revocation is transitive, so anything that daily
// key granted dies with it. If the root had no separate existence, losing the one key
// would mean losing the ability to revoke anything.
//
// The root private key is written to disk once and never printed. Only PUBLIC ids are
// shown, so this tool is safe to run with its output on screen.
//
// Run: node tools/mint-commons-admins.mjs [--dir .keys]

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { generateIdentity, shortId } from '../src/identity.mjs';
import { issuePermit, exportTrustBundle, resolveTrust } from '../src/permit.mjs';

const argv = process.argv.slice(2);
const dirIndex = argv.indexOf('--dir');
const DIR = resolve(dirIndex >= 0 ? argv[dirIndex + 1] : '.keys');

function writeKey(name, identity) {
  const p = join(DIR, `${name}.json`);
  if (existsSync(p)) {
    console.error(`REFUSING to overwrite ${p}`);
    console.error('These keys are not regenerable. Move the existing file aside, or pick another --dir.');
    process.exit(1);
  }
  writeFileSync(p, `${JSON.stringify(identity, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return p;
}

mkdirSync(DIR, { recursive: true });

const root = generateIdentity();
const userAdmin = generateIdentity();
const veraAdmin = generateIdentity();

const permits = [
  issuePermit(root, { type: 'grant', grantee: userAdmin.agentId, level: 'admin', seq: 1 }),
  issuePermit(root, { type: 'grant', grantee: veraAdmin.agentId, level: 'admin', seq: 2 }),
];

const bundle = exportTrustBundle({ permits, roots: [root.agentId] });

const files = {
  root: writeKey('commons-root', root),
  user: writeKey('user-admin', userAdmin),
  vera: writeKey('vera-admin', veraAdmin),
  trust: join(DIR, 'trust.json'),
};
writeFileSync(files.trust, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: 'utf8' });

// Re-derive every level from the public bundle alone — the same check any stranger can run.
const { levels, rejected } = resolveTrust(bundle.permits, bundle.roots);

console.log('Agent Commons administrative keys minted.\n');
console.log(`directory          ${DIR}`);
console.log('');
console.log('PUBLIC IDENTIFIERS (safe to publish — private keys stayed on disk):');
console.log(`  commons root   ${root.agentId}`);
console.log(`                 short ${shortId(root.agentId)}   file ${files.root}`);
console.log(`  user admin     ${userAdmin.agentId}`);
console.log(`                 short ${shortId(userAdmin.agentId)}   file ${files.user}`);
console.log(`  vera admin     ${veraAdmin.agentId}`);
console.log(`                 short ${shortId(veraAdmin.agentId)}   file ${files.vera}`);
console.log(`  trust bundle   ${files.trust}`);
console.log('');
console.log('RESOLVED LEVELS (recomputed from the public bundle, exactly as a stranger would):');
for (const [id, level] of levels) console.log(`  ${shortId(id)}  ${id}\n            ${level}`);
console.log('');
console.log(rejected.length === 0
  ? 'OK   every permit verified; no rejections.'
  : `FAIL ${rejected.length} permit(s) rejected.`);
console.log('');
console.log('NEXT STEPS');
console.log('  1. Move the commons-root key somewhere offline. It is the only key that can revoke.');
console.log('  2. Publish trust.json and the three PUBLIC ids so peers can verify authority.');
console.log('  3. Never commit the directory — it holds private keys.');

process.exit(rejected.length === 0 ? 0 : 1);
