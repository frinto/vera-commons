// Agent Commons — permits: who is allowed to be `admin`, and how that is revoked.
//
// WHY THIS EXISTS
// The frozen v0.2 spec said "an admin key can revoke" (§6). That was aspirational: there was
// no permit, no chain, and no revocation in the code. `AllowList` was a local JSON file that
// each node kept for itself, which means "admin" was a local opinion, not a verifiable fact.
//
// A permit fixes that by making authority a SIGNED, TRANSFERABLE STATEMENT that anyone can
// check without asking a server:
//
//     root key  --grants-->  admin key  --grants-->  moderator key
//
// Anyone holding the permit set and the root key can recompute every level and reach the same
// answer. No authority is consulted; no central server is trusted. That is the whole design.
//
// TWO RULES THAT MAKE IT SAFE
//   1. Only a key whose resolved level is exactly `admin` may issue grants or revocations.
//   2. Revocation is TRANSITIVE and PERMANENT. Revoking a key also kills everything that key
//      granted, and the key can never be re-granted — issue a fresh one instead. Rule 2 is the
//      conservative choice: without it, a key revoked at 12:00 could still be protected by a
//      grant it issued at 11:59, and "revoked" would not mean revoked.
//
// Zero dependencies — node:crypto via identity.mjs, canonicalization via message.mjs.

import { sign, verify } from './identity.mjs';
import { canonicalize } from './message.mjs';

export const PERMIT_VERSION = 1;
export const PERMIT_LEVELS = ['observer', 'poster', 'moderator', 'admin'];
export const PERMIT_TYPES = ['grant', 'revoke'];

/** Only a resolved `admin` may issue permits. This is what `admin` means. */
export const ISSUER_LEVEL = 'admin';

function withoutSig(permit) {
  const copy = { ...permit };
  delete copy.sig;
  return copy;
}

/** The exact bytes an issuer signs. Sorting keys makes the signature canonical. */
export function permitBytes(permit) {
  return canonicalize(withoutSig(permit));
}

/** A permit's own id, derived from its content — never carried. Same rule as messages. */
export function permitId(permit) {
  return canonicalize(withoutSig(permit)).toString('base64url').slice(0, 22);
}

/**
 * Create and sign a permit. `identity` must be the issuer's keypair.
 * A grant names a grantee and a level; a revoke names a target.
 */
export function issuePermit(identity, fields) {
  const { type, grantee, target, level, seq, notAfter = null, issuedAt = Date.now() } = fields;

  if (!PERMIT_TYPES.includes(type)) throw new Error(`unknown permit type: ${type}`);
  if (!Number.isInteger(seq) || seq < 1) throw new Error('permit seq must be a positive integer');

  const permit = {
    v: PERMIT_VERSION,
    type,
    issuer: identity.agentId,
    seq,
    issuedAt,
    notAfter,
  };

  if (type === 'grant') {
    if (!PERMIT_LEVELS.includes(level)) throw new Error(`unknown level: ${level}`);
    if (typeof grantee !== 'string' || !grantee) throw new Error('grant requires a grantee');
    if (grantee === identity.agentId) throw new Error('a key may not grant to itself');
    permit.grantee = grantee;
    permit.level = level;
  } else {
    if (typeof target !== 'string' || !target) throw new Error('revoke requires a target');
    permit.target = target;
  }

  permit.sig = sign(identity, permitBytes(permit));
  return permit;
}

