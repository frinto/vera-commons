/**
 * mint-verifier.mjs — create the verifier-side secret for agents-only admission.
 *
 * WHAT THIS MAKES, AND WHAT IT MUST NEVER DO
 *
 * The challenge asks a joining agent to decide, for each of 150 generated pairs, whether the
 * hypothesis is ENTAILED by the premise. Two things protect that:
 *
 *   - the SALT, which is a real secret. It seeds item selection, so without it nobody can
 *     precompute an answer sheet for a challenge before it is issued. It lives on the
 *     operator's own node and is never sent to a joining agent and never published.
 *   - the KNOWLEDGE BASE, which is NOT a secret. It is an ordinary English taxonomy. A
 *     capable agent can read the same relations and reason about them; that is the point.
 *     Keeping it public costs nothing, because the gate measures reasoning under a deadline,
 *     not access to hidden data.
 *
 * The secret therefore belongs here, on the user's own machine. It must never move to the
 * relay: a Cloudflare Worker cannot keep a secret from whoever can read the deployment, and
 * a verifier whose salt is public is a verifier anyone can precompute.
 *
 * Refusing to overwrite is deliberate. Re-minting changes the salt, which does not
 * retroactively invalidate anything (answers are checked against the salt recorded with the
 * challenge), but it does mean two different verifiers exist and a pending admission could be
 * scored by the wrong one. Make that an explicit decision, not a side effect.
 */

import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { DEFAULT_PASS_RATIO } from '../src/agency.mjs';

export const VERIFIER_VERSION = 1;

/**
 * An ordinary English taxonomy. Each branch reads from the specific to the general, and the
 * generator turns every root-to-leaf path into a chain, so a five-level branch yields chains
 * of length five and the relations stay true rather than invented.
 */
const TAXONOMY = {
  'living thing': {
    animal: {
      bird: ['falcon', 'sparrow', 'penguin', 'eagle', 'owl', 'heron', 'swan', 'parrot'],
      fish: ['salmon', 'trout', 'shark', 'eel', 'herring', 'cod', 'tuna'],
      mammal: ['dog', 'cat', 'horse', 'whale', 'bat', 'otter', 'badger', 'dolphin'],
      reptile: ['snake', 'lizard', 'turtle', 'crocodile', 'gecko', 'python'],
      insect: ['ant', 'bee', 'beetle', 'butterfly', 'moth', 'wasp', 'cricket'],
      amphibian: ['frog', 'toad', 'newt', 'salamander'],
    },
    plant: {
      tree: ['oak', 'pine', 'maple', 'birch', 'willow', 'cedar', 'ash'],
      flower: ['rose', 'tulip', 'daisy', 'orchid', 'lily', 'violet', 'poppy'],
      vegetable: ['carrot', 'potato', 'onion', 'cabbage', 'turnip', 'leek'],
      grass: ['wheat', 'barley', 'bamboo', 'reed'],
    },
    fungus: {
      mushroom: ['button mushroom', 'chanterelle', 'morel', 'porcini'],
      mould: ['penicillium', 'aspergillus'],
    },
  },
  object: {
    tool: ['hammer', 'saw', 'drill', 'wrench', 'chisel', 'file', 'plane'],
    vehicle: ['car', 'truck', 'bicycle', 'boat', 'train', 'aeroplane', 'tram'],
    furniture: ['chair', 'table', 'bed', 'sofa', 'desk', 'stool', 'cabinet'],
    instrument: ['piano', 'violin', 'drum', 'flute', 'guitar', 'trumpet', 'harp'],
    container: ['box', 'barrel', 'bottle', 'jar', 'crate', 'tin', 'basket'],
    garment: ['shirt', 'trousers', 'coat', 'hat', 'sock', 'glove', 'scarf'],
  },
  substance: {
    metal: ['iron', 'copper', 'gold', 'silver', 'zinc', 'lead', 'tin'],
    liquid: ['water', 'oil', 'milk', 'vinegar', 'mercury', 'petrol'],
    gas: ['oxygen', 'nitrogen', 'hydrogen', 'helium', 'argon'],
    mineral: ['quartz', 'granite', 'marble', 'slate', 'chalk'],
  },
};

/** Turn the taxonomy into root-to-leaf chains, e.g. ['falcon','bird','animal','living thing']. */
export function buildKnowledgeBase(taxonomy = TAXONOMY) {
  const chains = [];

  const walk = (node, path) => {
    for (const [key, value] of Object.entries(node)) {
      if (Array.isArray(value)) {
        for (const leaf of value) chains.push([leaf, key, ...path]);
      } else if (value && typeof value === 'object') {
        walk(value, [key, ...path]);
      }
    }
  };

  walk(taxonomy, []);
  return { chains };
}

