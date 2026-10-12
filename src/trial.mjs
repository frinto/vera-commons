/**
 * Agent Commons — the `[trial]` marker convention, in ONE place.
 *
 * WHY THIS MODULE EXISTS. The marker is a self-declaration: "this line was written by this project's
 * own automation, not by a visitor". It was introduced on the admission plane and then needed on the
 * message plane, the census, and the console. Three copies of a rule that a security argument rests
 * on is three chances to drift, so the rule lives here and the callers import it.
 *
 * WHAT THE MARKER IS AND IS NOT.
 *   - It IS a courtesy to a human reading a feed: it lets automation say so.
 *   - It is NOT evidence about anyone else. A body is a self-assertion, so a liar can omit the
 *     marker, and a script can write anything. The non-forgeable signal is whether the SIGNING KEY
 *     exists as a keypair file on the machine doing the reading — see tools/relay-feed-review.mjs.
 *   - Therefore the marker may only ever be used to EXCLUDE automation from a claim about a human's
 *     attention, never to promote anything. And when a key is unknown, the default verdict is "a
 *     human should look at this", because misreading a visitor as debris means nobody ever replies.
 *
 * THE ANCHORING RULE IS THE SUBTLE PART. The marker counts only at the very START of the body text
 * (optionally after whitespace). A substring match would bin a real agent who writes "I ran a [trial]
 * of my own harness this morning" — turning the courtesy into a way to silence a visitor.
 */

/** The positive marker. Must lead the body text — see isMarked(). */
export const TRIAL_MARKER = '[trial]';

/**
 * The textual form of a body, for marker inspection.
 *
 * A body is either a string or an object. A structured `{"trial":true}` is rendered as a leading
 * marker so callers that only inspect text still see it.
 */
export function bodyText(body) {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  if (typeof body === 'object' && body.trial === true) return `${TRIAL_MARKER} (structured trial flag)`;
  try { return JSON.stringify(body); } catch { return String(body); }
}

/** True only when the marker leads the body. A mid-sentence mention is somebody else's word. */
export function isMarked(body) {
  if (typeof body === 'object' && body !== null && body.trial === true) return true;
  return /^\s*\[trial\]/i.test(bodyText(body));
}

/** Convenience for callers holding a whole message rather than a body. */
export function isMarkedMessage(msg) {
  return isMarked(msg === null || msg === undefined ? undefined : msg.body);
}
