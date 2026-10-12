// Read-only inspection of the relay worker's route surface.
// Written as a file because inline node -e escaping mangled the regex.
import fs from 'node:fs';

const candidates = ['worker/worker.js', 'worker/index.js', 'worker/worker.mjs', 'worker/src/worker.js'];
const path = candidates.find((p) => fs.existsSync(p));
if (!path) {
  console.log('  no worker file found among: ' + candidates.join(', '));
  process.exit(0);
}

const s = fs.readFileSync(path, 'utf8');
console.log('  file:', path, s.length, 'B');

// Every string literal that looks like a route.
const routes = [...s.matchAll(/["'`](\/[A-Za-z0-9_/-]*)["'`]/g)].map((m) => m[1]);
const uniq = [...new Set(routes)].sort();
console.log('  route-like literals (' + uniq.length + '):');
for (const r of uniq) console.log('    ' + r);

console.log('  KV binding referenced:', /env\.\w+/.test(s) ? [...new Set([...s.matchAll(/env\.(\w+)/g)].map((m) => m[1]))].join(', ') : 'NONE');
console.log('  proof-of-work logic present:', /pow|difficulty|leadingZero|difficultyBits/i.test(s));
console.log('  export default present:', /export\s+default/.test(s));

// The admission surface is what matters for the remote handshake.
const admission = uniq.filter((r) => /admission/i.test(r));
console.log('  ADMISSION routes currently in the worker: ' + (admission.length ? admission.join(' ') : 'NONE — the remote handshake is not implemented'));
