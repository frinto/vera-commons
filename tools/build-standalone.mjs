#!/usr/bin/env node
/**
 * Build a SELF-CONTAINED single-file MCP server out of the layered sources.
 *
 * WHY THIS EXISTS
 * ---------------
 * The MCP on-ramp was only obtainable by cloning the repository. The relay is
 * already live and free, so it can hand the on-ramp out directly — one HTTPS
 * GET, no account, no clone. That requires ONE file with no relative imports.
 *
 * This generator concatenates the closed dependency set of tools/mcp-server.mjs
 * (identity -> message -> policy -> entry), rewrites imports and exports, and
 * emits two artifacts from the same source:
 *
 *   dist/vera-mcp.mjs      the runnable single file
 *   worker/mcp-bundle.js   the same bytes embedded as a JS string literal, so
 *                          the Cloudflare Worker can serve it with no file system
 *
 * The output is NEVER hand-edited. `--check` regenerates in memory and fails if
 * a committed artifact differs, so the copy the relay serves cannot silently
 * drift away from the sources the test suite actually exercises.
 *
 * Usage:
 *   node tools/build-standalone.mjs           write the artifacts
 *   node tools/build-standalone.mjs --check   verify only; exit 1 on drift
 *
 * NOTE ON VERIFICATION (measured 2026-10-12): the first version of this file
 * hardcoded a list of "expected" node: bindings that was recalled from memory
 * instead of read from the sources, and it reported three failures that were
 * artifacts of the wrong list. It also mis-parsed `sign as cryptoSign` by taking
 * the alias target's original name. Both are fixed; the checks below are now
 * derived from the sources themselves, and the real proof that every identifier
 * resolves is that tools/mcp-trial.mjs RUNS the artifact over stdio.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// Dependency order: a module may only reference modules listed BEFORE it.
const MODULES = [
  join(ROOT, 'src', 'identity.mjs'),
  join(ROOT, 'src', 'message.mjs'),
  join(ROOT, 'src', 'frame.mjs'),
  join(ROOT, 'src', 'policy.mjs'),
  join(ROOT, 'tools', 'mcp-server.mjs'),
];
const OUT_STANDALONE = join(ROOT, 'dist', 'vera-mcp.mjs');
const OUT_EMBED = join(ROOT, 'worker', 'mcp-bundle.js');

const CHECK = process.argv.includes('--check');

const IMPORT_RE = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm;
// Handles BOTH `export { a, b };` and the RE-EXPORT form `export { a, b } from './x.mjs';`.
// The re-export matters: src/policy.mjs re-exports the framing from src/frame.mjs so existing
// importers keep working, and a source-level `from` clause that no rule matches would survive
// into the bundle — caught by the self-check as "a relative import survived into the output".
const EXPORT_LIST_RE = /^export\s*\{[^}]*\}\s*(?:from\s*['"][^'"]+['"])?\s*;?[ \t]*$/gm;
const EXPORT_DECL_RE = /^export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm;
// `export default { a, b };` and `export default name;` — dropped whole. Any other
// form of `export default` survives and is caught by selfCheck() below.
const EXPORT_DEFAULT_OBJ_RE = /^export\s+default\s*\{[^}]*\}\s*;?[ \t]*$/gm;
const EXPORT_DEFAULT_NAME_RE = /^export\s+default\s+[A-Za-z_$][\w$]*\s*;?[ \t]*$/gm;

/**
 * Strip imports, accumulating every node: builtin binding into `builtins`.
 * Keyed by LOCAL name (the identifier actually bound at the call site), so an
 * aliased import `sign as cryptoSign` is emitted as `sign as cryptoSign` and not
 * as `sign` — which would leave `cryptoSign` unresolved at runtime.
 */
function stripImports(src, builtins, relPath) {
  return src.replace(IMPORT_RE, (_whole, clause, spec) => {
    if (!spec.startsWith('node:')) return ''; // relative -> satisfied by an earlier inlined module
    if (!builtins.has(spec)) builtins.set(spec, new Map());
    const into = builtins.get(spec);

    const braced = clause.match(/\{([\s\S]*)\}/);
    if (!braced) {
      // default import: `import crypto from 'node:crypto'`
      const local = clause.trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(local)) throw new Error(`unhandled import clause in ${relPath}: ${clause.trim()}`);
      into.set(local, local);
      return '';
    }
    for (const part of braced[1].split(',')) {
      const entry = part.trim();
      if (!entry) continue;
      const alias = entry.split(/\s+as\s+/);
      const local = (alias[1] ?? alias[0]).trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(local)) throw new Error(`unhandled import binding in ${relPath}: ${entry}`);
      into.set(local, entry.replace(/\s+/g, ' '));
    }
    return '';
  });
}

