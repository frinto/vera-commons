/**
 * Score a joining agent's answers, and report the two things separately, because conflating them
 * would hide the most important fact about the gate.
 *
 *   1. THE ENFORCED VERDICT — what the admission manager actually decides (window, pending state,
 *      pass ratio, all enforced exactly as a live join would be).
 *   2. THE RAW SCORE — how many answers were right, measured with no regard for the clock.
 *
 * They differ for a real reason: the 45 s window was sized for a deterministic solver, and a
 * language model reasoning over 150 items takes minutes. Reporting only (1) would say "the agent
 * failed" when the agent in fact reasoned well and merely ran out of clock; reporting only (2)
 * would say "the agent passed" when the gate in fact refused it. Both numbers are true and the
 * gap between them IS the finding.
 *
 *   node tools/challenge-score.mjs <verifier.json> <answers.json> [admission-id]
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { createAdmissionManager } from '../src/admission.mjs';
import { scoreChallenge } from '../src/agency.mjs';
import { loadVerifierFile, resolveAdmissionsDir } from '../src/verifier-path.mjs';

/** Accepts the shapes a model realistically emits; reports which one it got rather than guessing silently. */
export function normaliseAnswers(raw) {
  if (Array.isArray(raw)) {
    if (raw.every((v) => typeof v === 'string')) return { answers: raw, shape: 'bare string array (positional)' };
    if (raw.every((v) => v && typeof v === 'object' && typeof v.answer === 'string')) {
      return { answers: raw.map((v) => v.answer), shape: 'array of {answer}' };
    }
    return { answers: null, shape: `unsupported array element type (first: ${typeof raw[0]})` };
  }
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.answers)) return normaliseAnswers(raw.answers);
    const keys = Object.keys(raw);
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      const idx = keys.map(Number).sort((a, b) => a - b);
      return { answers: idx.map((i) => raw[String(i)]), shape: 'object keyed by item index' };
    }
    return { answers: null, shape: `unsupported object with keys ${keys.slice(0, 5).join(', ')}` };
  }
  return { answers: null, shape: `unsupported type ${typeof raw}` };
}

function main() {
  const [verifierPath, answersPath, idArg, CHALLENGE_PATH] = process.argv.slice(2);
  if (!verifierPath || !answersPath) {
    process.stderr.write('usage: node tools/challenge-score.mjs <verifier.json> <answers.json> [admission-id]\n');
    return 2;
  }

  const verifier = loadVerifierFile(verifierPath);
  const dir = resolveAdmissionsDir(verifier, verifierPath);
  const mgr = createAdmissionManager({
    dir,
    salt: verifier.salt,
    kb: verifier.kb,
    items: verifier.items,
    windowMs: verifier.windowMs,
  });

  const raw = JSON.parse(readFileSync(answersPath, 'utf8'));
  const { answers, shape } = normaliseAnswers(raw);
  process.stdout.write(`answers: ${answersPath}\n`);
  process.stdout.write(`  shape detected: ${shape}\n`);
  if (answers === null) {
    process.stderr.write('refusing to score an unrecognised answer shape — a silent zero would look like a failed agent\n');
    return 1;
  }
  process.stdout.write(`  count: ${answers.length}\n\n`);

  // (1) The enforced verdict, exactly as a live join would get it.
  const row = mgr.list().find((r) => r.id === idArg) ?? mgr.list()[mgr.list().length - 1];
  let verdict = null;
  try {
    verdict = mgr.answer(row.id, answers);
  } catch (err) {
    verdict = { error: err.message };
  }
  process.stdout.write(`ENFORCED VERDICT  (id ${row.id})\n`);
  process.stdout.write(`  status:  ${row.status}\n`);
  process.stdout.write(`  verdict: ${JSON.stringify(verdict)}\n\n`);

  // (2) The raw reasoning score, clock ignored.
  //
  // `items` is a COUNT, not the array. That is not a quirk — it is the whole design: the verifier
  // REGENERATES the challenge from the seed, so the file handed to a joining agent never needs to
  // carry the expected answers, and could not leak them if it tried. Passing the array here made
  // the loop bound `0 < [array]` -> NaN, the loop never ran, and the tool reported total:0 — a
  // silent zero that looks exactly like an agent which answered nothing.
  const challengePath = CHALLENGE_PATH || join(dirname(answersPath), basename(answersPath).replace(/^answers-/, 'challenge-'));
  const challengeDoc = JSON.parse(readFileSync(challengePath, 'utf8'));
  const inner = challengeDoc.challenge ?? challengeDoc;
  const itemCount = Array.isArray(inner.items) ? inner.items.length : inner.count;
  const scored = scoreChallenge({
    seed: inner.seed,
    salt: verifier.salt,
    kb: verifier.kb,
    items: itemCount,
    answers,
  });
  process.stdout.write(`RAW SCORE  (window ignored — measures reasoning, not speed)\n`);
  process.stdout.write(`  challenge:  ${challengePath}  (${itemCount} items regenerated from the seed)\n`);
  process.stdout.write(`  ${JSON.stringify(scored)}\n`);
  if (scored.total === 0 && answers.length > 0) {
    process.stderr.write(
      '\nREFUSING TO REPORT: scored total is 0 while the agent submitted answers. That is an\n' +
        'instrument failure, not a failed agent — the challenge and the verifier do not match.\n',
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('challenge-score.mjs')) {
  process.exitCode = main();
}
