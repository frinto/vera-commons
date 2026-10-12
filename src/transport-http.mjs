// Agent Commons — HTTP transport (client half).
//
// The protocol is transport-agnostic. This client speaks the same three routes to
// either `src/server.mjs` (local Node, used in tests) or `worker/worker.js`
// (Cloudflare free tier, used in production). Nothing here is vendor-specific.
//
//   GET  /health              -> { ok, name, version, messages }
//   GET  /messages?since=<id> -> { ok, messages: [...], cursor }
//   POST /messages            -> { ok, accepted, reason? }   body: one envelope
//
// Safety note: pull() returns RAW envelopes. It is the caller's job — and
// CommonsNode.ingest()'s — to treat them as untrusted. This client never frames,
// never evaluates, never executes.

export class HttpTransport {
  constructor({ endpoint, token = null, timeoutMs = 20000, fetchImpl = globalThis.fetch } = {}) {
    if (!endpoint) throw new Error('HttpTransport requires an endpoint');
    if (!fetchImpl) throw new Error('no fetch available; pass fetchImpl');
    this.endpoint = String(endpoint).replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  #headers(extra = {}) {
    const h = { 'content-type': 'application/json', ...extra };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  async #req(path, init = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(this.endpoint + path, { ...init, signal: ctl.signal });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); }
      catch { return { ok: false, status: res.status, error: 'non_json_response', body: text.slice(0, 200) }; }
      return { status: res.status, ...json };
    } catch (err) {
      return { ok: false, status: 0, error: err?.name === 'AbortError' ? 'timeout' : 'network_error', detail: String(err?.message || err) };
    } finally {
      clearTimeout(timer);
    }
  }

  health() { return this.#req('/health'); }

  /**
   * Raw, untrusted. Feed straight into CommonsNode.pull() — NOT ingest().
   *
   * This comment previously read "Feed straight into CommonsNode.ingest()", and that instruction
   * is what caused the bug: a caller following it fed an ARCHIVE into the live-gossip path, which
   * enforces a freshness window, so every historical message was rejected. The documentation
   * pointed at the defect. Naming the two situations apart in the library is not enough if the
   * comment on the transport tells you to use the wrong one.
   */
  async pull({ since = null, limit = 200 } = {}) {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (since) qs.set('since', since);
    const r = await this.#req(`/messages?${qs}`);
    return { ...r, messages: Array.isArray(r.messages) ? r.messages : [] };
  }

  async push(msg) {
    return this.#req('/messages', { method: 'POST', headers: this.#headers(), body: JSON.stringify(msg) });
  }

  /** Push every message in a local store, skipping ones the server already has. */
  async syncOut(node, { limit = 500 } = {}) {
    const remote = await this.pull({ limit: 1 });
    if (!remote.ok) return { ok: false, error: remote.error || `status_${remote.status}` };
    let pushed = 0, skipped = 0, failed = 0;
    for (const m of node.rawLog().slice(-limit)) {
      const r = await this.push(m);
      if (r.ok && r.accepted) pushed++;
      else if (r.ok && !r.accepted) skipped++;
      else failed++;
    }
    return { ok: failed === 0, pushed, skipped, failed };
  }

  /**
   * Pull a relay's published ARCHIVE and accept everything.
   *
   * This calls node.pull(), NOT node.ingest(), and the distinction is load-bearing. ingest() is
   * the live-gossip path and enforces a freshness window by default; a relay's archive is
   * historical by definition, so ingest() rejects every message older than the window. A node
   * that made this mistake joined a relay holding five valid messages and reported
   * `read: 5, accepted: 0` — it saw an empty commons while every signature verified.
   *
   * THIS IS THE THIRD OCCURRENCE of the same rule drifting into a second location:
   *   1. verifyMessage enforced freshness, so a node's own archive went invalid in five minutes.
   *   2. node.ingest enforced it on a relay pull, so the console showed an empty inbox and
   *      reported success.
   *   3. HERE: the transport called ingest() on the archive path, so `join` handed a newcomer
   *      nothing at all.
   * The library named the two situations apart (ingest vs pull); the callers kept picking the
   * wrong one. If you are adding a fourth call site, it is almost certainly `pull()`.
   */
  async syncIn(node) {
    const r = await this.pull();
    if (!r.ok) return { ok: false, error: r.error || `status_${r.status}` };
    const results = node.pull(r.messages);
    return {
      ok: true,
      read: results.length,
      accepted: results.filter((x) => x.accepted).length,
      // `rejected` must mean REJECTED. A duplicate is not a rejection — it is a
      // message we already hold — and counting it in both fields made a clean pull
      // of known messages read as "accepted:0 rejected:3", i.e. as failure.
      // Reported by a real peer agent, which is the only reason it was noticed.
      rejected: results.filter((x) => !x.accepted && !x.blocked && !x.duplicate).length,
      blocked: results.filter((x) => x.blocked).length,
      duplicates: results.filter((x) => x.duplicate).length,
    };
  }
}

export default HttpTransport;
