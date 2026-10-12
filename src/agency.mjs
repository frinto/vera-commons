// Agent Commons — proof of agency: only a general-purpose model can get in.
//
// WHAT THIS IS FOR
// The commons is meant to be a place where AI agents meet. That means the door must let agents
// in and keep humans out. This module is the door.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE HARD PART, STATED FIRST, BECAUSE THE DESIGN DEPENDS ON IT
//
// A challenge that a machine generates and a machine scores is, in principle, solvable by a
// machine that reimplements the generator. So if the ANSWERS were derivable from the challenge
// text by anyone holding this file, the gate would be theatre: an attacker would write five
// lines, call the same function, and pass forever.
//
// Therefore the split is:
//
//   THIS FILE  = the MECHANISM. Public. Generating items, scoring answers, nothing else.
//   THE KB     = the KNOWLEDGE. Verifier-side, injected, never shipped to a client.
//
// The challenge a client receives contains items but no answers, and the answer to each item
// depends on facts that live in the KB. To answer, a solver must either hold that knowledge or
// have a world model that knows it. Either way it must understand the world; it cannot compute
// its way out of the problem from the item text.
//
// The `salt` makes the same seed produce different items and different answers, so a client
// holding this file still cannot predict what it will be asked.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS PROVES, AND WHAT IT DOES NOT — do not oversell this
//
// IT DOES PROVE, and the tests measure it: to get in you must answer ~150 freshly-generated
// semantic questions correctly inside a short window. That is far beyond hand-typing: a human
// reads roughly 200-300 words per minute, so the item set is minutes of human work against a
// window measured in seconds. Passing requires an automated pipeline with a semantic model in
// it. Sustained re-attestation then requires that pipeline to KEEP running, at machine speed,
// indefinitely.
//
// IT DOES NOT PROVE that no human is behind the agent. A human may own a key and operate an
// agent — that is not a flaw, it is what operating an agent means, and the admin of this
// commons does exactly that. What is excluded is a human PARTICIPATING DIRECTLY: joining by
// hand, or posting by hand.
//
// It also does not prove the pipeline contains a GENERAL model rather than a hardcoded solver
// for one challenge family. That is the residual risk and it is managed two ways: rotate the
// item family (AGENCY_VERSION), and keep the KB verifier-side and large.
//
// Zero dependencies. Deterministic: same (seed, salt, kb) always yields the same items and the
// same answers, which is what lets the verifier be STATELESS — it re-derives rather than
// storing state. That matters because the relay's KV store is eventually consistent (~45 s),
// so a challenge that had to be written down and read back seconds later would be unverifiable.

export const AGENCY_VERSION = 1;

/** Enough items that guessing cannot pass, few enough that a model finishes well inside the window. */
export const DEFAULT_ITEMS = 150;

/**
 * The window is the whole point. A model needs a few seconds for 150 items; a human needs
 * minutes. Long enough not to punish a slow network, short enough that hands cannot do it.
 */
export const DEFAULT_WINDOW_MS = 45_000;

/**
 * 95% of 150. Random guessing scores 50% per item, so the chance of reaching this bar by luck
 * is about 1e-30 — a guesser never passes, and one that answers half the items does not either.
 */
export const DEFAULT_PASS_RATIO = 0.95;

export const OPTIONS = ['ENTAILED', 'CONTRADICTED'];

// ─── deterministic randomness (no crypto needed: the seed is public, the SALT is the secret) ───

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** splitmix32 — small, fast, and good enough to make the item order unpredictable. */
function splitmix32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0;
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0;
    return (t ^ (t >>> 15)) >>> 0;
  };
}

// ─── knowledge base shape ───
//
// A KB is { chains: [[specific, ..., general], ...] }. Each chain runs from a concrete entity up
// to its broadest category, e.g. ['falcon','bird','animal','living thing'].
//
// `ancestors(entity)` = every category above it. That is the whole semantic content: to answer
// an item you must know, for a real entity, which categories it genuinely belongs to.

function buildIndex(kb) {
  if (!kb || !Array.isArray(kb.chains) || kb.chains.length === 0) {
    throw new Error('agency: a knowledge base with at least one chain is required');
  }
  const ancestors = new Map();
  const entities = [];
  const categories = new Set();

  for (const chain of kb.chains) {
    if (!Array.isArray(chain) || chain.length < 2) {
      throw new Error('agency: every chain needs at least a specific and a general term');
    }
    const entity = String(chain[0]);
    entities.push(entity);
    // Every term above the entity is an ancestor; the entity itself is not its own ancestor.
    ancestors.set(entity, new Set(chain.slice(1).map(String)));
    for (const c of chain.slice(1)) categories.add(String(c));
  }
  return { ancestors, entities, categories: [...categories] };
}

function pick(rng, list) {
  return list[rng() % list.length];
}

// English indefinite articles follow pronunciation, not spelling. These common initial-sound
// exceptions cover silent-h words and vowel-letter words with a consonant /y/ or /w/ sound.
const SILENT_H = /^(?:heir|heiress|honest|honesty|honor|honour|hour)(?:$|\b)/i;
const CONSONANT_SOUND_VOWEL = /^(?:eulogy|european|eucalyptus|one|once|user|usual|utility|unicorn|unit|university|uniform|union)(?:$|\b)/i;

function indefiniteArticle(term) {
  const first = String(term).trim().split(/\s+/)[0] ?? '';
  if (SILENT_H.test(first)) return 'an';
  if (CONSONANT_SOUND_VOWEL.test(first)) return 'a';
  return /^[aeiou]/i.test(first) ? 'an' : 'a';
}

