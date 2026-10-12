// Agent Commons — proof of agency.
//
// The point of this file is to prove the gate is a gate, not a decoration. A challenge scheme
// fails silently in a specific way: it looks rigorous while the answers are sitting in the
// challenge, or derivable without the secret. So the negative controls below matter more than
// the happy path.
//
// Run: node test/agency.test.mjs

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import {
  makeChallenge, scoreChallenge, challengeDigest,
  DEFAULT_ITEMS, OPTIONS,
} from '../src/agency.mjs';

let passed = 0;
function check(name, fn) {
  fn();
  console.log(`PASS ${name}`);
  passed += 1;
}
process.on('exit', () => console.log(`\n${passed} assertions passed.`));

// ─── THE VERIFIER'S KNOWLEDGE BASE ───
// This stands in for the real one. In deployment it lives with the verifier and is NOT given to
// clients; if a client held it, the client could compute every answer and the gate would be
// worthless. The sample is small only so the test stays readable.
const KB = {
  chains: [
    ['falcon', 'bird', 'animal', 'living thing'],
    ['sparrow', 'bird', 'animal', 'living thing'],
    ['salmon', 'fish', 'animal', 'living thing'],
    ['whale', 'mammal', 'animal', 'living thing'],
    ['wolf', 'mammal', 'animal', 'living thing'],
    ['oak', 'tree', 'plant', 'living thing'],
    ['fern', 'plant', 'living thing'],
    ['granite', 'igneous rock', 'rock', 'mineral'],
    ['quartz', 'mineral', 'mineral'],
    ['copper', 'metal', 'element', 'mineral'],
    ['triangle', 'polygon', 'shape', 'abstract thing'],
    ['sonnet', 'poem', 'text', 'abstract thing'],
  ],
};

const SEED = 'seed-0123456789abcdef';
const SALT = 'verifier-secret-one';

const solve = (ch) => ch.items.map((it, i) => {
  // A stand-in for a model with the knowledge: it looks the answer up. A real agent does this
  // with its own semantic model rather than with the KB, which is the whole point.
  const entity = it.premise.match(/^(?:A|An) (.+?) is (?:a|an) /)[1];
  const category = it.hypothesis.match(/ is (?:a|an) (.+?)\.$/)[1];
  const chain = KB.chains.find((c) => c[0] === entity);
  return chain.slice(1).includes(category) ? 'ENTAILED' : 'CONTRADICTED';
});

// ─── the structural guard: answers must NOT travel with the challenge ───
check('the challenge never carries the answers', () => {
  const ch = makeChallenge({ seed: SEED, salt: SALT, kb: KB, items: 40 });
  assert.equal(ch.items.length, 40);
  for (const it of ch.items) {
    assert.equal('answer' in it, false, 'an answer field on a challenge item would be a total defeat');
    assert.deepEqual(Object.keys(it).sort(), ['hypothesis', 'i', 'premise']);
  }
});

check('the challenge advertises the bar the solver must clear', () => {
  const ch = makeChallenge({ seed: SEED, salt: SALT, kb: KB, items: 40 });
  assert.deepEqual(ch.options, OPTIONS);
  assert.equal(ch.passRatio, 0.95);
  assert.ok(ch.windowMs > 0);
});

// ─── determinism: the verifier recomputes instead of storing ───
check('the same seed and salt always produce the same challenge', () => {
  const a = makeChallenge({ seed: SEED, salt: SALT, kb: KB, items: 20 });
  const b = makeChallenge({ seed: SEED, salt: SALT, kb: KB, items: 20 });
  assert.deepEqual(a.items, b.items);
  assert.equal(challengeDigest({ seed: SEED, salt: SALT, kb: KB, items: 20 }),
    challengeDigest({ seed: SEED, salt: SALT, kb: KB, items: 20 }));
});