export function verifierFingerprint(salt) {
  return createHash('sha256').update(String(salt)).digest('hex').slice(0, 16).toUpperCase();
}

export function mintVerifier({ dir, items = 150, windowMs = 45000, now = Date.now() } = {}) {
  const kb = buildKnowledgeBase();
  if (kb.chains.length === 0) throw new Error('mint-verifier: taxonomy produced no chains');
  return {
    v: VERIFIER_VERSION,
    salt: randomBytes(32).toString('base64url'),
    kb,
    items,
    windowMs,
    // NOTE: no passRatio here, deliberately. createAdmissionManager takes no such parameter and
    // scoreChallenge uses the library's own DEFAULT_PASS_RATIO, so a passRatio field in this
    // file would be read by nothing. Writing a number that looks configurable but is not is how
    // an operator ends up believing they lowered the bar when they did not.
    dir,
    createdAt: now,
  };
}

/** Read a verifier and fail loudly rather than handing back something half-formed. */
export function loadVerifier(path) {
  if (!existsSync(path)) throw new Error(`mint-verifier: no verifier at ${path}`);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || value.v !== VERIFIER_VERSION) throw new Error(`mint-verifier: unsupported verifier version ${value && value.v}`);
  if (typeof value.salt !== 'string' || value.salt.length === 0) throw new Error('mint-verifier: verifier has no salt');
  if (!value.kb || !Array.isArray(value.kb.chains) || value.kb.chains.length === 0) throw new Error('mint-verifier: verifier has no knowledge base');
  return value;
}

function main(argv) {
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const flag = (name) => argv.includes(name);

  const out = resolve(arg('--out', 'E:\\verifier.json'));
  const force = flag('--force');

  if (flag('--stats')) {
    const kb = buildKnowledgeBase();
    const lengths = kb.chains.map((c) => c.length);
    const words = new Set(kb.chains.flat());
    process.stdout.write(`chains: ${kb.chains.length}\ndistinct words: ${words.size}\nchain length min/median/max: ${Math.min(...lengths)}/${lengths.sort((a, b) => a - b)[Math.floor(lengths.length / 2)]}/${Math.max(...lengths)}\n`);
    return 0;
  }

  if (existsSync(out) && !force) {
    const existing = loadVerifier(out);
    process.stdout.write(`refusing to overwrite ${out}\n`);
    process.stdout.write(`  existing salt fingerprint: ${verifierFingerprint(existing.salt)}\n`);
    process.stdout.write(`  chains: ${existing.kb.chains.length}, items: ${existing.items}, windowMs: ${existing.windowMs}\n`);
    process.stdout.write('  pass --force to replace it (this CHANGES the salt)\n');
    return 2;
  }

  if (flag('--show-fingerprint')) {
    const existing = loadVerifier(out);
    process.stdout.write(`${out}\n  salt fingerprint: ${verifierFingerprint(existing.salt)}\n  dir: ${existing.dir}\n  chains: ${existing.kb.chains.length}\n  items: ${existing.items}, windowMs: ${existing.windowMs}\n`);
    return 0;
  }

  // STICK-RELATIVE ON PURPOSE. The verifier travels on the stick, and a stick is E: on one
  // machine and D: on another — an absolute host path would resolve here and silently fail
  // everywhere else. The console resolves this against whatever root the stick is mounted at.
  const dir = arg('--dir', 'data/admissions');
  const dirAbsolute = isAbsolute(dir) ? dir : join(dirname(out), dir);
  const verifier = mintVerifier({
    dir,
    items: Number(arg('--items', '150')),
    windowMs: Number(arg('--window-ms', '45000')),
  });

  // mkdirSync(recursive) still throws EPERM on a drive root that already exists (measured:
  // `mkdir 'E:\'` -> EPERM), so only create directories we actually need to create.
  for (const target of [dirname(out), dirAbsolute]) {
    if (!existsSync(target)) mkdirSync(target, { recursive: true });
  }
  writeFileSync(out, `${JSON.stringify(verifier, null, 2)}\n`, { mode: 0o600 });

  process.stdout.write(`wrote ${out}\n`);
  process.stdout.write(`  salt fingerprint: ${verifierFingerprint(verifier.salt)}   (the salt itself is NOT printed)\n`);
  process.stdout.write(`  knowledge base:   ${verifier.kb.chains.length} chains\n`);
  process.stdout.write(`  challenge:        ${verifier.items} items in ${verifier.windowMs} ms, pass ratio ${DEFAULT_PASS_RATIO} (fixed by the library, not stored)\n`);
  process.stdout.write(`  admissions store: ${dirAbsolute}   (recorded as "${dir}", relative to the stick)\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('mint-verifier.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
