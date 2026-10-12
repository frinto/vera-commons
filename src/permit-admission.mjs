// The admission → permit seam, in one place.
//
// The console could already issue a permit, but only to a key typed in by hand, and the CLI tool
// could issue one only from a decided admission. Two implementations of "who is being granted"
// is exactly how a system ends up granting authority to the wrong key: the console path has no
// record of why the key was chosen, and the two can drift apart without either being wrong on
// its own terms.
//
// So the rule lives here and both callers use it.
//
// Why this is not paranoia: a permit is the thing that lets a stranger SPEAK. An admission is the
// only record of someone having earned that. Letting the two be joined by a human copying a key
// between screens means a single transcription slip grants authority to an agent nobody examined,
// leaving no trace that it happened.

import { canonicalize } from './message.mjs';
import { verify } from './identity.mjs';
import { relayBindBytes, isAgentId, attestation } from './admission.mjs';

/**
 * The key an admission authorises, or the reason it authorises nobody.
 *
 * Refuses on every partial state on purpose. "Decided" is not "granted" — a refused admission is
 * decided too, and granting from one would invert the decision that was just recorded.
 *
 * @returns {{ok: true, grantee: string} | {ok: false, reason: string}}
 */
export function granteeFromAdmission(record) {
  if (!record || typeof record !== 'object') return { ok: false, reason: 'unknown_admission' };
  if (record.status !== 'decided') return { ok: false, reason: 'not_decided' };
  if (record.decision !== 'grant') return { ok: false, reason: 'not_granted' };
  if (typeof record.grantee !== 'string' || !record.grantee) return { ok: false, reason: 'no_grantee' };
  // A grant records the grantee it decided on. If a record somehow carries a grantee that differs
  // from the key it was bound to, that is corruption or tampering, and it must not be papered
  // over by picking one of the two.
  if (record.agentId && record.grantee !== record.agentId) {
    return { ok: false, reason: 'grantee_key_mismatch' };
  }
  // The check that decides whether a permit has anything behind it. Everything above reads FIELDS,
  // and a field is exactly what someone editing this store can write — the store is a file on disk,
  // which is why tamper-EVIDENCE rather than tamper-proofness is the claim. Measured instance: the
  // live store held a decided grant with no bindSig and no interview, and this function resolved it
  // to a grantee, so a key that nothing had proved was one step from a permit.
  const att = attestation(record);
  if (!att.ok) {
    return {
      ok: false,
      reason: 'unattested_grantee',
      attestation: att.reason,
      hint: 'This grant names a key that no stored signature covers, so nothing shows the applicant holds it. Refusing is not revoking: whoever holds the key can prove it — bind, or a signed interview — and this same record resolves again. A record that nothing can attest to never resolves, and that asymmetry is the point.',
    };
  }
  return { ok: true, grantee: record.grantee };
}

/**
 * Turn a RELAY verdict into the record this seam consumes.
 *
 * Why this exists: the gate can be walked entirely over the relay, and an agent that passes there has
 * no row in the local admission store — so `/api/grant` resolved it to `unknown_admission` and the
 * agent could pass the gate and still never be allowed to speak. The gate worked; nobody could get
 * through it. That is the seam this closes.
 *
 * The two hard parts, both of which are about NOT trusting the transport:
 *
 * 1. THE GRANTEE IS NOT IN THE VERDICT. A verdict attests only "for request R, decision D, by
 *    operator O". Which KEY that means is fixed by the bind, and the bind must carry a signature
 *    from that key. Reading the grantee from the relay's own listing — or from any request body —
 *    would let the relay, which is third-party infrastructure we do not control, choose who receives
 *    authority. So the bind is verified here, cryptographically, and its key is the grantee.
 *
 * 2. THE OPERATOR MUST ALREADY BE TRUSTED HERE. A verdict that names its own authority is just a
 *    claim; `operatorKeys` is supplied by this node. Trust never arrives over the wire.
 *
 * On TIME, stated plainly because it is easy to oversell: the verdict's signed bytes are
 * `{requestId, decision, by}` — there is NO attested time. A clock check on an unsigned field would
 * refuse honest verdicts while stopping nobody, since an attacker simply writes a fresh number. So
 * there is no expiry here, and replay is neutralised structurally instead: a verdict is bound to one
 * requestId, and a key gets at most one live grant. That is a real argument, not a clock.
 *
 * @returns {{ok: true, record: object} | {ok: false, reason: string}}
 */