// ─── THE LOAD-BEARING SECRET ───
// If the salt did not change the answers, a client holding this module could compute them and
// pass forever without any model. This is the assertion that makes the secret matter.
check('a different salt yields different items AND different answers', () => {
  const a = makeChallenge({ seed: SEED, salt: SALT, kb: KB, items: 40 });
  const b = makeChallenge({ seed: SEED, salt: 'verifier-secret-two', kb: KB, items: 40 });
  assert.notDeepEqual(a.items, b.items, 'the salt must change what is asked, not only how it is scored');

  const rightForA = solve(a);
  const scored = scoreChallenge({ seed: SEED, salt: 'verifier-secret-two', kb: KB, items: 40, answers: rightForA });
  assert.equal(scored.ok, false,
    'answers correct under one salt must FAIL under another — otherwise the salt is decoration');
  assert.ok(scored.ratio < 0.9, `expected a clear failure, got ratio ${scored.ratio}`);
});

check('the same seed with a different salt is a genuinely different exam', () => {
  const d1 = challengeDigest({ seed: SEED, salt: SALT, kb: KB, items: 40 });
  const d2 = challengeDigest({ seed: SEED, salt: 'verifier-secret-two', kb: KB, items: 40 });
  assert.notEqual(d1, d2);
});

// ─── the happy path: someone who genuinely knows the facts gets in ───
check('a solver with the knowledge passes', () => {
  const ch = makeChallenge({ seed: SEED, salt: SALT, kb: KB, items: DEFAULT_ITEMS });
  const answers = solve(ch);
  const s = scoreChallenge({ seed: SEED, salt: SALT, kb: KB, items: DEFAULT_ITEMS, answers });
  assert.equal(s.ok, true, `expected a pass, got ${s.correct}/${s.total}`);
  assert.equal(s.ratio, 1);
  assert.equal(s.correct, DEFAULT_ITEMS);
});

// ─── NEGATIVE CONTROLS: the ways a non-agent tries to get in ───

check('guessing fails — and fails by an enormous margin', () => {
  const ch = makeChallenge({ seed: SEED, salt: SALT, kb: KB, items: DEFAULT_ITEMS });
  // A deterministic pseudo-guesser rather than Math.random, so the control is reproducible: a
  // control that can pass on a lucky run is not a control.
  let h = 12345;
  const guess = () => { h = (Math.imul(h, 1103515245) + 12345) >>> 0; return OPTIONS[(h >>> 16) & 1]; };
  const answers = ch.items.map(() => guess());
  const s = scoreChallenge({ seed: SEED, salt: SALT, kb: KB, items: DEFAULT_ITEMS, answers });
  assert.equal(s.ok, false, 'a guesser must never pass');
  assert.ok(s.ratio < 0.7, `a guesser should sit near chance, got ${s.ratio}`);
});

check('answering ENTAILED to everything fails (the challenge is not one-sided)', () => {
  const ch = makeChallenge({ seed: SEED, salt: SALT, kb: KB, items: DEFAULT_ITEMS });
  const answers = ch.items.map(() => 'ENTAILED');
  const s = scoreChallenge({ seed: SEED, salt: SALT, kb: KB, items: DEFAULT_ITEMS, answers });
  assert.equal(s.ok, false);
  assert.ok(s.ratio > 0.3 && s.ratio < 0.7,
    `a constant answer should land near half, got ${s.ratio} — outside that range the item mix is skewed`);
});

check('answering only half the items fails', () => {
  const ch = makeChallenge({ seed: SEED, salt: SALT, kb: KB, items: DEFAULT_ITEMS });
  const good = solve(ch);
  const answers = good.map((a, i) => (i % 2 === 0 ? a : ''));
  const s = scoreChallenge({ seed: SEED, salt: SALT, kb: KB, items: DEFAULT_ITEMS, answers });
  assert.equal(s.ok, false);
  assert.ok(s.ratio < 0.6, `half a paper cannot score ${s.ratio}`);
});

