// Verifier-side timed admission challenge manager. The caller injects salt and KB at runtime;
// neither secret is bundled, persisted, or returned. Passing is only a filter: it grants no
// trust or authority. Authority requires a separate explicit permit operation.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeChallenge, scoreChallenge, DEFAULT_ITEMS, DEFAULT_WINDOW_MS } from './agency.mjs';
import { verify } from './identity.mjs';

const STORE_NAME = 'admissions.json';

// --- identity binding -----------------------------------------------------------------------
//
// The gate used to run entirely without identities: a join key started a challenge, answers were
// scored without naming who gave them, and the interview took free text from whoever held the
// uuid. It could therefore prove "somebody derived 150 answers" and could never say WHO — while
// the permit that grants real authority needs a grantee key. Every part worked; the seam between
// them was missing.
//
// These two helpers are the seam. Both are exported so a joining AGENT can construct exactly the
// bytes it must sign: a challenge is useless if only the verifier can compute what to sign.

/** ed25519 public keys as this project produces them: base64url of the raw 32 bytes. */
export function isAgentId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function sha256hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Bytes an agent signs to CLAIM an existing admission.
 *
 * The domain line matters: without it the same signature could be replayed as an interview
 * signature (or as a message signature elsewhere in the protocol), which is the classic
 * cross-protocol signature confusion.
 */
export function bindBytes({ id, agentId } = {}) {
  if (typeof id !== 'string' || !id) throw new Error('bindBytes: id is required');
  if (!isAgentId(agentId)) throw new Error('bindBytes: agentId must be a 43-char base64url key');
  return Buffer.from(`agent-commons/admission-bind/v1\n${id}\n${agentId}`, 'utf8');
}

/**
 * Bytes an agent signs to submit an interview.
 *
 * The STATEMENT IS HASHED, not embedded: a signature over a digest still binds the exact text
 * (any change alters the digest) while keeping the signed payload a fixed size, so a 4000-char
 * statement and an empty one are handled identically. `id` is inside the payload so a signature
 * for one admission cannot be replayed onto another.
 */
export function interviewBytes({ id, agentId, statement } = {}) {
  if (typeof id !== 'string' || !id) throw new Error('interviewBytes: id is required');
  if (!isAgentId(agentId)) throw new Error('interviewBytes: agentId must be a 43-char base64url key');
  if (typeof statement !== 'string') throw new Error('interviewBytes: statement must be a string');
  return Buffer.from(`agent-commons/admission-interview/v1\n${id}\n${agentId}\n${sha256hex(statement)}`, 'utf8');
}

/**
 * Bytes a REMOTE agent signs to claim an admission it reached through the relay.
 *
 * Why a second pair of builders instead of reusing the two above with `id` set to the requestId:
 * a remote agent never sees the local admission uuid — the relay's `requestId` is the only handle
 * it has. Signing that handle under the SAME domain as a local binding would mean a signature
 * collected for a relay request could be replayed as a local binding for any admission whose id
 * happened to equal that requestId. Distinct domain lines make the two contexts
 * non-interchangeable, which is the same reason the local pair is domain-separated from messages.
 *
 * The signed payload is still only a requestId and a key: the relay passes it through opaquely and
 * verifies nothing, exactly as it does for every other blob.
 */
export function relayBindBytes({ requestId, agentId } = {}) {
  if (typeof requestId !== 'string' || !requestId) throw new Error('relayBindBytes: requestId is required');
  if (!isAgentId(agentId)) throw new Error('relayBindBytes: agentId must be a 43-char base64url key');
  return Buffer.from(`agent-commons/relay-bind/v1\n${requestId}\n${agentId}`, 'utf8');
}

