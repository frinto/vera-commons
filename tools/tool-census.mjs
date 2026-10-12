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

export function buildCensus() {
  const names = readdirSync(TOOLS).filter(f => f.endsWith('.mjs')).sort();
  const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8');

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
      const body = readFileSync(p, 'utf8');
      if (!body.includes(name)) continue;                     // cheap reject before line scanning
      for (const line of body.split(/\r?\n/)) {
        if (!line.includes(name)) continue;
        // Two ways to invoke a file: programmatically (spawn/execFile/exec), or by handing the path to
        // an interpreter. The second is how every shell caller works -- a PowerShell line reading
        // `node tools/verify-feed.mjs ...` contains no spawn() at all, so a rule that only looked for
        // spawn() reported tools invoked from verify-worker-local.ps1 as never invoked.
        const programmatic = /(spawn|execFile|execSync|exec)\s*\(/.test(line);
        const interpreted = /\b(node|npx|powershell|pwsh|bash|sh|cmd)\b[^\n]*tools[\\/]/i.test(line)
          && !/^\s*(\/\/|#|\*)/.test(line);          // a commented-out line is not an invocation
        if (programmatic || interpreted) { via = via ?? 'invoked'; }
        else if (/^\s*(import|const|let|var)\b.*(from|require)\s*\(?\s*['"][^'"]*tools[\\/]/.test(line)
          && !/^\s*(\/\/|\*)/.test(line)) { via = via ?? 'import'; }
      }
    }
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
    '| tool | args | writes | net | lines | purpose |',
    '| --- | --- | --- | --- | --- | --- |',
    ...list.map(r => `| \`${r.name}\` | ${r.args ? 'yes' : '-'} | ${r.writes ? 'YES' : '-'} | ${r.net ? 'yes' : '-'} | ${r.lines} | ${r.purpose ?? '*(no header comment)*'} |`),
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

\`wired\` means something in this repository invokes it: named in \`package.json\`, named by a file under
\`test/\`, or spawned/exec'd from another source file. A mention inside a prose comment does **not**
count — counting mentions that way once made a tool look wired while nothing ran it.

## Wired (${wired.length}) — something invokes it

${table(wired)}

## Unwired (${unwired.length}) — nothing invokes it, so a human must know it exists

${table(unwired)}

A tool being unwired is not automatically a defect: some are deliberate one-offs, and some are the
only correct interface for a job a human does by hand (minting a root key, moving a block once). What
is a defect is a tool being unwired *and unknown*. Wiring one of these means giving it a test, an npm
script, or a caller — \`verify-admission.mjs\` and \`verify-seed.mjs\` were wired that way.
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
