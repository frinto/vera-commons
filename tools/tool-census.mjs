// Generate docs/TOOLS.md: an inventory of everything under tools/, so no tool can sit in the tree
// unremarked.
//
// WHY THIS EXISTS. Two rounds were spent discovering that real verifiers (verify-admission,
// verify-seed) had never been run by anything in this repository -- they take arguments, so they need
// a human who already knows they exist. Nothing in the tree said which tools were wired, which needed
// a human, and which were deliberate one-offs, so the answer had to be re-derived by hand each time.
// This makes the answer a file, and test/tool-census.test.mjs fails when it drifts.
//
// WHAT IT PROVES: that every tools/*.mjs is accounted for in a document a human can read.
// WHAT IT DOES NOT PROVE: that any of them works, or is safe to run. The flags are read STATICALLY
// from the source text -- `args` means the file reads process.argv somewhere, `writes` means it calls a
// write API somewhere, `net` means it calls fetch somewhere. None of those is a verdict. This tool
// deliberately does not execute anything it is describing, because several entries write state.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(ROOT, 'tools');
const OUT = join(ROOT, 'docs', 'TOOLS.md');

/** First line of the file's header comment, or null when it has none. */
function purposeOf(src) {
  for (const raw of src.split(/\r?\n/).slice(0, 15)) {
    const line = raw.trim();
    if (!line) continue;
    // A shebang is not the end of the header. Treating it as one made this census report that
    // tools/verify-store.mjs had no header comment when its header is on the very next line --
    // a false report about a file whose answer I already knew, which is how the bug was caught.
    if (line.startsWith('#!')) continue;
    if (!/^(\/\/|\/\*|\*)/.test(line)) break;          // header ended before any prose
    const text = line.replace(/^(\/\/+|\/\*+|\*+)\s?/, '').trim();
    if (!text || /^usage:/i.test(text) || text === '*/') continue;
    return text;
  }
  return null;
}