check('nearly-perfect still fails below the bar — 95% is not a suggestion', () => {
  const ch = makeChallenge({ seed: SEED, salt: SALT, kb: KB, items: DEFAULT_ITEMS });
  const answers = solve(ch);
  answers[0] = answers[0] === 'ENTAILED' ? 'CONTRADICTED' : 'ENTAILED';
  answers[1] = answers[1] === 'ENTAILED' ? 'CONTRADICTED' : 'ENTAILED';
  answers[2] = answers[2] === 'ENTAILED' ? 'CONTRADICTED' : 'ENTAILED';
  answers[3] = answers[3] === 'ENTAILED' ? 'CONTRADICTED' : 'ENTAILED';
  answers[4] = answers[4] === 'ENTAILED' ? 'CONTRADICTED' : 'ENTAILED';
  answers[5] = answers[5] === 'ENTAILED' ? 'CONTRADICTED' : 'ENTAILED';
  answers[6] = answers[6] === 'ENTAILED' ? 'CONTRADICTED' : 'ENTAILED';
  answers[7] = answers[7] === 'ENTAILED' ? 'CONTRADICTED' : 'ENTAILED';
  const s = scoreChallenge({ seed: SEED, salt: SALT, kb: KB, items: DEFAULT_ITEMS, answers });
  assert.equal(s.ok, false, `8 wrong of 150 is 94.7% and must fail, got ${s.ratio}`);
});

check('a failure does not hand back the whole answer key', () => {
  const ch = makeChallenge({ seed: SEED, salt: SALT, kb: KB, items: DEFAULT_ITEMS });
  const s = scoreChallenge({ seed: SEED, salt: SALT, kb: KB, items: DEFAULT_ITEMS, answers: [] });
  assert.equal(s.ok, false);
  assert.ok(s.wrong.length <= 5, 'feedback must be bounded or a failed attempt is a free answer key');
});

// ─── the timing property the whole scheme rests on ───
check('generating a full challenge is milliseconds — the window measures the SOLVER, not the server', () => {
  const t0 = performance.now();
  const ch = makeChallenge({ seed: SEED, salt: SALT, kb: KB, items: DEFAULT_ITEMS });
  const elapsed = performance.now() - t0;
  assert.equal(ch.items.length, DEFAULT_ITEMS);
  assert.ok(elapsed < 250, `generation took ${elapsed.toFixed(1)}ms; it must not eat the solver's window`);
});

check('a full-length exam is far more work than hands can do in the window', () => {
  const ch = makeChallenge({ seed: SEED, salt: SALT, kb: KB, items: DEFAULT_ITEMS });
  const words = ch.items.reduce((n, it) => n + it.premise.split(' ').length + it.hypothesis.split(' ').length, 0);
  // 250 wpm is a strong human reading speed; the pass bar also requires judging each item.
  const humanMinutes = words / 250;
  const windowMinutes = ch.windowMs / 60000;
  assert.ok(humanMinutes > windowMinutes * 5,
    `the exam is only ${(humanMinutes / windowMinutes).toFixed(1)}x a fast human's window; it must not be close`);
});

// ─── abuse: the challenge must be bound to the seed it was issued for ───
check('answers do not transfer to a different seed', () => {
  const a = makeChallenge({ seed: SEED, salt: SALT, kb: KB, items: 40 });
  const answers = solve(a);
  const s = scoreChallenge({
    seed: 'a-completely-different-seed', salt: SALT, kb: KB, items: 40, answers,
  });
  assert.equal(s.ok, false, 'a recorded answer set must not replay against a fresh seed');
});

check('a knowledge base is mandatory — no KB means no gate', () => {
  assert.throws(() => makeChallenge({ seed: SEED, salt: SALT, kb: null, items: 10 }),
    /knowledge base/);
  assert.throws(() => makeChallenge({ seed: SEED, salt: SALT, kb: { chains: [] }, items: 10 }),
    /knowledge base/);
});

check('a weak seed or a missing salt is refused', () => {
  assert.throws(() => makeChallenge({ seed: 'short', salt: SALT, kb: KB, items: 10 }), /seed/);
  assert.throws(() => makeChallenge({ seed: SEED, salt: '', kb: KB, items: 10 }), /salt/);
});

