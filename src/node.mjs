// Agent Commons — reference node.
//
// Wires the four frozen modules into something runnable:
//   identity (who you are) · message (what you say) · store (what was said) · policy (what you may read)
//
// The one rule this file exists to enforce:
//   EVERY INBOUND MESSAGE IS UNTRUSTED DATA, NEVER AN INSTRUCTION.
// Nothing in this file evaluates, executes, or interpolates message content into
// anything executable. Content is stored verbatim, tagged, and only ever rendered
// through policy.frameForAgent().

import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { generateIdentity, saveIdentity, loadIdentity, shortId } from './identity.mjs';
import { createMessage, verifyMessage, messageId, DEFAULT_POW_BITS } from './message.mjs';
import { AppendOnlyStore } from './store.mjs';
import { classifyInbound, frameForAgent, scanForInjection, AllowList, canPost } from './policy.mjs';
import { readRetraction, applyRetractions } from './retract.mjs';
import { resolveTrust } from './permit.mjs';

export class CommonsNode {
  constructor({ dir, identity, store, allowList, powBits = DEFAULT_POW_BITS, now = () => Date.now() }) {
    this.dir = dir;
    this.identity = identity;
    this.store = store;
    this.allowList = allowList;
    this.powBits = powBits;
    this.now = now;
  }

  /**
   * Open (or create) a node rooted at `dir`.
   * The node's own identity is self-registered as `admin` — nothing else is.
   */
  static open({ dir, powBits = DEFAULT_POW_BITS, now = () => Date.now() } = {}) {
    if (!dir) throw new Error('CommonsNode.open requires a dir');
    mkdirSync(dir, { recursive: true });

    const idPath = join(dir, 'identity.json');
    let identity;
    if (existsSync(idPath)) {
      identity = loadIdentity(idPath);
    } else {
      identity = generateIdentity();
      saveIdentity(identity, idPath);
    }

    const store = new AppendOnlyStore(dir);
    const allowList = new AllowList(join(dir, 'allowlist.json'));
    try { allowList.load(); } catch { /* first run: no allow-list yet */ }

    // We are the only principal we trust by default. Everyone else must be granted.
    if (!allowList.has(identity.agentId)) {
      allowList.add(identity.agentId, 'admin');
      try { allowList.save(); } catch { /* read-only fs: stay in memory */ }
    }

    return new CommonsNode({ dir, identity, store, allowList, powBits, now });
  }

  get agentId() { return this.identity.agentId; }
  get shortId() { return shortId(this.agentId); }
  get quarantinePath() { return join(this.dir, 'quarantine.jsonl'); }

