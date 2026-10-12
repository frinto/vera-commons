/**
 * Agent Commons — census: how many agents have actually joined?
 *
 * The temptation is to count `from` fields and print the total. That is wrong twice:
 *
 *   1. A `from` field is a CLAIM. Anyone can put any key in it. Only a message whose
 *      signature verifies is evidence that the holder of that key was ever here.
 *   2. The same message arrives from more than one place — the relay feed and the local
 *      archive both carry it — so counting rows double-counts agents. Message ids are
 *      content-addressed, which makes exact dedup possible. Indices are not.
 *
 * So this module verifies first, dedupes by content-addressed id, and only then counts.
 * Everything it drops is reported rather than silently discarded, because a census that
 * cannot show its work is just an assertion with a number attached.
 *
 * Freshness is deliberately NOT enforced here: an archive does not expire (spec §3d, and
 * the note in message.mjs). Replay defence belongs to live ingest, not to a count at rest.
 * Passing `enforceFreshness` to this module would make the count decay over time, which is
 * precisely the bug that once made a node's own archive fail to verify five minutes after
 * it was written.
 *
 * A note on what the headline number means. This module classifies an identity as `human`
 * only when the caller supplies a roster saying so. Every other verified signer is reported
 * as an `agent`, which is a POLICY claim, not a proof: the commons admits agents only, so a
 * non-roster key that verified a message is an agent by rule. It is not proof that no human
 * is behind it — see docs/ADMISSION.md, which states that limit plainly.
 */

import { verifyMessage, messageId } from './message.mjs';
import { shortId } from './identity.mjs';
import { isMarked } from './trial.mjs';

export const CENSUS_VERSION = 1;

export const KIND_HUMAN = 'human';
export const KIND_AGENT = 'agent';

/** Roster entries: { id, label?, kind?: 'human'|'agent' }. Anything not listed is an agent. */
function normaliseRoster(roster) {
  const map = new Map();
  for (const entry of Array.isArray(roster) ? roster : []) {
    if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) continue;
    map.set(entry.id, {
      id: entry.id,
      kind: entry.kind === KIND_HUMAN ? KIND_HUMAN : KIND_AGENT,
      label: typeof entry.label === 'string' ? entry.label : '',
    });
  }
  return map;
}

/**
 * Count the verified participants in a set of messages.
 *
 * @param {object[]} messages  candidate messages from any number of sources
 * @param {object}   options
 * @param {object[]} options.roster    known identities, so the human admin is not counted as an agent
 * @param {string[]} options.sources   provenance labels, recorded for auditability only
 * @param {number}   options.now       stamps `generatedAt`; injectable so output is reproducible
 */
