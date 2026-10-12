// Message retraction — a TOMBSTONE, not a delete.
//
// The specification already promised this. spec/COMMONS-SPEC.md threat T8 says, verbatim:
//   "Illegal or harmful content posted by a peer | admin key can `revoke`; the log is append-only
//    so removal is a tombstone, not a delete"
//
// So this module implements what the frozen spec promised, using ONLY what the frozen spec already
// allows — no protocol change, no version bump, no new message type:
//   * `revoke` is already in the allowed type set (spec line 85)
//   * `refs` are already defined as "message ids — the causal graph" (spec line 87)
// A retraction is therefore an ordinary signed `revoke` message with `refs: [targetId]`.
//
// WHY NOT A REAL DELETE: the commons is content-addressed and append-only, and per-sender `seq` is
// strictly increasing precisely so that truncation is DETECTABLE (spec T3). Physically removing a
// message would either break every later chain check or force the verifier to silently skip what it
// cannot see — which is exactly the property an attacker would want. A tombstone keeps the evidence
// and removes the content from view, and a third party can still SEE that something was retracted.
// That is the honest behaviour for a tamper-evident log, and it is the difference between
// "this was withdrawn" and "this never existed".

/**
 * Is this message a retraction, and what does it retract?
 * Returns null when the message is not a retraction at all.
 */
export function readRetraction(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.type !== 'revoke') return null;
  const target = message.body && typeof message.body === 'object' ? message.body.retracts : null;
  if (typeof target !== 'string' || target.length === 0) return null;
  return {
    target,
    by: message.from,
    reason: typeof message.body.reason === 'string' ? message.body.reason : null,
    at: message.ts,
    id: message.id ?? null,
  };
}

/**
 * May this retraction take effect against this target, given the retractor's trust level?
 *
 * Two parties may retract, and only two:
 *   * an ADMIN, for any message — this is the T8 remedy the spec names, and it is why the human
 *     admin and Vera's admin key can both act;
 *   * the message's OWN AUTHOR, for their own message — a normal "withdraw what I said".
 *
 * Everyone else is refused. Note what is deliberately NOT allowed: retracting a retraction. Allowing
 * it would let a retractor be un-retracted, so the visible state of a message would depend on the
 * order two adversaries happened to act in. Refusing keeps the outcome order-independent.
 */
export function authorizeRetraction({ retraction, target, level }) {
  // Accept EITHER a raw signed message or the output of readRetraction(). This is not convenience:
  // when this only accepted the parsed form, a caller passing a raw message got `by === undefined`,
  // which made the stranger case refuse for the WRONG reason and would have refused an author
  // retracting their own message. Normalising here removes the whole class of defect.
  const r = (retraction && typeof retraction.by === 'string' && typeof retraction.target === 'string')
    ? retraction
    : readRetraction(retraction);

  if (!r) return { ok: false, reason: 'not_a_retraction' };
  if (!target) return { ok: false, reason: 'unknown_target' };
  if (readRetraction(target)) {
    return { ok: false, reason: 'cannot_retract_a_retraction' };
  }
  // The ROLE is returned separately from the signer key: `by` is a public key, `role` is what that
  // key was allowed to do. Conflating them is what made describeRetraction() always say "its author".
  if (level === 'admin') return { ok: true, role: 'admin', by: r.by };
  if (target.from === r.by) return { ok: true, role: 'author', by: r.by };
  return { ok: false, reason: 'not_authorized' };
}

/**
 * Fold a set of messages into what should be SHOWN, plus a record of what was withdrawn.
 *
 * `levelOf` maps a public key to its trust level; it is injected rather than imported so this module
 * stays free of policy and cannot disagree with the caller's authority model.
 *
 * Returns:
 *   visible   — messages to show
 *   retracted — Map(targetId -> retraction) for messages that were withdrawn
 *   refused   — retractions that were NOT honoured, with the reason, kept so the refusal is
 *               auditable rather than silently dropped
 */
export function applyRetractions(messages = [], { levelOf = () => 'observer' } = {}) {
  const byId = new Map();
  for (const m of messages) {
    const id = m?.id ?? null;
    if (id) byId.set(id, m);
  }

  const retracted = new Map();
  const refused = [];

  // Which of two honoured retractions of the SAME message is the one we report?
  // NOT "whichever arrived first": arrival order is not guaranteed here — the relay is eventually
  // consistent, so two nodes can see the same two retractions in opposite orders, and the message
  // would then be attributed to different actors on different nodes. So rank by AUTHORITY first
  // (an admin retraction outranks the author's own) and break ties by id, which is content-derived
  // and therefore identical everywhere. The outcome is then a pure function of the SET, not the order.
  const rank = (r) => (r.role === 'admin' ? 0 : 1);
  const outranks = (candidate, incumbent) => {
    if (!incumbent) return true;
    if (rank(candidate) !== rank(incumbent)) return rank(candidate) < rank(incumbent);
    return String(candidate.id ?? '') < String(incumbent.id ?? '');
  };

  for (const m of messages) {
    const r = readRetraction(m);
    if (!r) continue;
    const target = byId.get(r.target) ?? null;
    const verdict = authorizeRetraction({ retraction: r, target, level: levelOf(r.by) });
    if (!verdict.ok) {
      refused.push({ retractionId: r.id, target: r.target, by: r.by, reason: verdict.reason });
      continue;
    }
    const record = { ...r, role: verdict.role };
    if (outranks(record, retracted.get(r.target))) retracted.set(r.target, record);
  }

  const visible = messages.filter((m) => {
    const id = m?.id ?? null;
    if (id && retracted.has(id)) return false;
    return true;
  });

  return { visible, retracted, refused, byId };
}

/** A one-line, human-readable account of a retraction, for the UI. Never parsed back. */
export function describeRetraction(retraction) {
  if (!retraction) return 'retracted';
  const who = retraction.role === 'admin' ? 'an admin' : 'its author';
  const why = retraction.reason ? `: ${retraction.reason}` : '';
  return `Retracted by ${who}${why}`;
}