// Tokens that mean "this line hands a file to something that will run it". `(spawn|exec)\w*\(` and not
// a list of exact names: the list version spelled out spawn/execFile/execSync/exec, and `execFileSync`
// matches NONE of them (`execFile` is followed by `Sync`), so a tool invoked with the most common call
// in this repository was reported as invoked by nothing.
const SPAWNER = /(spawn|exec)\w*\s*\(/;
const INTERPRETER = /\b(node|npx|powershell|pwsh|bash|sh|cmd)\b[^\n]*tools[\\/]/i;
const IMPORT_OF_TOOLS = /^\s*(import|const|let|var)\b.*(from|require)\s*\(?\s*['"][^'"]*tools[\\/]/;
// How far apart a call and the path it passes may sit: a formatted multi-line call puts them on
// different lines, and a variable assignment can put them in different statements.
const WINDOW = 8;
const isCommentLine = (l) => /^\s*(\/\/|#|\*|\/\*)/.test(l);

/**
 * Does this file's CODE invoke `name`? Exported because a detector whose only inputs are this
 * repository's own files cannot be shown failing, and an assertion that cannot fail is not evidence.
 *
 * FIRST, what kind of file is asking. A markdown document that says `node tools/x.mjs` documents an
 * invocation; it does not perform one. Letting documents count wired tools from this file's own
 * generated document, and made two trial tools look wired because a decision note listed them in a
 * table -- the "a mention is not an invocation" error this file exists to avoid, arriving from a new
 * direction. Only code and shell files can invoke anything.
 *
 * Then, four shapes count:
 *   1. the name on a line that is itself a spawn call, or an interpreter call (`node tools/x.mjs`) --
 *      which is how every shell caller works, and which contains no spawn() at all
 *   2. an import of ../tools/<name>
 *   3. the QUOTED name within WINDOW lines of a spawn call, because a formatted call reads
 *        execFileSync(process.execPath, [
 *          join(HERE, 'verify-admission.mjs'),
 *      and puts the call and the path on different lines
 *   4. the quoted name bound to a variable that a spawn call then passes, because a test holds its
 *      tool in `const TOOL = join(HERE, '../tools/verify-seed.mjs')` and calls `[TOOL, ...args]`
 *
 * Shapes 3 and 4 were missing, and their absence made this census report tools that run on every
 * `npm test` as "nothing invokes it" -- a confident falsehood about the exact question the document
 * exists to answer. A name in a comment, in prose, or in a file that contains no call at all, is not
 * an invocation: counting bare mentions once made a tool look wired while nothing ran it.
 */
export function wiresTool(text, name, file = 'inline.mjs') {
  return wireChannel(text, name, file) !== null;
}

/**
 * WHICH channel matched. Not cosmetic: an IMPORTED tool has its functions exercised by a test while
 * nothing in the repository runs its command-line path -- a weaker claim than "something runs it", and
 * the one a reader needs when deciding whether a tool is actually reachable.
 */
export function wireChannel(text, name, file = 'inline.mjs') {
  const kind = /\.(mjs|js|cjs|ts)$/i.test(file) ? 'code'
    : /\.(ps1|psm1|sh|cmd|bat)$/i.test(file) ? 'shell' : 'doc';
  if (kind === 'doc') return null;
  const canSpawn = kind === 'code';
  const spawnish = (l) => (canSpawn && SPAWNER.test(l)) || INTERPRETER.test(l);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const code = text.split(/\r?\n/).filter(l => !isCommentLine(l));
  // An IMPORT is enough on its own. A test that imports a tool to call its functions invokes it just
  // as much as one that spawns it, and gating this on a spawn token silently UNWIRED two tools whose
  // tests import them (admission-queue-review.mjs, stick-scan.mjs) -- a false "nothing runs this"
  // introduced in the same edit that removed a false "something runs this".
  if (!code.some(spawnish) && !code.some(l => IMPORT_OF_TOOLS.test(l))) return null;
  const quoted = new RegExp(`['"\`][^'"\`]*${escaped}`);
  for (let i = 0; i < code.length; i++) {
    const line = code[i];
    if (!line.includes(name)) continue;
    if (spawnish(line)) return 'spawned';
    if (IMPORT_OF_TOOLS.test(line)) return 'imported';
    if (!quoted.test(line)) continue;                      // a word in prose is not a path
    const lo = Math.max(0, i - WINDOW), hi = Math.min(code.length - 1, i + WINDOW);
    for (let j = lo; j <= hi; j++) {
      if (j !== i && spawnish(code[j])) return 'spawned';
    }
    const bind = line.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
    if (bind) {
      const used = new RegExp(`\\b${bind[1]}\\b`);
      if (canSpawn && code.some((l, j) => j !== i && SPAWNER.test(l) && used.test(l))) return 'spawned';
    }
  }
  return null;
}

/**
 * The trial registry is a real caller whose path is COMPUTED: tools/trial-all.mjs holds
 * `{ id, file: 'tools/x.mjs' }` entries and runs each one with `spawnSync(process.execPath, [abs, ...])`,
 * where `abs` is built from the entry. No rule that needs the path and the call on one line, or even in
 * one window, can see that -- and the registry is the project's single command for the live evidence, so
 * a tool it lists IS invoked by something. Reporting it as "nothing runs this" is exactly the confident
 * falsehood this census exists to prevent.
 *
 * Both halves are required: the entry, and the spawn call that consumes it. A document that merely lists
 * trials wires nothing.
 */
export function inTrialRegistry(registryText, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /spawnSync\s*\(/.test(registryText)
    && new RegExp(`file:\\s*['"]tools/${escaped}['"]`).test(registryText);
}

export function buildCensus() {
  const names = readdirSync(TOOLS).filter(f => f.endsWith('.mjs')).sort();
  const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8');
  const registryPath = join(TOOLS, 'trial-all.mjs');
  const registrySrc = existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : '';

  // Everything a tool could be invoked from, excluding itself. node_modules/.git/.tmp are out: a
  // mention in a dependency or a scratch file is not an invocation by this project.
  const corpus = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.tmp') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      // .ps1 is in this list because leaving it out produced a WRONG census on the first run:
      // tools/verify-feed.mjs and tools/make-message.mjs were reported "unwired" while
      // verify-worker-local.ps1 invokes both of them. A census that misses a whole file type does not
      // report "unknown" -- it reports a confident falsehood, which is worse.
      else if (/\.(mjs|js|json|md|html|ps1|psm1|sh|cmd|bat|yml|yaml)$/i.test(e.name)) corpus.push(p);
    }
  };
  walk(ROOT);

  const rows = names.map((name) => {
    const src = readFileSync(join(TOOLS, name), 'utf8');
    // "invoked" means one of three mechanical things, and NOTHING else:
    //   1. an npm script in package.json names tools/<name>
    //   2. some source line that calls spawn/execFile/exec also names the file
    //   3. some file imports it
    // A mention in prose, in a comment, or inside an assertion message does NOT count. The first
    // version of this counted any mention anywhere under test/, and the number moved the moment this
    // file's own test named two tools in a failure message -- a census whose answer changes when
    // someone writes a sentence about it is not measuring the repository.
    const inPkg = new RegExp(`tools[\\\\/]${name.replace(/\./g, '\\.')}`).test(pkg);
    let via = inPkg ? 'package.json' : null;
    for (const p of corpus) {
      if (p.endsWith(join('tools', name))) continue;
      // The census's own source names every tool inside the document it emits -- including inside the
      // regex literals that define the rule below. A document is not an invocation: without this skip,
      // the census would claim to wire everything it merely describes.
      if (p.endsWith(join('tools', 'tool-census.mjs'))) continue;
      const body = readFileSync(p, 'utf8');
      if (!body.includes(name)) continue;                     // cheap reject before scanning
      // The shape rules live in wiresTool() so a test can drive them with synthetic inputs whose
      // answers are known. Every bug this detector has had was found that way. The path is passed so
      // the rule can tell a caller from a document.
      const channel = wireChannel(body, name, p);
      if (channel) via = via ?? channel;
    }
    if (inTrialRegistry(registrySrc, name)) via = via ?? 'trial registry';
    return {
      name,
      purpose: purposeOf(src),
      args: /process\.argv/.test(src),
      writes: /writeFileSync|appendFileSync|rmSync|unlinkSync|renameSync|copyFileSync|mkdirSync/.test(src),
      net: /fetch\(/.test(src),
      wired: Boolean(via),
      via,
      lines: src.split(/\r?\n/).length,
    };
  });
  return rows;
}

export function renderCensus(rows) {
  const table = (list) => [
    '| tool | args | writes | net | lines | wired via | purpose |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...list.map(r => `| \`${r.name}\` | ${r.args ? 'yes' : '-'} | ${r.writes ? 'YES' : '-'} | ${r.net ? 'yes' : '-'} | ${r.lines} | ${r.via ?? '-'} | ${r.purpose ?? '*(no header comment)*'} |`),
  ].join('\n');

  const wired = rows.filter(r => r.wired);
  const unwired = rows.filter(r => !r.wired);

  return `# tools/ census

**Generated** by \`node tools/tool-census.mjs --write\`. Do not edit by hand: \`test/tool-census.test.mjs\`
regenerates this file and fails if the two differ, so a hand edit is a test failure rather than a
silent divergence.

## What this is, and what it is not

It is an inventory: every \`tools/*.mjs\` appears below under exactly one heading, so no tool can sit in
the tree unremarked.

It is **not** evidence that any tool works, and **not** a safety verdict. Every flag is read statically
from the file's source text. \`args\` means the file reads \`process.argv\` somewhere; \`writes\` means it
calls a write API somewhere; \`net\` means it calls \`fetch\` somewhere. A tool can read argv and still be
harmless; a tool with no flags at all can still be wrong. This generator deliberately executes nothing,
because several entries modify state.

\`wired\` means something in this repository invokes it, and the \`wired via\` column says WHICH channel
matched: \`package.json\` (an npm script names it), \`spawned\` (a source file runs it as a program — the
call may span several lines and the path may be held in a variable), \`imported\` (a source file imports
it as a module, so its functions run while nothing runs its command line), or \`trial registry\` (it is an
entry in \`tools/trial-all.mjs\`, which runs each entry through a computed path). One row reports the first
channel that matched, so the column is a reason to look rather than a proof. A mention inside a comment,
in prose, or in a document does **not** count: counting mentions that way once made a tool look wired
while nothing ran it, and a usage example in a note is a human's instruction, not an invocation.

## Wired (${wired.length}) — something invokes it

${table(wired)}

## Unwired (${unwired.length}) — nothing invokes it, so a human must know it exists

${table(unwired)}

A tool being unwired is not automatically a defect: some are deliberate one-offs, and some are the
only correct interface for a job a human does by hand (minting a root key, moving a block once). What
is a defect is a tool being unwired *and unknown*. Wiring one of these means giving it a test, an npm
script, or a caller — \`verify-admission.mjs\` (spawned by \`tools/verify-store.mjs\`) and
\`verify-seed.mjs\` (spawned by \`test/verify-seed.test.mjs\`) are the worked examples.
`;
}

const isMain = process.argv[1] && process.argv[1].endsWith('tool-census.mjs');
if (isMain) {
  const rows = buildCensus();
  const text = renderCensus(rows);
  if (process.argv.includes('--write')) {
    if (!existsSync(join(ROOT, 'docs'))) mkdirSync(join(ROOT, 'docs'), { recursive: true });
    writeFileSync(OUT, text, 'utf8');
    console.log(`wrote ${OUT}: ${rows.length} tools, ${rows.filter(r => r.wired).length} wired, ${rows.filter(r => !r.wired).length} unwired`);
  } else {
    console.log(text);
  }
}