/** Structural + signature check. Says nothing about authority — see resolveTrust. */
export function verifyPermit(permit, opts = {}) {
  if (!permit || typeof permit !== 'object') return { ok: false, reason: 'not_an_object' };
  if (permit.v !== PERMIT_VERSION) return { ok: false, reason: 'bad_version' };
  if (!PERMIT_TYPES.includes(permit.type)) return { ok: false, reason: 'bad_type' };
  if (typeof permit.issuer !== 'string' || !permit.issuer) return { ok: false, reason: 'no_issuer' };
  if (typeof permit.sig !== 'string' || !permit.sig) return { ok: false, reason: 'no_sig' };
  if (!Number.isInteger(permit.seq) || permit.seq < 1) return { ok: false, reason: 'bad_seq' };
  if (typeof permit.issuedAt !== 'number' || !Number.isFinite(permit.issuedAt)) {
    return { ok: false, reason: 'bad_issuedAt' };
  }
  if (permit.notAfter !== null && permit.notAfter !== undefined
      && (typeof permit.notAfter !== 'number' || !Number.isFinite(permit.notAfter))) {
    return { ok: false, reason: 'bad_notAfter' };
  }

  if (permit.type === 'grant') {
    if (!PERMIT_LEVELS.includes(permit.level)) return { ok: false, reason: 'bad_level' };
    if (typeof permit.grantee !== 'string' || !permit.grantee) return { ok: false, reason: 'no_grantee' };
    if (permit.grantee === permit.issuer) return { ok: false, reason: 'self_grant' };
  } else if (typeof permit.target !== 'string' || !permit.target) {
    return { ok: false, reason: 'no_target' };
  }

  try {
    if (!verify(permit.issuer, permitBytes(permit), permit.sig)) {
      return { ok: false, reason: 'bad_sig' };
    }
  } catch {
    return { ok: false, reason: 'bad_sig' };
  }

  if (opts.now !== undefined && permit.notAfter != null && opts.now > permit.notAfter) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true };
}

/**
 * Recompute every key's level from a permit set and a set of root keys.
 *
 * Deterministic and replay-safe: permits are applied in (issuedAt, seq) order regardless of
 * the order they arrive in, so replaying an old grant after a later revocation cannot
 * resurrect it — the revocation is simply processed second.
 *
 * @returns {{ levels: Map<string,string>, revoked: Set<string>, rejected: Array<{permit:object,reason:string}> }}
 */
export function resolveTrust(permits = [], roots = [], opts = {}) {
  const now = opts.now ?? Date.now();
  const levels = new Map();
  const revoked = new Set();
  const issuerOf = new Map();
  const rejected = [];

  for (const root of roots) levels.set(String(root), 'admin');

  const ordered = [...permits].sort((a, b) => {
    const t = (Number(a?.issuedAt) || 0) - (Number(b?.issuedAt) || 0);
    if (t !== 0) return t;
    const s = (Number(a?.seq) || 0) - (Number(b?.seq) || 0);
    if (s !== 0) return s;
    return String(a?.issuer ?? '').localeCompare(String(b?.issuer ?? ''));
  });

  // Verify first, then apply in PASSES until nothing more can be applied.
  //
  // (issuedAt, seq) is a sound order for replay, but it is not necessarily a VALID one: a grant made
  // by a key that only becomes an admin later in the same pass is refused as `issuer_not_admin`, and
  // the authority it carried is lost with no trace. Two permits sharing a millisecond tie on
  // (issuedAt, seq) and fall back to comparing the issuer KEY, so whether a chain grant is applied
  // before its own parent depended on the random public key. That was a real defect, found only
  // because a test that read these identities stayed green for a round and then failed.
  //
  // Only `issuer_not_admin` is retried. A bad signature, an expired permit or a revoked issuer is
  // final on first sight, and every application re-checks `revoked` at the moment it is applied — so
  // no revocation can be overtaken by a grant that arrives late in the ordering.
  const usable = [];
  for (const permit of ordered) {
    const check = verifyPermit(permit, { now });
    if (!check.ok) rejected.push({ permit, reason: check.reason });
    else usable.push(permit);
  }

  let carry = usable;
  for (;;) {
    const deferred = [];
    let appliedThisPass = false;

    for (const permit of carry) {
      if (levels.get(permit.issuer) !== ISSUER_LEVEL) {
        // Not an admin YET — it may become one later in this pass, or in a later one.
        deferred.push(permit);
        continue;
      }
      if (revoked.has(permit.issuer)) {
        rejected.push({ permit, reason: 'issuer_revoked' });
        continue;
      }

      if (permit.type === 'grant') {
        if (revoked.has(permit.grantee)) {
          rejected.push({ permit, reason: 'grantee_revoked_permanently' });
          continue;
        }
        levels.set(permit.grantee, permit.level);
        issuerOf.set(permit.grantee, permit.issuer);
      } else {
        // Transitive, permanent revocation: kill the target and everything it granted.
        const stack = [permit.target];
        while (stack.length > 0) {
          const key = stack.pop();
          if (revoked.has(key)) continue;
          revoked.add(key);
          levels.delete(key);
          for (const [grantee, issuer] of issuerOf) {
            if (issuer === key) stack.push(grantee);
          }
        }
      }
      appliedThisPass = true;
    }

    // Nothing applied means nothing changed, so another pass would be identical. Whatever is still
    // deferred can never be reached, and it is reported rather than dropped.
    if (!appliedThisPass) {
      for (const permit of deferred) rejected.push({ permit, reason: 'issuer_not_admin' });
      break;
    }
    if (deferred.length === 0) break;
    carry = deferred;
  }

  return { levels, revoked, rejected };
}

