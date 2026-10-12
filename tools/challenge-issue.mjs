/**
 * Issue ONE admission challenge to a joining key, as a separate process, and write out the file
 * handed to the joining agent.
 *
 * WHAT GOES IN THE FILE, and why:
 *   - the challenge: premises and hypotheses, in plain text. The agent must answer these.
 *   - THE KNOWLEDGE BASE. It is public by design and it MUST travel with the challenge.
 *
 * That second point was measured the hard way. A first trial handed a real external agent the
 * challenge WITHOUT the taxonomy and it scored 85/150 = 56.7% against a 95% bar. The reason is not
 * that the agent reasoned badly: the expected answers come from THIS taxonomy, and a synthetic
 * taxonomy does not agree with world knowledge on every edge. Withholding the KB does not make the
 * gate harder in a useful way — it makes the gate UNPASSABLE, and a gate that can never open is
 * not a gate, it is a wall. Reasoning over a published taxonomy is the task.
 *
 * WHAT NEVER GOES IN THE FILE: the salt. The salt is what turns a seed into a scoreable challenge,
 * it prevents precomputation, and it lives only on the operator's stick. This tool asserts the
 * salt's absence against the EXACT BYTES it writes, which is a stronger check than scanning keys.
 *
 *   node tools/challenge-issue.mjs <verifier.json> <join-key> <out.json>
 */

import { writeFileSync } from 'node:fs';

import { createAdmissionManager } from '../src/admission.mjs';
import { loadVerifierFile, resolveAdmissionsDir } from '../src/verifier-path.mjs';

/**
 * Keys that must never appear in the file handed to a joining agent.
 * `kb` and `chains` are deliberately NOT here: the taxonomy is public and must be published with
 * the challenge. The salt check below is the real guard.
 */
const FORBIDDEN_KEYS = ['salt', 'expected', 'answer', 'answers', 'key'];

function assertPublicOnly(node) {
  const seen = [];
  const walk = (n, path) => {
    if (n === null || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n)) {
      if (FORBIDDEN_KEYS.includes(k.toLowerCase())) seen.push(`${path}.${k}`);
      walk(v, `${path}.${k}`);
    }
  };
  walk(node, '$');
  if (seen.length > 0) {
    throw new Error(`challenge-issue: refusing to write a challenge that carries ${seen.join(', ')}`);
  }
}

export function issue({ verifierPath, joinKey }) {
  const verifier = loadVerifierFile(verifierPath);
  const dir = resolveAdmissionsDir(verifier, verifierPath);
  const mgr = createAdmissionManager({
    dir,
    salt: verifier.salt,
    kb: verifier.kb,
    items: verifier.items,
    windowMs: verifier.windowMs,
  });

  const started = mgr.start(joinKey);
  // start() returns a nested {id, challenge}. Accept a flat challenge too, so the tool does not
  // silently write a wrapper object the day the library changes shape.
  const challenge = started && typeof started === 'object' && started.challenge ? started.challenge : started;
  assertPublicOnly(challenge);

  const id = (started && started.id) || null;
  const doc = { admissionId: id, challenge, kb: verifier.kb };
  const serialized = `${JSON.stringify(doc, null, 2)}\n`;

  // The strongest leak check available: search the exact bytes that will be written. A key-walk can
  // miss a salt nested in an unexpected place or embedded in a string; this cannot.
  if (serialized.includes(verifier.salt)) {
    throw new Error('challenge-issue: REFUSING TO WRITE — the salt appears in the output bytes');
  }

  return { doc, serialized, id, dir, itemCount: challenge?.items?.length ?? verifier.items };
}

function main() {
  const [verifierPath, joinKey, out] = process.argv.slice(2);
  if (!verifierPath || !joinKey || !out) {
    process.stderr.write('usage: node tools/challenge-issue.mjs <verifier.json> <join-key> <out.json>\n');
    return 2;
  }
  let result;
  try {
    result = issue({ verifierPath, joinKey });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
  writeFileSync(out, result.serialized);

  const chains = result.doc.kb?.chains?.length ?? 0;
  process.stdout.write(`issued a challenge to ${joinKey}\n`);
  process.stdout.write(`  admission id:   ${result.id ?? '(not reported by the store)'}\n`);
  process.stdout.write(`  written to:     ${out}  (${result.serialized.length} bytes)\n`);
  process.stdout.write(`  items:          ${result.itemCount}\n`);
  process.stdout.write(`  window:         ${result.doc.challenge?.windowMs} ms\n`);
  process.stdout.write(`  knowledge base: ${chains} chains PUBLISHED (public by design — the task is to reason over it)\n`);
  process.stdout.write('  salt:           ABSENT — verified against the written bytes, not just the keys\n');
  return 0;
}

// Guard against importing this module for its exported helper and accidentally running the CLI.
if (process.argv[1] && process.argv[1].endsWith('challenge-issue.mjs')) {
  process.exitCode = main();
}
