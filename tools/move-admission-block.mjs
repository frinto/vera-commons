// One-off, deterministic move: relocate the ADMISSION QUEUE block so it no longer sits
// inside the span that tools/cost-model.mjs instruments as "the POST /messages branch".
//
// Why: countOps() slices worker.js from `path === '/messages'` to `path === '/.well-known'`
// and counts kv.put() inside. Inserting the admission block between those two markers made
// its 4 kv.put() calls look like extra writes in the messages branch, so A1
// (one-write-per-message) correctly failed. The instrument is right; the insertion point was
// wrong. This moves the block after the well-known descriptor, restoring the assumption the
// instrument relies on WITHOUT touching the instrument or weakening any check.
import fs from 'node:fs';

const FILE = 'worker/worker.js';
const src = fs.readFileSync(FILE, 'utf8');

const BANNER = '    // ───────────────────────────────────────────────────────────────────────────\n    // ADMISSION QUEUE — the door from outside.';
const WELLKNOWN = '    // The relay holds no keys, so it publishes an UNSIGNED descriptor';
const FINAL_404 = "    return json(404, { ok: false, reason: 'not_found', path });";

const start = src.indexOf(BANNER);
if (start < 0) { console.error('FAIL: admission banner not found'); process.exit(1); }
const wellKnownAt = src.indexOf(WELLKNOWN, start);
if (wellKnownAt < 0) { console.error('FAIL: well-known comment not found after the banner'); process.exit(1); }

const block = src.slice(start, wellKnownAt);
if (!block.includes('/admission/verdict')) { console.error('FAIL: block does not contain the expected routes'); process.exit(1); }
const putCount = block.split('kv.put(').length - 1;
const getCount = block.split('kv.get(').length - 1;
console.log('  extracted block: ' + block.length + ' B, ' + putCount + ' kv.put, ' + getCount + ' kv.get');

// Remove it from its current position.
let out = src.slice(0, start) + src.slice(wellKnownAt);

// Re-insert immediately before the final 404 fallback, which is outside the instrumented span.
const anchor = out.lastIndexOf(FINAL_404);
if (anchor < 0) { console.error('FAIL: final 404 anchor not found'); process.exit(1); }
const lineStart = out.lastIndexOf('\n', anchor) + 1;
out = out.slice(0, lineStart) + block + '\n' + out.slice(lineStart);

fs.writeFileSync(FILE, out, 'utf8');

// Deterministic self-check on the bytes we just wrote.
const after = fs.readFileSync(FILE, 'utf8');
const m = (t, n) => t.split(n).length - 1;
console.log('  after move: file ' + after.length + ' B (was ' + src.length + '), kv.put total ' + m(after, 'kv.put('));
// NOTE: this deliberately does NOT re-implement countOps' slicing. An earlier version of this
// file hand-rolled "1 put + 1 get in the span" and printed PROBLEM, because the span between
// the two markers legitimately also contains the GET branch's read loop. A second, subtly
// different copy of the instrument is how a self-check starts lying. The authority is
// `node tools/cost-model.mjs --self-test`, which reports A1/A2 from the real countOps.
console.log('  -> run `node tools/cost-model.mjs --self-test` for the authoritative verdict');
