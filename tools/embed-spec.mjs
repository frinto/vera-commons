#!/usr/bin/env node
/**
 * embed-spec.mjs — put the frozen specification on the wire, byte for byte.
 *
 * WHY THIS EXISTS
 *   The descriptor publishes `spec.sha256` of `spec/COMMONS-SPEC.md` and warns a joining
 *   agent: "If your copy differs, trust neither copy." Until the relay served a copy, that
 *   warning was unactionable from the wire — an agent talking to the relay over HTTP had no
 *   way to obtain the document the digest was a digest OF, and had to find the repository
 *   first. A digest with no document behind it is decoration, which is the same defect class
 *   verify-spec-freeze.mjs names in its own header: a promise in prose is not a control.
 *
 * WHY BASE64 AND NOT A STRING LITERAL
 *   A Cloudflare Worker cannot read the filesystem, and worker/wrangler.toml declares no
 *   text-module rule, so the bytes must ship inside the module graph. They are carried as
 *   base64 because that is the one encoding with no degrees of freedom: a JS string literal
 *   would have to survive JSON escaping, and any future editor, newline normalization or BOM
 *   would change the served bytes while every check that hashes the FILE still passed. The
 *   decoded bytes are compared to the file by tools/verify-discovery.mjs and by
 *   test/spec-served.test.mjs.
 *
 *   node tools/embed-spec.mjs           rewrite worker/spec-bundle.js
 *   node tools/embed-spec.mjs --check   fail if it is stale (wired into npm test)
 *
 * EXIT CODES
 *   0  written, or up to date
 *   1  --check found the bundle stale, or the file digest disagrees with SPEC_SHA256
 *   2  instrument failure (spec or constants unreadable, or no version on line 1)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SPEC_VERSION, SPEC_SHA256 } from '../worker/spec-constants.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = join(ROOT, 'spec', 'COMMONS-SPEC.md');
const OUT = join(ROOT, 'worker', 'spec-bundle.js');

const checkOnly = process.argv.includes('--check');

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

if (!existsSync(SPEC)) fail(2, `embed-spec: cannot read ${SPEC}`);

const specBytes = readFileSync(SPEC);
const digest = createHash('sha256').update(specBytes).digest('hex');
const versionMatch = /specification v([0-9]+\.[0-9]+)/.exec(specBytes.toString('utf8'));
if (!versionMatch) fail(2, 'embed-spec: no "specification vX.Y" on line 1 of the spec');
const specVersion = versionMatch[1];

// The bundle must carry the digest the relay ADVERTISES, and the relay advertises whatever
// worker/spec-constants.js says. If the spec file moved without the constants moving, the
// relay would hand out a document that fails its own published digest — so this is a hard
// stop rather than a warning, and it fails --check as well as a write.
if (digest !== SPEC_SHA256) {
  fail(
    1,
    `embed-spec: spec/COMMONS-SPEC.md hashes to ${digest.slice(0, 16)}… but the worker advertises ${SPEC_SHA256.slice(0, 16)}…\n` +
      '           The relay would be serving a document that fails its own published digest.\n' +
      '           Bump SPEC_SHA256/SPEC_VERSION in worker/spec-constants.js (tools/verify-spec-freeze.mjs --freeze records the freeze).',
  );
}
if (specVersion !== SPEC_VERSION) {
  fail(
    1,
    `embed-spec: the spec declares v${specVersion} but the worker advertises v${SPEC_VERSION}.`,
  );
}

const b64 = specBytes.toString('base64');
const CHUNK = 100;
const chunks = [];
for (let i = 0; i < b64.length; i += CHUNK) chunks.push(`  '${b64.slice(i, i + CHUNK)}',`);

const body = [
  '// GENERATED FILE — do not edit by hand.',
  '//',
  '// Source: spec/COMMONS-SPEC.md',
  `//   version ${specVersion}`,
  `//   sha256  ${digest}`,
  `//   length  ${specBytes.length} bytes`,
  '//',
  '// Regenerate with:  node tools/embed-spec.mjs',
  '// Staleness is checked with:  node tools/embed-spec.mjs --check  (wired into npm test)',
  '//',
  '// The relay serves these exact bytes at /spec.md so that the digest it publishes in its',
  '// descriptor can be checked by anyone who can reach the relay — without cloning the repo.',
  '// Base64 so that no escaping rule stands between the file and the wire.',
  '',
  'export const SPEC_B64 = [',
  ...chunks,
  "].join('');",
  '',
  `export const SPEC_BYTES = ${specBytes.length};`,
  `export const SPEC_DIGEST = '${digest}';`,
  '',
].join('\n');

if (checkOnly) {
  if (!existsSync(OUT)) fail(1, 'embed-spec --check: worker/spec-bundle.js is missing — run node tools/embed-spec.mjs');
  const current = readFileSync(OUT, 'utf8');
  if (current !== body) {
    fail(
      1,
      'embed-spec --check: worker/spec-bundle.js is STALE — the served spec would differ from spec/COMMONS-SPEC.md.\n' +
        '           Run: node tools/embed-spec.mjs',
    );
  }
  process.stdout.write(`  ok   spec bundle is current (v${specVersion}, ${specBytes.length} bytes, ${digest.slice(0, 16)}…)\n`);
  process.exit(0);
}

writeFileSync(OUT, body);
process.stdout.write(
  `embed-spec: wrote worker/spec-bundle.js — v${specVersion}, ${specBytes.length} bytes, sha256 ${digest.slice(0, 16)}…\n`,
);