/** The remote counterpart of `interviewBytes`; the statement is hashed for the same reason. */
export function relayInterviewBytes({ requestId, agentId, statement } = {}) {
  if (typeof requestId !== 'string' || !requestId) throw new Error('relayInterviewBytes: requestId is required');
  if (!isAgentId(agentId)) throw new Error('relayInterviewBytes: agentId must be a 43-char base64url key');
  if (typeof statement !== 'string') throw new Error('relayInterviewBytes: statement must be a string');
  return Buffer.from(`agent-commons/relay-interview/v1\n${requestId}\n${agentId}\n${sha256hex(statement)}`, 'utf8');
}

/** Shared by both interview paths: the shape rules must not differ between local and remote. */
function checkInterviewFields(statement, answers) {
  if (typeof statement !== 'string' || !statement.trim()) return 'bad_statement';
  if (statement.length > 4000) return 'statement_too_long';
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return 'bad_answers';
  for (const [question, answer] of Object.entries(answers)) {
    if (!question.trim() || typeof answer !== 'string') return 'bad_answers';
    if (answer.length > 4000) return 'answer_too_long';
  }
  return null;
}

function safeWrong(wrong) {
  // scoreChallenge carries verifier-only `expected` snippets; never relay them.
  return wrong.map(({ i, given }) => ({ i, given }));
}