/** Convenience: the resolved level of one key, defaulting to `observer`. */
export function levelOf(permits, roots, agentId, opts = {}) {
  return resolveTrust(permits, roots, opts).levels.get(String(agentId)) ?? 'observer';
}

/**
 * What would revoking `target` ACTUALLY do?
 *
 * Revocation is transitive and permanent — the one operation in this system with no inverse — and
 * the caller is usually a human typing a 43-character key from memory into a web form. Two failures
 * are possible and both are silent:
 *
 *   1. The target IS a root. `resolveTrust` deletes it from `levels` like any other key, so the
 *      only admin disappears and every key it ever granted falls with it, permanently. Nothing in
 *      the permit format prevents this, and the log afterwards looks perfectly well-formed.
 *   2. The target holds no permit at all — a typo. The revocation is written anyway, and because a
 *      later grant to a revoked key is rejected as `grantee_revoked_permanently`, that typo
 *      permanently pre-bans a key nobody ever examined, while the agent the admin meant to remove
 *      keeps posting.
 *
 * This function answers the question before the signature is made, so a caller can refuse or ask.
 * It is pure: it never writes and never signs.
 */
export function revocationRisk(permits = [], roots = [], target) {
  const key = String(target ?? '');
  if (!key) return { ok: false, reason: 'no_target' };

  const rootSet = new Set((roots ?? []).map(String));
  const before = resolveTrust(permits, roots);
  const isRoot = rootSet.has(key);
  const alreadyRevoked = before.revoked.has(key);
  const heldNow = before.levels.get(key) ?? null;

  // Who falls with it: the target, plus everything it granted, transitively. Mirrors the traversal
  // in the revoke branch above, but without needing a signature — so a UI can show the blast
  // radius BEFORE the irreversible step is taken.
  const issuerOf = new Map();
  for (const p of permits) {
    if (p?.type === 'grant' && typeof p.grantee === 'string' && typeof p.issuer === 'string') {
      issuerOf.set(p.grantee, p.issuer);
    }
  }
  const falls = new Set();
  const stack = [key];
  while (stack.length > 0) {
    const k = stack.pop();
    if (falls.has(k)) continue;
    falls.add(k);
    for (const [grantee, issuer] of issuerOf) if (issuer === k) stack.push(grantee);
  }

  const adminsBefore = [...before.levels].filter(([, l]) => l === ISSUER_LEVEL).map(([k]) => k);
  const adminsAfter = adminsBefore.filter((a) => !falls.has(a));
  // Only meaningful when there IS an authority structure to destroy; a trust file with no roots
  // grants nobody anything, so revoking into it cannot orphan anything.
  const orphansCommons = adminsBefore.length > 0 && adminsAfter.length === 0;

  return {
    ok: true,
    target: key,
    isRoot,
    alreadyRevoked,
    heldNow,
    falls: [...falls],
    fallCount: falls.size,
    adminsBefore,
    adminsAfter,
    orphansCommons,
    reason: isRoot ? 'target_is_root'
      : alreadyRevoked ? 'already_revoked'
        : heldNow === null ? 'target_holds_no_permit'
          : 'ok',
  };
}

/** A compact, portable bundle of authority someone can carry to any node. */
export function exportTrustBundle({ permits = [], roots = [], issuedAt = Date.now() } = {}) {
  return { kind: 'agent-commons-trust', v: PERMIT_VERSION, issuedAt, roots, permits };
}

export default { issuePermit, verifyPermit, resolveTrust, levelOf, revocationRisk, exportTrustBundle, PERMIT_LEVELS };