function stripExports(src) {
  return src
    .replace(EXPORT_LIST_RE, '')
    .replace(EXPORT_DEFAULT_OBJ_RE, '')
    .replace(EXPORT_DEFAULT_NAME_RE, '')
    .replace(EXPORT_DECL_RE, '');
}

const sha16 = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

function build() {
  const builtins = new Map();
  const bodies = [];
  const provenance = [];
  let shebang = '#!/usr/bin/env node';

  for (const file of MODULES) {
    const raw = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file).split('\\').join('/');
    provenance.push([rel, sha16(raw), raw.split('\n').length]);

    let body = stripExports(stripImports(raw, builtins, rel)).trim();
    if (body.startsWith('#!')) {
      const firstBreak = body.indexOf('\n');
      shebang = body.slice(0, firstBreak).trim();
      body = body.slice(firstBreak + 1).trim();
    }
    const banner = `// ${'─'.repeat(76)}\n// inlined from ${rel}\n// ${'─'.repeat(76)}`;
    bodies.push(`${banner}\n${body}\n`);
  }

  const importBlock = [...builtins.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([spec, names]) => `import { ${[...names.values()].sort().join(', ')} } from '${spec}';`)
    .join('\n');

  const header = [
    shebang,
    '//',
    '// vera-commons — self-contained MCP server (GENERATED FILE — DO NOT EDIT)',
    '//',
    '// Regenerate with:  node tools/build-standalone.mjs',
    '// Verify with:      node tools/build-standalone.mjs --check',
    '//',
    '// This file is the concatenation of the modules below by tools/build-standalone.mjs.',
    '// It exists so the on-ramp can be delivered as a single HTTPS GET, with no clone.',
    '// Every property it claims is tested by tools/mcp-trial.mjs running against THIS file.',
    '//',
    '// Provenance (sha256, first 16 hex chars, of each source at generation time):',
    ...provenance.map(([rel, hash, lines]) => `//   ${hash}  ${String(lines).padStart(4)} lines  ${rel}`),
    '//',
    importBlock,
    '',
  ].join('\n');

  const src = `${header}\n${bodies.join('\n')}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  return { src, builtins };
}

/** Fail loudly rather than emit something that cannot run. */
function selfCheck(src, builtins) {
  const problems = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^export\b/.test(line)) problems.push(`line ${i + 1}: leftover export -> ${line.trim().slice(0, 70)}`);
    if (/^import\b/.test(line) && !/from 'node:/.test(line)) {
      problems.push(`line ${i + 1}: non-builtin import survived -> ${line.trim().slice(0, 70)}`);
    }
  }
  // The emitted import block must bind EXACTLY the local names the sources used:
  // derived from the sources, never from a remembered list.
  const emitted = new Map();
  for (const m of src.matchAll(/^import \{([^}]*)\} from '(node:[^']+)';$/gm)) {
    for (const part of m[1].split(',')) {
      const entry = part.trim();
      if (!entry) continue;
      emitted.set((entry.split(/\s+as\s+/)[1] ?? entry).trim(), m[2]);
    }
  }
  for (const [spec, names] of builtins) {
    for (const [local, entry] of names) {
      if (!emitted.has(local)) problems.push(`binding collected from sources but missing in output: ${local} (${spec})`);
      else if (emitted.get(local) !== spec) problems.push(`binding ${local} bound to ${emitted.get(local)} but used from ${spec}`);
      else if (!src.includes(entry)) problems.push(`binding ${local} lost its alias form: expected '${entry}'`);
    }
  }
  if (builtins.size === 0) problems.push('no node: builtin imports were collected at all — the parse found nothing');
  if (/from '\.\.?\//.test(src)) problems.push('a relative import survived into the output');
  return problems;
}

const { src: standalone, builtins: collectedBuiltins } = build();
const problems = selfCheck(standalone, collectedBuiltins);
if (problems.length) {
  console.error('STANDALONE BUILD FAILED SELF-CHECK:');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}

// JSON.stringify produces a valid JS string literal, and unlike a template literal
// it cannot be broken by a backtick or a ${ in the payload.
const bundleSha = createHash('sha256').update(standalone).digest('hex');
// BYTES, not JS string length. The artifact contains multi-byte UTF-8 (the box-drawing
// rules in its banners), so `standalone.length` is a CHARACTER count and under-reports
// the wire size — measured 27644 chars vs 29196 bytes. A header labelled "bytes" that
// reports characters is exactly the kind of small lie that discredits a digest.
const bundleBytes = Buffer.byteLength(standalone, 'utf8');
const embed = [
  '// GENERATED FILE — DO NOT EDIT.  Source: tools/build-standalone.mjs',
  '// The self-contained MCP server, embedded as a string so the Worker can serve it',
  '// without a file system. Regenerate: node tools/build-standalone.mjs',
  '',
  '// sha256 and exact UTF-8 byte length of MCP_STANDALONE, published on the download',
  '// so a client can verify what it received.',
  `export const MCP_SHA256 = ${JSON.stringify(bundleSha)};`,
  `export const MCP_BYTES = ${bundleBytes};`,
  '',
  `export const MCP_STANDALONE = ${JSON.stringify(standalone)};`,
  '',
].join('\n');

// --- the Worker's copy of the untrusted-content framing ---------------------
// NOT a re-implementation. This is src/frame.mjs carried VERBATIM, so the relay applies the
// identical fence the Node side applies. A second implementation would drift, and the drifted
// copy would be the silent weak one — the failure mode this whole project exists to avoid.
// It is generated, digest-checked by --check, and refused if it ever grows an import.
const frameSource = readFileSync(join(ROOT, 'src', 'frame.mjs'), 'utf8');
const frameSha = createHash('sha256').update(frameSource, 'utf8').digest('hex');
const frameBytes = Buffer.byteLength(frameSource, 'utf8');
{
  // Test the CODE, not the prose. The first version of this guard fired on frame.mjs's own
  // header comment, which explains that policy.mjs imports node:fs and that this module uses
  // no Buffer — the words were in the explanation, not in the code. Strip comments first;
  // a guard that reads documentation as evidence is the same defect class as a check that
  // cannot fail, just pointed the other way.
  const frameCode = frameSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const bad = [];
  if (/^\s*import\b/m.test(frameCode)) bad.push('src/frame.mjs gained an import — it must stay pure');
  if (/\bnode:/.test(frameCode)) bad.push('src/frame.mjs references a node: builtin — the Worker has none');
  if (/\bBuffer\b/.test(frameCode)) bad.push('src/frame.mjs references Buffer — the Worker has TextEncoder, not Buffer');
  if (!/^export /m.test(frameCode)) bad.push('src/frame.mjs stopped exporting anything — the Worker would import nothing');
  if (bad.length) {
    console.error('FRAME BUNDLE REFUSED:');
    for (const b of bad) console.error('  ' + b);
    process.exit(1);
  }
}
const frameBundle = [
  '// GENERATED FILE — DO NOT EDIT.  Source: src/frame.mjs via tools/build-standalone.mjs',
  '//',
  '// The untrusted-content framing, carried verbatim into the Cloudflare Worker so the relay',
  '// renders peer messages with the IDENTICAL fence the Node side uses.',
  '//',
  `// source sha256: ${frameSha}`,
  `// source bytes:  ${frameBytes}`,
  '// Regenerate:    node tools/build-standalone.mjs',
  '',
  frameSource.trimEnd(),
  '',
].join('\n');
const OUT_FRAME = join(ROOT, 'worker', 'frame-bundle.js');