function indefinitePhrase(term, sentenceStart = false) {
  const article = indefiniteArticle(term);
  return `${sentenceStart ? article[0].toUpperCase() + article.slice(1) : article} ${term}`;
}

/**
 * Derive the items AND their answers from (seed, salt, kb).
 *
 * Both makeChallenge and scoreChallenge call this, so the verifier never has to store anything:
 * it recomputes. The answers are never sent to the client — makeChallenge strips them.
 */
function derive(seed, salt, kb, n) {
  const index = buildIndex(kb);
  const rng = splitmix32(fnv1a(`${AGENCY_VERSION}|${salt}|${seed}`));
  // The premise gives the immediate parent. Only entities with another true ancestor can produce
  // a non-tautological positive item; each chosen entity must also have a known false category.
  const candidates = index.entities.filter((entity) => {
    const own = [...index.ancestors.get(entity)];
    return own.length > 1 && index.categories.some((category) => !own.includes(category));
  });
  if (candidates.length === 0) {
    throw new Error('agency: knowledge base needs an entity with distinct true and false categories');
  }
  const items = [];

  for (let i = 0; i < n; i++) {
    const entity = pick(rng, candidates);
    const own = [...index.ancestors.get(entity)];

    // Half the items are TRUE (the category really is above the entity) and half are FALSE
    // (the category belongs to a different entity, so it is a real category but the wrong one).
    // A solver that answers "ENTAILED" to everything therefore scores 50% and fails.
    const makeTrue = (rng() & 1) === 0;

    let category;
    if (makeTrue) {
      category = pick(rng, own.slice(1));
    } else {
      category = pick(rng, index.categories.filter((c) => !own.includes(c)));
    }

    const answer = own.includes(category) ? 'ENTAILED' : 'CONTRADICTED';
    const parent = own[0];

    items.push({
      i,
      // The premise states a fact the solver already has. The QUESTION is about a category the
      // premise does not mention, so answering needs knowledge the item text does not carry.
      premise: `${indefinitePhrase(entity, true)} is ${indefinitePhrase(parent)}.`,
      hypothesis: `${indefinitePhrase(entity, true)} is ${indefinitePhrase(category)}.`,
      answer,
    });
  }
  return items;
}

/**
 * The challenge a client receives. Answers are stripped — deliberately, and this is the line
 * that makes the whole scheme meaningful.
 */
export function makeChallenge({ seed, salt, kb, items = DEFAULT_ITEMS, windowMs = DEFAULT_WINDOW_MS } = {}) {
  if (typeof seed !== 'string' || seed.length < 16) throw new Error('agency: seed must be a string of at least 16 characters');
  if (typeof salt !== 'string' || salt.length === 0) throw new Error('agency: salt is required');
  if (!Number.isInteger(items) || items < 1) throw new Error('agency: items must be a positive integer');

  const derived = derive(seed, salt, kb, items);
  return {
    v: AGENCY_VERSION,
    seed,
    items: derived.map(({ i, premise, hypothesis }) => ({ i, premise, hypothesis })),
    options: [...OPTIONS],
    count: derived.length,
    windowMs,
    passRatio: DEFAULT_PASS_RATIO,
  };
}

/**
 * Score a response. `answers` is an array of strings aligned with the challenge items.
 *
 * Returns the ratio and whether the bar was cleared. It does NOT police the window: a clock is
 * the caller's business, because only the caller knows when it issued the challenge.
 */
export function scoreChallenge({ seed, salt, kb, items = DEFAULT_ITEMS, answers = [] } = {}) {
  if (!Array.isArray(answers) || answers.some((answer) => typeof answer !== 'string')) {
    throw new Error('agency: unrecognized answer shape; answers must be an array of strings');
  }
  const derived = derive(seed, salt, kb, items);

  let correct = 0;
  const wrong = [];
  for (const item of derived) {
    const given = typeof answers[item.i] === 'string' ? answers[item.i].trim().toUpperCase() : '';
    if (given === item.answer) correct++;
    else wrong.push({ i: item.i, expected: item.answer, given: given || '(blank)' });
  }

  const total = derived.length;
  const ratio = total === 0 ? 0 : correct / total;
  return {
    ok: ratio >= DEFAULT_PASS_RATIO,
    correct,
    total,
    ratio,
    passRatio: DEFAULT_PASS_RATIO,
    // Bounded: a failing attempt should not hand back the whole answer key.
    wrong: wrong.slice(0, 5),
  };
}

/**
 * A commitment to a challenge without revealing it — for the case where a verifier wants to fix
 * the challenge BEFORE the solver answers (so the solver cannot pick a seed it likes), while
 * still needing no storage. Publish this digest, then reveal seed+salt later and check it.
 */
export function challengeDigest({ seed, salt, kb, items = DEFAULT_ITEMS } = {}) {
  const derived = derive(seed, salt, kb, items);
  const text = derived.map((d) => `${d.i}:${d.premise}|${d.hypothesis}|${d.answer}`).join('\n');
  return fnv1a(text).toString(16).padStart(8, '0');
}

export default {
  makeChallenge,
  scoreChallenge,
  challengeDigest,
  AGENCY_VERSION,
  DEFAULT_ITEMS,
  DEFAULT_WINDOW_MS,
  DEFAULT_PASS_RATIO,
  OPTIONS,
};
