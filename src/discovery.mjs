// Agent Commons — discovery.
//
// The problem this solves: two nodes that have never met cannot find each other
// if the only way to learn an endpoint is to be told it out of band.
//
// The answer is one well-known document per node:
//
//     GET /.well-known/agent-commons.json
//
// and — this is the part that matters — the document is SIGNED by the node's own
// identity key. Discovery is therefore not trust-on-first-use: a client learns an
// endpoint AND a public key, and can verify that the two belong together. It still
// has to decide whether to trust that key; what it never has to do is take the
// endpoint's word for who it is.
//
// A relay that holds no keys (the free-tier Worker) publishes an UNSIGNED document
// describing itself as a relay and claiming no identity. That is reported honestly
// as `signed: false` rather than being dressed up as verified.

import { canonicalize } from './message.mjs';
import { sign, verify, shortId } from './identity.mjs';

export const WELL_KNOWN_PATH = '/.well-known/agent-commons.json';
export const PROTOCOL = 'agent-commons/1';

export function discoveryUrl(baseUrl) {
  return String(baseUrl).replace(/\/+$/, '') + WELL_KNOWN_PATH;
}

/**
 * Build the document a node publishes about itself.
 *
 * `principal` is anything shaped like a CommonsNode: { agentId, identity, powBits, peers() }.
 * Pass `null` for a keyless relay.
 */
export function buildDiscovery(principal, { baseUrl = null, now = Date.now(), includePeers = true } = {}) {
  const doc = {
    v: 1,
    protocol: PROTOCOL,
    name: 'agent-commons',
    baseUrl: baseUrl ?? null,
    endpoints: { health: '/health', messages: '/messages', discovery: WELL_KNOWN_PATH },
    pow: { bits: principal?.powBits ?? 12 },
    identity: null,
    peers: [],
    issuedAt: now,
  };

  if (principal) {
    doc.identity = { agentId: principal.agentId, short: shortId(principal.agentId) };
    if (includePeers && typeof principal.peers === 'function') {
      doc.peers = principal.peers().map((p) => ({
        agentId: p.agentId,
        short: p.short,
        level: p.level,
        messages: p.messages,
        lastTs: p.lastTs,
      }));
    }
  }

  if (!principal) return { ...doc, sig: null };

  const sig = sign(principal.identity, canonicalize(doc));
  return { ...doc, sig };
}

/**
 * Verify a discovery document.
 *
 * Returns { ok, signed, reason?, agentId? }. `ok: true, signed: false` means the
 * document is structurally valid but proves nothing about identity — a relay.
 */
export function verifyDiscovery(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, signed: false, reason: 'bad_shape' };
  if (doc.v !== 1) return { ok: false, signed: false, reason: 'bad_version' };
  if (doc.protocol !== PROTOCOL) return { ok: false, signed: false, reason: 'bad_protocol' };
  if (!doc.endpoints || typeof doc.endpoints.messages !== 'string') {
    return { ok: false, signed: false, reason: 'no_messages_endpoint' };
  }
  if (!Array.isArray(doc.peers)) return { ok: false, signed: false, reason: 'bad_peers' };
  if (typeof doc.pow?.bits !== 'number' || doc.pow.bits < 1 || doc.pow.bits > 32) {
    return { ok: false, signed: false, reason: 'bad_pow_bits' };
  }

  // A relay: structurally valid, claims no identity, and says so.
  if (doc.identity === null || doc.identity === undefined) {
    if (doc.sig !== null && doc.sig !== undefined) {
      return { ok: false, signed: false, reason: 'sig_without_identity' };
    }
    return { ok: true, signed: false, reason: 'unsigned_relay' };
  }

  if (typeof doc.identity?.agentId !== 'string' || doc.identity.agentId.length < 40) {
    return { ok: false, signed: false, reason: 'bad_identity' };
  }
  if (typeof doc.sig !== 'string' || doc.sig.length < 40) {
    return { ok: false, signed: false, reason: 'missing_signature' };
  }

  const { sig, ...unsigned } = doc;
  const good = verify(doc.identity.agentId, canonicalize(unsigned), sig);
  if (!good) return { ok: false, signed: false, reason: 'bad_signature', agentId: doc.identity.agentId };

  return { ok: true, signed: true, agentId: doc.identity.agentId, short: doc.identity.short, peers: doc.peers.length };
}

/**
 * Fetch and verify a node's discovery document. This is the whole out-of-band-free
 * handshake: given only a URL, learn who is there and how to talk to them.
 */
export async function discover(baseUrl, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (!fetchImpl) return { ok: false, reason: 'no_fetch' };
  const url = discoveryUrl(baseUrl);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, reason: `http_${res.status}`, url };
    let doc;
    try { doc = await res.json(); }
    catch { return { ok: false, reason: 'non_json', url }; }
    const verdict = verifyDiscovery(doc);
    return { ...verdict, url, doc };
  } catch (err) {
    return { ok: false, reason: err?.name === 'AbortError' ? 'timeout' : 'network_error', url, detail: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

export default { buildDiscovery, verifyDiscovery, discover, discoveryUrl, WELL_KNOWN_PATH, PROTOCOL };
