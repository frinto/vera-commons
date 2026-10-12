/**
 * Catches a class of breakage that every existing check walks straight past.
 *
 * `console/public/index.html` is the human admin's ONLY interface, and its behaviour lives in one
 * large inline <script>. Nothing verified that script parses. `deploy-stick.mjs` fetches the served
 * page and greps it for markers ("withdraw", "revokeHolder", the root-not-revocable note) -- all of
 * which are HTML text that survives untouched if the JAVASCRIPT below them is syntactically broken.
 * So the deploy would report "the console is deployed AND it runs", the page would serve HTTP 200,
 * and every button in it would be dead.
 *
 * This asserts the weaker but load-bearing property: each inline block compiles. `vm.Script` is used
 * rather than `new Function` because it compiles as a CLASSIC script, which is exactly how a browser
 * treats a <script> without type="module" -- so the check models the real thing instead of a
 * near-miss. It compiles and does NOT run, so nothing here executes page code.
 *
 * What it does NOT do: it cannot prove the UI WORKS, only that it is not dead on arrival. Behaviour
 * is the trials' job.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PAGE = join(ROOT, 'console', 'public', 'index.html');
const HTML = readFileSync(PAGE, 'utf8');

/** Inline blocks only: a block with src= is an external file and is parsed where it lives. */
function inlineScripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

test('the admin page has inline JavaScript at all', () => {
  // Without this the parse test below passes vacuously on a page whose script moved to a src= file.
  const blocks = inlineScripts(HTML);
  assert.ok(blocks.length >= 1, 'expected at least one inline <script> block');
  assert.ok(blocks.some((b) => b.trim().length > 500), 'the main UI script should not be a stub');
});

test('every inline script in the admin page compiles', () => {
  const blocks = inlineScripts(HTML);
  blocks.forEach((src, i) => {
    assert.doesNotThrow(
      () => new vm.Script(src, { filename: `index.html inline block ${i}` }),
      `inline script ${i} must parse — a syntax error here serves HTTP 200 and leaves the UI dead`,
    );
  });
});

test('the withdrawal UI markers the deploy greps for are still present', () => {
  // Pinned here so the two checks stay honest about each other: deploy-stick asserts these are in the
  // SERVED bytes, and this asserts they exist in the source it deploys.
  assert.match(HTML, /revokeHolder/);
  assert.match(HTML, /root — revoke by editing trust\.json/);
});