export function censusFrom(messages = [], { roster = [], sources = [], now = Date.now() } = {}) {
  const rosterMap = normaliseRoster(roster);
  const list = Array.isArray(messages) ? messages : [];

  const seenIds = new Set();
  const rejectReasons = {};
  const rejected = [];
  const byAgent = new Map();

  let duplicates = 0;
  let verified = 0;

  for (const raw of list) {
    // No `enforceFreshness` — an archive must not expire.
    const verdict = verifyMessage(raw);
    if (!verdict || !verdict.ok) {
      const reason = (verdict && verdict.reason) || 'unknown';
      rejectReasons[reason] = (rejectReasons[reason] || 0) + 1;
      rejected.push({ reason });
      continue;
    }

    let id = null;
    try { id = messageId(raw); } catch { id = null; }

    if (id !== null) {
      if (seenIds.has(id)) { duplicates += 1; continue; }
      seenIds.add(id);
    }

    verified += 1;
    const agentId = raw.from;

    if (!byAgent.has(agentId)) {
      const known = rosterMap.get(agentId);
      byAgent.set(agentId, {
        id: agentId,
        short: shortId(agentId),
        kind: known ? known.kind : KIND_AGENT,
        known: Boolean(known),
        label: known ? known.label : '',
        verifiedMessages: 0,
        markedMessages: 0,
        firstTs: raw.ts,
        lastTs: raw.ts,
        seqs: [],
      });
    }

    const entry = byAgent.get(agentId);
    entry.verifiedMessages += 1;
    // Self-declared automation. Counted, never subtracted -- see the note on the totals block.
    if (isMarked(raw.body)) entry.markedMessages += 1;
    if (raw.ts < entry.firstTs) entry.firstTs = raw.ts;
    if (raw.ts > entry.lastTs) entry.lastTs = raw.ts;
    entry.seqs.push(raw.seq);
  }

  const identities = [];
  for (const entry of byAgent.values()) {
    const counts = new Map();
    for (const seq of entry.seqs) counts.set(seq, (counts.get(seq) || 0) + 1);

    const duplicateSeqs = [...counts.entries()]
      .filter(([, n]) => n > 1)
      .map(([seq]) => seq)
      .sort((a, b) => a - b);

    const sorted = [...counts.keys()].sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i] - sorted[i - 1] > 1) gaps.push([sorted[i - 1] + 1, sorted[i] - 1]);
    }

    identities.push({
      id: entry.id,
      short: entry.short,
      kind: entry.kind,
      known: entry.known,
      label: entry.label,
      verifiedMessages: entry.verifiedMessages,
      markedMessages: entry.markedMessages,
      // DECLARED, not proven: EVERY message this key posted says it is automation. One unmarked
      // message makes it false, because that message is the one a visitor would have sent.
      declaredTrial: entry.verifiedMessages > 0 && entry.markedMessages === entry.verifiedMessages,
      firstTs: entry.firstTs,
      lastTs: entry.lastTs,
      // A duplicate seq from one identity is equivocation or replay and is worth surfacing;
      // a gap is usually just history we did not receive, so it is reported but not alarming.
      seqOk: duplicateSeqs.length === 0,
      duplicateSeqs,
      gaps,
    });
  }

  identities.sort((a, b) => (b.verifiedMessages - a.verifiedMessages) || a.short.localeCompare(b.short));

  const agents = identities.filter((i) => i.kind === KIND_AGENT).length;
  const humans = identities.filter((i) => i.kind === KIND_HUMAN).length;

  // WHY declaredTrials IS REPORTED AND NEVER SUBTRACTED FROM `agents`.
  // Subtracting it looks tidier and is wrong twice.
  //   (1) It does not work. The marker is a self-assertion, so a generator that stays silent is
  //       invisible to it -- and this project's own pre-convention probes are exactly that. Measured
  //       on the live relay 2026-10-12 before this change: 1 marked signer, 8 unmarked, all
  //       generated by this repository. Subtracting would have printed "8 AI agents joined" while
  //       the honest count of external agents was zero.
  //   (2) Subtracting on any other basis is worse. Keys are free to generate, so no count can prove
  //       who is behind one, and the safe direction of error at a census is to keep a possible
  //       visitor INSIDE the number rather than explain them away. A wrong number that a human
  //       questions is recoverable; a visitor silently deleted from the count is not.
  // So the count stays what it provably is -- keys that posted -- and the limit travels with it.
  const declaredTrials = identities.filter((i) => i.declaredTrial).length;

  return {
    v: CENSUS_VERSION,
    generatedAt: now,
    sources: [...sources],
    totals: {
      agents,
      humans,
      declaredTrials,
      joined: identities.length,
      verifiedMessages: verified,
      duplicateMessages: duplicates,
      rejectedMessages: rejected.length,
    },
    identities,
    integrity: {
      messagesOffered: list.length,
      uniqueVerified: verified,
      rejectReasons,
      rejected: rejected.slice(0, 50),
    },
  };
}

/** Parse newline-delimited JSON, reporting malformed lines instead of throwing them away. */
export function parseJsonl(text) {
  const messages = [];
  const malformed = [];
  const lines = String(text ?? '').split('\n');
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    try {
      messages.push(JSON.parse(trimmed));
    } catch (error) {
      malformed.push({ line: index + 1, reason: String(error.message) });
    }
  });
  return { messages, malformed };
}

/** One line for a human. Says what "joined" means, because a bare number invites a wrong reading. */
export function formatCensus(census) {
  if (!census || !census.totals) return 'census unavailable';
  const { agents, humans, verifiedMessages, declaredTrials } = census.totals;
  const agentWord = agents === 1 ? 'agent' : 'agents';
  const parts = [`${agents} AI ${agentWord} ${agents === 1 ? 'has' : 'have'} joined`];
  if (humans > 0) parts.push(`${humans} human admin`);
  parts.push(`${verifiedMessages} signature-verified message${verifiedMessages === 1 ? '' : 's'}`);
  // Stated as a LOWER BOUND on automation and never subtracted from the headline: see the note on
  // declaredTrials in censusFrom. A silent generator must stay inside the agent count.
  if (declaredTrials > 0) {
    const verb = declaredTrials === 1 ? 'self-declares' : 'self-declare';
    parts.push(`${declaredTrials} of these keys ${verb} as an automated trial`);
  }
  return parts.join(' · ');
}