/** Create a local manager with verifier-only salt and knowledge base injected by its owner. */
export function createAdmissionManager({
  dir,
  salt,
  kb,
  now = () => Date.now(),
  items = DEFAULT_ITEMS,
  windowMs = DEFAULT_WINDOW_MS,
} = {}) {
  if (typeof dir !== 'string' || !dir) throw new Error('admission: dir is required');
  if (typeof salt !== 'string' || !salt) throw new Error('admission: verifier salt is required');
  if (!kb || !Array.isArray(kb.chains) || kb.chains.length === 0) {
    throw new Error('admission: verifier knowledge base is required');
  }
  if (typeof now !== 'function') throw new Error('admission: now must be a function');
  if (!Number.isInteger(windowMs) || windowMs < 1) throw new Error('admission: windowMs must be a positive integer');
  if (!Number.isInteger(items) || items < 1) throw new Error('admission: items must be a positive integer');

  const storePath = join(dir, STORE_NAME);
  mkdirSync(dir, { recursive: true });

  function readStore() {
    if (!existsSync(storePath)) return { admissions: [] };
    const value = JSON.parse(readFileSync(storePath, 'utf8'));
    if (!value || !Array.isArray(value.admissions)) throw new Error('admission: invalid admissions store');
    return value;
  }

  function writeStore(store) {
    writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  }

  function timestamp() {
    const value = now();
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('admission: now() must return a finite timestamp');
    return value;
  }

  function expirePending(store, at) {
    let changed = false;
    for (const record of store.admissions) {
      if (record.status === 'pending' && at >= record.issuedAt + record.windowMs) {
        record.status = 'expired';
        changed = true;
      }
    }
    if (changed) writeStore(store);
  }

  function list() {
    const store = readStore();
    const at = timestamp();
    expirePending(store, at);
    return store.admissions.map((record) => {
      const expiresAt = record.issuedAt + record.windowMs;
      return {
        id: record.id,
        // A record adopted from the relay NEVER had a local join key: that short handle is a local
        // concept, minted here for a challenge this machine issued. Reading `.slice()` off it crashed
        // the whole list — and therefore the grant route — the first time a relay verdict was adopted.
        // The honest answer is null, not an invented key and not an exception.
        joinKey: record.joinKey ?? null,
        short: record.joinKey ? record.joinKey.slice(0, 8) : null,
        issuedAt: record.issuedAt,
        expiresAt,
        msRemaining: record.status === 'expired' ? Math.min(0, expiresAt - at) : Math.max(0, expiresAt - at),
        status: record.status,
        verdict: record.verdict ?? null,
        agentId: record.agentId ?? null,
        // `bound` is the single question the permit seam depends on, so it is stated outright
        // rather than left for a caller to infer from a null.
        bound: !!record.agentId,
        // HOW the key got attached. A local binding is signed over the admission id and a relay
        // binding over the relay requestId, so this is what tells an auditor which bytes to
        // re-derive. Without it the stored signature is unverifiable after the fact — the proof is
        // present but unusable.
        boundVia: record.agentId ? (record.boundVia ?? 'local') : null,
        relayRequestId: record.relayRequestId ?? null,
        // WHERE the decision was reached. A local decision went through this machine's challenge; an
        // adopted one was reached elsewhere and carries an operator's signature instead. A reader who
        // cannot tell them apart would have to trust a record's word for its own provenance.
        via: record.via ?? 'local',
        decision: record.decision ?? null,
        grantee: record.grantee ?? null,
        decidedBy: record.decidedBy ?? null,
        // Whether an admin WAIVED a failed challenge in order to admit this record. `decision:'grant'`
        // cannot distinguish a pass from a waiver, and `verdict` cannot either once the record is
        // decided -- so without this field the two render identically, which is precisely how the
        // score became decorative. (The score itself is already published as `verdict.ok`; this is
        // the one fact here that is NOT derivable from any other field.)
        overrodeFailedChallenge: record.overrodeFailedChallenge ?? null,
        interview: record.interview ? {
          statement: record.interview.statement,
          answers: record.interview.answers,
          at: record.interview.interviewAt,
          signed: record.interview.signed === true,
          // WHO signed, and OVER WHICH HANDLE — for the same reason as `boundVia` above: a reader
          // told to "just re-derive the signed bytes" cannot, unless they know whether this text was
          // signed over the local admission id or over the relay requestId.
          signedBy: record.interview.signedBy ?? null,
          via: record.interview.via ?? 'local',
          relayRequestId: record.interview.relayRequestId ?? null,
          // Exposed so a reader can verify the record themselves instead of trusting the flag.
          sig: record.interview.sig ?? null,
        } : null,
      };
    });
  }

  function start(joinKey, opts = {}) {
    if (typeof joinKey !== 'string' || !joinKey.trim()) return { ok: false, reason: 'bad_join_key' };
    // The declaring key is optional so that an unbound challenge is still possible — but it is
    // recorded when given, and a record without one reports `bound:false` rather than pretending.
    const agentId = opts.agentId ?? null;
    if (agentId !== null && !isAgentId(agentId)) return { ok: false, reason: 'bad_agent_id' };
    const at = timestamp();
    const store = readStore();
    expirePending(store, at);
    if (store.admissions.some((record) => record.joinKey === joinKey && record.status === 'pending')) {
      return { ok: false, reason: 'pending_challenge' };
    }

    const seed = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const challenge = makeChallenge({ seed, salt, kb, items, windowMs });
    store.admissions.push({
      id, joinKey, agentId, seed, issuedAt: at, windowMs, status: 'pending', itemCount: challenge.count, verdict: null,
      interview: null,
    });
    writeStore(store);
    // Deliberately whitelist the public challenge fields. Never expose the salt or answer material.
    //
    // `kb` IS published, as of spec v0.5 §3g.2, and that is a measured decision rather than an
    // oversight. Withholding it scored a real external agent 85/150 = 56.7% against a 95% bar, for
    // a reason that cannot be argued away: the items ask about categories the item text never
    // mentions, and the expected answers come from THIS taxonomy. This route used to withhold it
    // while the relay route published it, which made the local door a wall that admitted nobody —
    // the same defect Trial 1 measured, left standing on the path an agent reaches first.
    // The `salt` stays hidden, and it is what stops a client precomputing an answer for a seed it
    // was never issued.
    return {
      id,
      challenge: {
        seed: challenge.seed,
        items: challenge.items,
        kb,
        options: challenge.options,
        count: challenge.count,
        windowMs: challenge.windowMs,
        passRatio: challenge.passRatio,
      },
    };
  }

  function answer(id, answers) {
    if (typeof id !== 'string' || !id) return { ok: false, reason: 'unknown_admission', correct: 0, total: 0, ratio: 0, wrong: [] };
    const store = readStore();
    const record = store.admissions.find((entry) => entry.id === id);
    if (!record) return { ok: false, reason: 'unknown_admission', correct: 0, total: 0, ratio: 0, wrong: [] };
    if (record.status !== 'pending') return { ok: false, reason: record.status === 'expired' ? 'expired' : 'not_pending', correct: 0, total: record.itemCount, ratio: 0, wrong: [] };
    const at = timestamp();
    if (at >= record.issuedAt + record.windowMs) {
      record.status = 'expired';
      writeStore(store);
      return { ok: false, reason: 'expired', correct: 0, total: record.itemCount, ratio: 0, wrong: [] };
    }
    if (!Array.isArray(answers)) return { ok: false, reason: 'bad_answers', correct: 0, total: record.itemCount, ratio: 0, wrong: [] };

    const score = scoreChallenge({ seed: record.seed, salt, kb, items: record.itemCount, answers });
    const verdict = { ok: score.ok, correct: score.correct, total: score.total, ratio: score.ratio, wrong: safeWrong(score.wrong) };
    record.status = 'answered';
    record.answeredAt = at;
    record.verdict = verdict;
    writeStore(store);
    return verdict;
  }

  // Human-readable evidence for an administrator; it is intentionally never scored.
  function interview(id, submission = {}) {
    const store = readStore();
    const record = store.admissions.find((entry) => entry.id === id);
    if (!record) return { reason: 'unknown_admission' };

    const at = timestamp();
    expirePending(store, at);
    if (record.status === 'expired') return { reason: 'expired' };
    if (record.status === 'decided') return { reason: 'already_decided' };

    const statement = submission && typeof submission === 'object' ? submission.statement : undefined;
    const answers = submission && typeof submission === 'object' ? submission.answers : undefined;
    // Shared with the relay path. Two copies of these rules is how a remote joiner ends up held to
    // a different standard than a local one, with neither implementation looking wrong on its own.
    const bad = checkInterviewFields(statement, answers);
    if (bad) return { reason: bad };

    // --- proof that the statement came from the key being admitted -------------------------
    //
    // This route sits ABOVE the console's per-run token check by design: the joining agent holds
    // no token, and the unguessable admission uuid is its handle. That makes the uuid a BEARER
    // capability — anyone who learns it can write to this record. The signature is what stops
    // them: on a bound record the statement must be signed by the bound key, so a stolen uuid
    // lets an attacker read nothing and write nothing that will be believed.
    let signed = false;
    let sig = null;
    if (record.agentId) {
      const agentId = submission && typeof submission === 'object' ? submission.agentId : undefined;
      const supplied = submission && typeof submission === 'object' ? submission.sig : undefined;
      if (typeof agentId !== 'string' || !supplied) return { reason: 'interview_not_signed' };
      // Name the wrong key explicitly rather than folding it into "bad signature": the two are
      // different events (a confused agent vs a forgery attempt) and an operator needs to tell
      // them apart when reading the log.
      if (agentId !== record.agentId) return { reason: 'interview_wrong_key' };
      let valid = false;
      try { valid = verify(agentId, interviewBytes({ id, agentId, statement }), supplied) === true; }
      catch { valid = false; }
      if (!valid) return { reason: 'interview_bad_signature' };
      signed = true;
      sig = supplied;
    }

    record.interview = {
      statement,
      answers: { ...answers },
      interviewAt: at,
      signed,
      signedBy: signed ? record.agentId : null,
      // The signature is KEPT, not merely checked. Verifying it once at the door and discarding
      // the proof leaves a record that asserts `signed:true` and carries no way for anyone else
      // to re-check it — the flag becomes the only evidence, and a flag is not evidence. The
      // signed bytes are recomputable from (id, agentId, statement), so storing the signature is
      // enough for a third party to verify the record from the store alone.
      sig,
    };
    writeStore(store);
    return { ok: true, id, signed };
  }

  /**
   * Attach an identity to an admission that was started without one.
   *
   * Needed for records created before the gate captured a key at all. The agent proves possession
   * by signing `bindBytes`, so a record cannot be claimed by a third party who merely read the
   * uuid. One-way by construction: once bound, the key is frozen, because a rebindable admission
   * could be stolen after the interview was written.
   */
  function bind(id, submission = {}) {
    if (typeof id !== 'string' || !id) return { reason: 'unknown_admission' };
    const { agentId, sig } = submission;
    if (!isAgentId(agentId)) return { reason: 'bad_agent_id' };
    if (typeof sig !== 'string' || !sig) return { reason: 'bind_not_signed' };
    const store = readStore();
    const record = store.admissions.find((entry) => entry.id === id);
    if (!record) return { reason: 'unknown_admission' };
    if (record.agentId) return { reason: 'already_bound' };
    let valid = false;
    try { valid = verify(agentId, bindBytes({ id, agentId }), sig) === true; }
    catch { valid = false; }
    if (!valid) return { reason: 'bind_bad_signature' };
    record.agentId = agentId;
    record.boundAt = timestamp();
    // Same rule as the interview: keep the proof, not just the verdict. Without this, `agentId`
    // is a field a later reader has to take on trust, and the signature that justified it is gone.
    record.bindSig = sig;
    writeStore(store);
    return { ok: true, id, agentId };
  }

  /**
   * Bind an admission using a signature made over the RELAY requestId.
   *
   * This is what makes the gate reachable from outside this machine. Before it existed, a remote
   * agent could sit the challenge, answer it, and submit an interview — and still could never be
   * admitted, because `decide` refuses to grant an unbound admission. The one step that proves the
   * agent owns its key was reachable only from localhost, so the commons could only ever admit
   * agents that were already on the operator's machine.
   *
   * The relay is not trusted to have checked anything: it stored an opaque blob, and the signature
   * is verified HERE, against bytes derived from the requestId the operator actually pulled. A
   * relay that rewrote the key or the requestId in transit produces a signature that fails.
   */
  function bindRelay(id, submission = {}) {
    if (typeof id !== 'string' || !id) return { reason: 'unknown_admission' };
    const { requestId, agentId, sig } = submission;
    if (typeof requestId !== 'string' || !requestId) return { reason: 'bad_request_id' };
    if (!isAgentId(agentId)) return { reason: 'bad_agent_id' };
    if (typeof sig !== 'string' || !sig) return { reason: 'bind_not_signed' };
    const store = readStore();
    const record = store.admissions.find((entry) => entry.id === id);
    if (!record) return { reason: 'unknown_admission' };
    if (record.agentId) return { reason: 'already_bound' };
    let valid = false;
    try { valid = verify(agentId, relayBindBytes({ requestId, agentId }), sig) === true; }
    catch { valid = false; }
    if (!valid) return { reason: 'bind_bad_signature' };
    record.agentId = agentId;
    record.boundAt = timestamp();
    record.bindSig = sig;
    // Record HOW the agent was bound. A local binding and a relay binding are the same claim made
    // over different handles, and an auditor reading this store later needs to know which bytes to
    // re-derive the signature from — otherwise the proof is unverifiable after the fact.
    record.boundVia = 'relay';
    record.relayRequestId = requestId;
    writeStore(store);
    return { ok: true, id, agentId, via: 'relay' };
  }

  /**
   * Record an interview that arrived through the relay, signed over the requestId.
   *
   * Requires the record to be bound FIRST, and to the same key. An interview signed by a key that is
   * not the one being admitted says nothing about the agent being admitted, so accepting it would
   * let an unrelated party write the text the admin reads.
   */
  function interviewRelay(id, submission = {}) {
    if (typeof id !== 'string' || !id) return { reason: 'unknown_admission' };
    const { requestId, agentId, sig, statement, answers } = submission;
    if (typeof requestId !== 'string' || !requestId) return { reason: 'bad_request_id' };
    const store = readStore();
    const record = store.admissions.find((entry) => entry.id === id);
    if (!record) return { reason: 'unknown_admission' };

    const at = timestamp();
    expirePending(store, at);
    if (record.status === 'expired') return { reason: 'expired' };
    if (record.status === 'decided') return { reason: 'already_decided' };

    // Bind first. An unbound record has no key to attribute this text to, and the admin's screen
    // must never show an agent's words that nothing ties to that agent.
    if (!record.agentId) return { reason: 'interview_not_bound' };
    if (agentId !== record.agentId) return { reason: 'interview_wrong_key' };
    // A relay binding is only meaningful for the request it was made over. A signature lifted from
    // a different request must not be attachable to this record.
    if (record.relayRequestId && record.relayRequestId !== requestId) return { reason: 'interview_wrong_request' };
    if (typeof sig !== 'string' || !sig) return { reason: 'interview_not_signed' };

    const bad = checkInterviewFields(statement, answers);
    if (bad) return { reason: bad };

    let valid = false;
    try { valid = verify(agentId, relayInterviewBytes({ requestId, agentId, statement }), sig) === true; }
    catch { valid = false; }
    if (!valid) return { reason: 'interview_bad_signature' };

    record.interview = {
      statement,
      answers: { ...answers },
      interviewAt: at,
      signed: true,
      signedBy: agentId,
      sig,
      via: 'relay',
      relayRequestId: requestId,
    };
    writeStore(store);
    return { ok: true, id, signed: true };
  }

  // A grant decision is an admin record only; it never issues a permit or authority.
  //
  // THE SCORE IS ENFORCED HERE, and it used to be enforced nowhere. `answer()` sets status
  // 'answered' whatever the score -- correctly, because a failed attempt is still an attempt and the
  // operator has to be able to refuse it -- so 'answered' never meant 'passed'. This function then
  // gated only on that status, which meant a 0/20 applicant who had bound a key could be GRANTED,
  // and the grant was indistinguishable from one that passed. Measured, not reasoned: the probe
  // (`.tmp/probe-failed-grant.mjs`) returned a full grant naming the grantee for a 0/20 score.
  //
  // Why it mattered: granteeFromAdmission() reads only status+decision+grantee, so that grant flowed
  // into a permit and the agent could SPEAK. The relay path never had this hole -- the console
  // derives granted/refused from `verdict.ok`, so a failed remote applicant is refused
  // automatically -- which left the gate enforced at ONE CALL SITE instead of in the shared seam,
  // giving a local applicant a different standard from a remote one. That is the exact drift this
  // file warns about elsewhere for the interview rules.
  //
  // `options.overrideFailedChallenge` exists because the admin is the root of authority and may
  // legitimately want to admit someone whose challenge was wrecked by a parser bug. What is not
  // acceptable is that such a grant be SILENT: the override is explicit, and it is recorded on the
  // record so the provenance survives into every listing.
  function decide(id, decision, adminAgentId, options = {}) {
    if (!['grant', 'refuse'].includes(decision)) return { ok: false, reason: 'bad_decision' };
    if (typeof adminAgentId !== 'string' || !adminAgentId) return { ok: false, reason: 'admin_agent_required' };
    const store = readStore();
    const record = store.admissions.find((entry) => entry.id === id);
    if (!record) return { ok: false, reason: 'unknown_admission' };
    // Distinguish "closed" from "not ready". Reporting a decided record as merely unanswered
    // sends an operator looking for a missing answer that is already there.
    if (record.status === 'decided') return { ok: false, reason: 'already_decided' };
    if (record.status !== 'answered') return { ok: false, reason: 'challenge_not_answered' };
    // THE SEAM. A permit names a grantee; granting an admission that never captured a key would
    // authorise nobody in particular, which is worse than refusing because it LOOKS like an
    // admission happened. Refusing is always allowed — closing a bad record needs no grantee.
    if (decision === 'grant' && !record.agentId) return { ok: false, reason: 'cannot_grant_unbound_admission' };
    // Checked AFTER the bind rule so the reason stays "cannot_grant_unbound_admission" for an
    // unbound record: that reason names the missing thing the operator has to fix, and reordering it
    // would send them to re-run a challenge that was never the problem.
    let overrode = false;
    if (decision === 'grant') {
      const passed = record.verdict?.ok === true;
      if (!passed) {
        if (options?.overrideFailedChallenge !== true) {
          return {
            ok: false,
            reason: 'challenge_not_passed',
            verdict: record.verdict ?? null,
            hint: 'This applicant did not pass the mechanical challenge. Send decision "refuse", or pass { overrideFailedChallenge: true } to admit them anyway — the override is recorded on the admission.',
          };
        }
        overrode = true;
      }
    }
    record.status = 'decided';
    record.decision = decision;
    record.decidedBy = adminAgentId;
    record.grantee = decision === 'grant' ? record.agentId : null;
    record.decidedAt = timestamp();
    // Only ever set when a failure was actually overridden, so its ABSENCE means "the score stood"
    // and its presence cannot be confused with a grant that passed on its own merits.
    if (overrode) record.overrodeFailedChallenge = true;
    writeStore(store);
    // The marker is carried in the RESULT as well, and only on an override, so a caller cannot report
    // a success without saying that the challenge was waived.
    return { id, decision, by: adminAgentId, grantee: record.grantee, ...(overrode ? { overrodeFailedChallenge: true } : {}) };
  }

  // Adopt a decision that was reached ELSEWHERE — over the relay, by an operator this node trusts.
  //
  // This deliberately does NOT go through start/answer/interview/decide. The challenge never happened
  // on this machine, and synthesising a local lifecycle to satisfy `decide()` would write down an
  // interview that never took place. A record that lies about its own provenance is worse than one
  // that states plainly where the decision came from, so this writes `via: 'relay'` and names the
  // operator whose signature authorised it.
  //
  // The authority for such a record is the operator's signature over the verdict, plus the bind that
  // fixes the grantee — both verified by the caller (src/permit-admission.mjs), which refuses to
  // produce this input unless they check out. This function only refuses to write a malformed one;
  // it is not the thing standing between a stranger and a permit.
  function adoptRelay({ requestId, decision, grantee, operator, decidedAt } = {}) {
    if (typeof requestId !== 'string' || !requestId) return { ok: false, reason: 'no_request_id' };
    if (!['grant', 'refuse'].includes(decision)) return { ok: false, reason: 'bad_decision' };
    if (typeof operator !== 'string' || !operator) return { ok: false, reason: 'no_operator' };
    // Same rule as decide(): granting an admission that never captured a key would authorise nobody
    // in particular, which is worse than refusing because it LOOKS like an admission happened.
    if (decision === 'grant' && !isAgentId(grantee)) {
      return { ok: false, reason: 'cannot_grant_unbound_admission' };
    }

    const store = readStore();
    const id = `relay:${requestId}`;
    const existing = store.admissions.find((entry) => entry.id === id);
    if (existing && existing.status === 'decided') return { ok: false, reason: 'already_decided' };

    const at = Number.isFinite(Number(decidedAt)) && Number(decidedAt) > 0 ? Number(decidedAt) : timestamp();
    const record = existing ?? { id, startedAt: at };
    record.status = 'decided';
    record.decision = decision;
    record.agentId = grantee;
    record.grantee = decision === 'grant' ? grantee : null;
    record.decidedBy = operator;
    record.decidedAt = at;
    record.via = 'relay';
    record.relayRequestId = requestId;
    // `list()` derives expiresAt from these two, so a record without them reports NaN and looks
    // neither live nor closed. A decision made elsewhere has no local window; it is simply decided.
    record.issuedAt = at;
    record.windowMs = 0;

    if (!existing) store.admissions.push(record);
    writeStore(store);
    return { ok: true, id, decision, grantee: record.grantee, via: 'relay' };
  }

  return Object.freeze({ list, start, answer, interview, interviewRelay, bind, bindRelay, decide, adoptRelay, storePath });
}

export default { createAdmissionManager };