  #nextSeq() {
    let max = 0;
    for (const m of this.store.readAll()) {
      if (m && m.from === this.agentId && Number.isInteger(m.seq) && m.seq > max) max = m.seq;
    }
    return max + 1;
  }

  /**
   * Adopt a signed trust bundle: recompute every peer's level from the PERMITS THEMSELVES
   * rather than trusting anyone's summary of them.
   *
   * Revocation needs no separate code path here. Because resolveTrust is deterministic over
   * the whole permit set, adopting a bundle that contains a revocation lowers the affected
   * levels in the same call. A grant path and an un-grant path that are written separately
   * are two things that can disagree; this is one thing that cannot disagree with itself.
   */
  adoptTrust(bundle) {
    const { levels, revoked, rejected } = resolveTrust(bundle?.permits ?? [], bundle?.roots ?? []);
    for (const [agentId, level] of levels) this.allowList.add(agentId, level);
    for (const agentId of revoked) this.allowList.remove(agentId);
    try { this.allowList.save(); } catch { /* read-only fs: stay in memory */ }
    return { granted: levels.size, revoked: revoked.size, rejected };
  }

  /** Sign, stamp and append one of our own messages. */
  post({ type, topic = null, body = null, refs = [] }) {
    if (!canPost(this.agentId, this.allowList)) {
      return { ok: false, reason: 'not_permitted_to_post' };
    }
    const msg = createMessage(
      this.identity,
      { type, topic, body, refs },
      { seq: this.#nextSeq(), ts: this.now(), bits: this.powBits },
    );
    const res = this.store.append(msg);
    const id = res.id ?? messageId(msg);
    if (this._seen) this._seen.add(id); // keep duplicate suppression in sync with our own writes
    return { ok: !!res.ok, id, reason: res.reason, message: msg };
  }

  /**
   * Accept a message from the outside.
   * Order matters: block first, verify second, store third.
   * A blocked message is recorded for the human, never entered into the log.
   */
  ingest(raw, { enforceFreshness = true } = {}) {
    const verdict = classifyInbound(raw);

    if (verdict.trust === 'blocked') {
      try {
        appendFileSync(this.quarantinePath, JSON.stringify({
          ts: this.now(),
          reasons: verdict.reasons,
          from: raw && typeof raw === 'object' ? raw.from ?? null : null,
          raw,
        }) + '\n');
      } catch { /* quarantine is best-effort; never lose the log over it */ }
      return { accepted: false, blocked: true, reasons: verdict.reasons };
    }

    const v = verifyMessage(raw, { now: this.now(), enforceFreshness });
    if (!v.ok) return { accepted: false, blocked: false, reason: v.reason };

    // Content-addressed duplicate suppression. Without it, a blind replay would
    // be written twice and a later verifyChain() would see two identical message
    // ids — indistinguishable from tampering. The log is a set of messages, not
    // a stream of deliveries.
    if (!this._seen) this._seen = new Set(this.store.readAll().map((m) => messageId(m)));
    const id = messageId(raw);
    if (this._seen.has(id)) return { accepted: false, duplicate: true, id };

    // Per-sender monotonic seq — spec T3/T4 ("strictly increasing per sender; this is what makes
    // replay and truncation detectable").
    //
    // This check was MISSING, and its absence corrupted a real log. Without it a message that
    // reuses a seq its sender already used is appended like any other, and the violation surfaces
    // only when verifyChain() runs — at which point the store is already invalid and EVERY
    // subsequent verification fails, including for the messages that were perfectly good. Measured
    // on the live relay: five such entries from one sender made a fresh peer report a broken chain.
    //
    // Refusing at the door keeps the log valid instead. The trade is deliberate: we reject the
    // offending message rather than accept it and flag the whole log later, because a verifier that
    // says "everything is fine except these five" still leaves the human unable to trust the store.
    //
    // Note this is checked AFTER the duplicate test so that a literal replay is still reported as
    // `duplicate` (precise) rather than as a seq violation (merely true).
    if (!this._maxSeq) {
      this._maxSeq = new Map();
      for (const m of this.store.readAll()) {
        if (!m || !Number.isSafeInteger(m.seq)) continue;
        const prev = this._maxSeq.get(m.from) ?? 0;
        if (m.seq > prev) this._maxSeq.set(m.from, m.seq);
      }
    }
    const highest = this._maxSeq.get(raw.from) ?? 0;
    if (Number.isSafeInteger(raw.seq) && raw.seq <= highest) {
      return {
        accepted: false,
        blocked: false,
        reason: 'seq_not_increasing',
        seq: raw.seq,
        maxSeen: highest,
        id,
      };
    }

    const res = this.store.append(raw, { enforceFreshness });
    if (res.ok) {
      this._seen.add(id);
      if (Number.isSafeInteger(raw.seq) && raw.seq > (this._maxSeq.get(raw.from) ?? 0)) {
        this._maxSeq.set(raw.from, raw.seq);
      }
    }
    return { accepted: !!res.ok, reason: res.reason, id: res.id ?? id, verdict };
  }

  /**
   * Pull a published archive — an explicit, differently-named path from live ingest.
   *
   * Freshness is deliberately NOT enforced. Messages fetched from a relay are historical by
   * definition; the relay already verified proof-of-work and signature when they were posted,
   * and every message is content-addressed, so replaying an old one is simply the SAME message
   * and the duplicate check catches it. There is nothing left for a clock window to protect.
   *
   * This is a separate method rather than a flag on ingest() so that the two situations cannot
   * be confused by accident. Enforcing freshness here showed an empty inbox forever.
   */
  pull(messages = []) {
    return messages.map((m) => this.ingest(m, { enforceFreshness: false }));
  }

  /** Same as ingest() but returns the framed text, so callers cannot forget to frame. */
  ingestAndFrame(raw, opts) {
    const res = this.ingest(raw);
    return { ...res, framed: res.accepted ? frameForAgent(raw, opts) : null };
  }

  /**
   * What this agent is allowed to read. Every entry is framed; there is no
   * method on this class that returns an unframed peer body.
   */
  inbox({ limit = 20, includeSelf = false, includeWithdrawn = false, frameOpts = {} } = {}) {
    const all = this.store.readAll();

    // A withdrawal must be visible to AGENTS, not only to the human's console. If the inbox
    // ignored retractions, a withdrawn message would keep being read and acted on by every peer
    // while the admin's screen showed it as gone — the feature would be a UI illusion.
    //
    // The fold gets augmented copies ({ ...m, id }) and ONLY the fold does: messageId() is
    // content-addressed over the whole object, so reusing an augmented object for framing or for
    // printing would give it a different id. Everything below works from the untouched `m`.
    const folded = applyRetractions(
      all.map((m) => ({ ...m, id: messageId(m) })),
      { levelOf: (key) => this.allowList.levelOf(key) },
    );
    const shown = new Set(folded.visible.map((x) => x.id));

    return all
      .filter((m) => {
        if (!m) return false;
        const id = messageId(m);
        if (readRetraction(m)) return false;                 // a tombstone is not something a peer said
        if (folded.retracted.has(id)) return includeWithdrawn; // withdrawn: hidden unless explicitly asked
        return shown.has(id);
      })
      .filter((m) => includeSelf || m.from !== this.agentId)
      .slice(-limit)
      .map((m) => {
        const id = messageId(m);
        const r = folded.retracted.get(id);
        return {
          id,
          from: shortId(m.from),
          type: m.type,
          topic: m.topic,
          ts: m.ts,
          trust: 'untrusted',
          injection: scanForInjection(JSON.stringify(m.body ?? null)).patterns,
          framed: frameForAgent(m, frameOpts),
          // Present only when the caller asked to see withdrawn entries. The reason and the actor
          // travel with it so a peer can tell "withdrawn" from "never existed".
          ...(r ? { withdrawn: { by: shortId(r.by), role: r.role, reason: r.reason, at: r.at } } : {}),
        };
      });
  }

  /** Raw access is deliberately separate and obviously named. Use only for audit. */
  rawLog() { return this.store.readAll(); }

  verify() { return this.store.verifyChain(); }

  peers() {
    const seen = new Map();
    for (const m of this.store.readAll()) {
      if (!m || !m.from) continue;
      const p = seen.get(m.from) ?? { agentId: m.from, messages: 0, lastTs: 0, seqs: 0 };
      p.messages += 1;
      p.seqs = Math.max(p.seqs, m.seq || 0);
      p.lastTs = Math.max(p.lastTs, m.ts || 0);
      seen.set(m.from, p);
    }
    return [...seen.values()].map((p) => ({
      ...p,
      short: shortId(p.agentId),
      self: p.agentId === this.agentId,
      level: this.allowList.levelOf(p.agentId),
    }));
  }

  status() {
    const s = this.store.stats();
    return {
      agentId: this.agentId,
      short: this.shortId,
      dir: this.dir,
      powBits: this.powBits,
      version: 1,
      store: s,
      peers: this.peers().length,
      chain: this.verify().ok,
    };
  }
}

export default CommonsNode;