if (CHECK) {
  const drift = [];
  for (const [path, want] of [[OUT_STANDALONE, standalone], [OUT_EMBED, embed], [OUT_FRAME, frameBundle]]) {
    const rel = relative(ROOT, path).split('\\').join('/');
    if (!existsSync(path)) drift.push(`${rel}: MISSING`);
    else if (readFileSync(path, 'utf8') !== want) drift.push(`${rel}: DIFFERS from a fresh build of the current sources`);
  }
  if (drift.length) {
    console.error('STANDALONE DRIFT DETECTED:');
    for (const d of drift) console.error('  ' + d);
    console.error('Fix: node tools/build-standalone.mjs');
    process.exit(1);
  }
  console.log(`standalone --check ok  (${bundleBytes} bytes, ${standalone.split('\n').length} lines, ${MODULES.length} sources)`);
} else {
  mkdirSync(dirname(OUT_STANDALONE), { recursive: true });
  writeFileSync(OUT_STANDALONE, standalone);
  writeFileSync(OUT_EMBED, embed);
  writeFileSync(OUT_FRAME, frameBundle);
  console.log(`wrote ${relative(ROOT, OUT_FRAME).split('\\').join('/')}  ${Buffer.byteLength(frameBundle, 'utf8')} bytes  (verbatim src/frame.mjs, source sha256 ${frameSha.slice(0, 16)})`);
  // ★ `standalone.length` is a CHARACTER count. The artifact contains multi-byte UTF-8 (the
  // box-drawing rules in its banners), so printing it next to the word "bytes" under-reports
  // the wire size — measured 29703 chars vs 31565 real bytes. This is the same mislabel that
  // was fixed for the x-ac-bytes response header; it survived here in the console output, so
  // a reader comparing the build log against a downloaded file would think the download was
  // corrupt. Report bytes wherever the word bytes appears.
  console.log(`wrote ${relative(ROOT, OUT_STANDALONE).split('\\').join('/')}  ${bundleBytes} bytes, ${standalone.split('\n').length} lines`);
  console.log(`wrote ${relative(ROOT, OUT_EMBED).split('\\').join('/')}  ${Buffer.byteLength(embed, 'utf8')} bytes`);
  console.log(`sha256 ${createHash('sha256').update(standalone).digest('hex')}`);
}