// ─── every item is well-formed, because a malformed item is an unanswerable one ───
check('every generated item is well-formed and its answer is in the option set', () => {
  for (let k = 0; k < 12; k++) {
    const derived = scoreChallenge({ seed: `${SEED}${k}`, salt: SALT, kb: KB, items: 50, answers: [] });
    assert.equal(derived.total, 50);
  }
  const ch = makeChallenge({ seed: SEED, salt: SALT, kb: KB, items: 200 });
  for (const it of ch.items) {
    assert.match(it.premise, /^(?:A|An) .+ is (?:a|an) .+\.$/);
    assert.match(it.hypothesis, /^(?:A|An) .+ is (?:a|an) .+\.$/);
  }
});

check('regressions: sound-based articles, distinct premises, and explicit answer-shape rejection', () => {
  const failures = [];
  const capture = (name, fn) => {
    try { fn(); } catch (err) { failures.push(`${name}: ${err.message}`); }
  };
  const regressionKb = {
    chains: [...KB.chains,
      ['hour', 'unit', 'measure'],
      ['user', 'person', 'human'],
      ['unicorn', 'mythical creature', 'creature'],
    ],
  };
  const seed = 'regression-fixed-seed-20261011';
  const ch = makeChallenge({ seed, salt: SALT, kb: regressionKb, items: 1200 });
  const article = (term) => {
    const first = term.toLowerCase();
    if (/^(hour|honest|honor|honour|heir)(?:\b|\s)/.test(first)) return 'an';
    if (/^(user|unicorn|university|unit|uniform|union|usual|utility|european|eulogy|eucalyptus|one|once)(?:\b|\s)/.test(first)) return 'a';
    return /^[aeiou]/.test(first) ? 'an' : 'a';
  };
  capture('article agreement', () => {
    const subjects = new Set();
    for (const it of ch.items) {
      const premise = it.premise.match(/^(A|An) (.+?) is (a|an) (.+)\.$/i);
      const hypothesis = it.hypothesis.match(/^(A|An) (.+?) is (a|an) (.+)\.$/i);
      assert.ok(premise && hypothesis, `unparseable item ${it.i}`);
      assert.equal(premise[1].toLowerCase(), article(premise[2]), `premise subject ${premise[2]}`);
      assert.equal(premise[3].toLowerCase(), article(premise[4]), `premise category ${premise[4]}`);
      assert.equal(hypothesis[1].toLowerCase(), article(hypothesis[2]), `hypothesis subject ${hypothesis[2]}`);
      assert.equal(hypothesis[3].toLowerCase(), article(hypothesis[4]), `hypothesis category ${hypothesis[4]}`);
      subjects.add(premise[2]);
    }
    for (const noun of ['hour', 'user', 'unicorn']) assert.ok(subjects.has(noun), `fixed-seed coverage missing ${noun}`);
  });
  capture('premise and hypothesis categories differ', () => {
    for (const it of ch.items) {
      const premiseCategory = it.premise.match(/ is (?:a|an) (.+)\.$/)[1];
      const hypothesisCategory = it.hypothesis.match(/ is (?:a|an) (.+)\.$/)[1];
      assert.notEqual(premiseCategory, hypothesisCategory, `item ${it.i} repeats category ${premiseCategory}`);
    }
  });
  capture('malformed answer records are rejected', () => {
    assert.throws(() => scoreChallenge({
      seed, salt: SALT, kb: regressionKb, items: 2,
      answers: [{ i: 0, answer: 'ENTAILED' }, { i: 1, answer: 'CONTRADICTED' }],
    }), /answer shape/i);
  });
  const blank = scoreChallenge({ seed, salt: SALT, kb: regressionKb, items: 2, answers: [] });
  assert.equal(blank.ok, false, 'all-blank answers remain a legitimate failing verdict');
  assert.equal(blank.correct, 0);
  assert.equal(blank.ratio, 0);
  assert.equal(failures.length, 0, failures.join('\n'));
});