export function admissionFromVerdict({ verdict, bind, operatorKeys } = {}) {
  if (!verdict || typeof verdict !== 'object') return { ok: false, reason: 'no_verdict' };
  if (typeof verdict.requestId !== 'string' || !verdict.requestId) return { ok: false, reason: 'no_request_id' };
  if (typeof verdict.by !== 'string' || !verdict.by) return { ok: false, reason: 'no_operator' };
  if (typeof verdict.sig !== 'string' || !verdict.sig) return { ok: false, reason: 'unsigned_verdict' };

  if (!Array.isArray(operatorKeys) || !operatorKeys.includes(verdict.by)) {
    return { ok: false, reason: 'operator_not_trusted' };
  }

  // The verdict, over exactly the bytes the operator signed. Not "the same fields" — the same bytes,
  // built the same way, so a change to one side cannot silently diverge from the other.
  const verdictOk = verify(
    verdict.by,
    Buffer.from(canonicalize({ requestId: verdict.requestId, decision: verdict.decision, by: verdict.by }), 'utf8'),
    verdict.sig,
  );
  if (!verdictOk) return { ok: false, reason: 'verdict_bad_signature' };

  // Point 1 above: the grantee is proven, never received.
  if (!bind || typeof bind !== 'object') return { ok: false, reason: 'no_bind' };
  if (bind.requestId !== verdict.requestId) return { ok: false, reason: 'bind_request_mismatch' };
  if (!isAgentId(bind.agentId)) return { ok: false, reason: 'bind_no_agent' };
  if (typeof bind.sig !== 'string' || !bind.sig) return { ok: false, reason: 'unsigned_bind' };
  const bindOk = verify(
    bind.agentId,
    relayBindBytes({ requestId: bind.requestId, agentId: bind.agentId }),
    bind.sig,
  );
  if (!bindOk) return { ok: false, reason: 'bind_bad_signature' };

  // The relay speaks `granted`/`refused`; this store speaks `grant`/`refuse`. The mapping is explicit
  // and CLOSED: anything unrecognised refuses. A new, misspelled or absent decision must never fall
  // through to a grant, because the failure mode of guessing here is admitting an unexamined agent.
  const DECISION = { granted: 'grant', refused: 'refuse' };
  const decision = DECISION[verdict.decision];
  if (!decision) return { ok: false, reason: 'unknown_decision' };

  return {
    ok: true,
    record: {
      id: `relay:${verdict.requestId}`,
      status: 'decided',
      decision,
      grantee: bind.agentId,
      agentId: bind.agentId,
      requestId: verdict.requestId,
      operator: verdict.by,
      via: 'relay',
      // THE PROOF, not just the verdict it produced. The bind above was verified cryptographically, and
      // without these three fields that verification leaves no trace: no later reader -- verify-store,
      // the permit seam, an auditor -- can re-derive what was checked, so the record is reduced to a
      // claim. Measured, not feared: with the proof dropped, the permit seam refused this function's
      // OWN output with 'unattested_grantee'. `boundVia` and `relayRequestId` say which bytes to
      // re-derive (a relay binding is signed over the requestId, not over the local record id), and
      // `bindSig` is the evidence itself. This is bind()'s rule applied here: keep the proof, not just
      // the verdict, or `agentId` becomes a field a later reader has to take on trust.
      boundVia: 'relay',
      relayRequestId: bind.requestId,
      bindSig: bind.sig,
    },
  };
}

/**
 * The live grant a key already holds, if any.
 *
 * Revocation is transitive and permanent, so a revoked grant does not count as held. A revoke
 * permit is matched by its `target`, which is the key being revoked.
 */
export function liveGrantFor(permits, grantee) {
  if (!Array.isArray(permits) || !grantee) return null;
  const revoked = new Set(
    permits.filter((p) => p && p.type === 'revoke').map((p) => p.target),
  );
  if (revoked.has(grantee)) return null;
  return permits.find((p) => p && p.type === 'grant' && p.grantee === grantee) ?? null;
}

/** The next permit seq for an issuer, derived from that issuer's own history. */
export function nextSeqFor(permits, issuer) {
  return (Array.isArray(permits) ? permits : [])
    .filter((p) => p && p.issuer === issuer)
    .reduce((max, p) => Math.max(max, Number(p.seq) || 0), 0) + 1;
}

export default { granteeFromAdmission, admissionFromVerdict, liveGrantFor, nextSeqFor };
