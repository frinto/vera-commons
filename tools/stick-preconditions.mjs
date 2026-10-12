/**
 * WHAT KIND OF VOLUME IS THIS, AND WHAT DOES THAT LET US CLAIM?
 *
 * `deploy-stick.mjs` copies CODE and never touches secrets -- it says so itself ("Secrets are NOT
 * touched"). But its acceptance check starts the console and asserts what the console SERVES, and the
 * console reads the operator's private key on EVERY request. So on a volume with no key, every one of
 * those checks fails, and the tool ended with:
 *
 *     "8 check(s) FAILED -- the stick is NOT deployable as it stands."
 *
 * That verdict is false, and it is false in the most costly direction: the code deployed perfectly.
 * The volume simply had not had its key ceremony yet. A first-time deployment, a re-imaged stick, or
 * a new machine would all produce a wall of failures that reads as breakage, sending the operator to
 * debug code that is fine.
 *
 * The distinction this module draws is between:
 *   * the DEPLOYMENT is broken  -> a real failure, worth the alarm
 *   * the VOLUME is not yet an operator volume -> a precondition, worth a different message and a
 *     different exit code, because the remedy is completely different (run the ceremony, not fix code)
 *
 * It is a pure function over three booleans so the decision can be tested exhaustively without a USB
 * stick, a subst drive, or a key ceremony -- the only way this stays honest is if the branch that
 * matters can be exercised by a build.
 */

/** Distinct from 1 (deployment failed) and 2 (bad target path), so a caller can tell them apart. */
export const PRECONDITION_EXIT = 3;

/**
 * @param {{hasUserAdmin: boolean, hasTrust: boolean, drive?: string}} facts
 */
export function classifyStickVolume({ hasUserAdmin, hasTrust, drive = 'the drive root' }) {
  const missing = [];
  if (!hasUserAdmin) missing.push('user-admin.json');
  if (!hasTrust) missing.push('trust.json');

  if (missing.length === 0) {
    return {
      ok: true,
      code: 'operator_volume',
      exitCode: 0,
      missing: [],
      headline: '',
      detail: [],
      verdict: '',
    };
  }

  return {
    ok: false,
    code: 'no_operator_credentials',
    exitCode: PRECONDITION_EXIT,
    missing,
    headline: 'THE CODE IS DEPLOYED. THIS VOLUME IS NOT YET AN OPERATOR VOLUME.',
    detail: [
      `absent from ${drive}: ${missing.join(', ')}`,
      '',
      'These are SECRETS, and this tool deliberately never creates, copies or overwrites them. A copy',
      'of an admin key is indistinguishable from the original, so minting one here to satisfy a check',
      'would quietly create a SECOND commons authority -- a far worse outcome than an honest failure.',
      '',
      'The console is right to refuse. It re-reads the key on every request, so with no key here it',
      'answers 503 and reports the stick as not present. That is the gate working, not a deployment',
      'that broke. The checks below are therefore NOT RUN rather than failed.',
      '',
      'To turn this volume into an operator volume: mint or restore the operator credentials so they',
      'sit at the drive root (see tools/admission-ceremony.mjs and docs/), then run this tool again.',
      'It re-checks; nothing here needs undoing.',
    ],
    verdict: 'DEPLOYED, BUT NOT YET AN OPERATOR VOLUME -- nothing above says a single line of the deployed code is at fault.',
  };
}
