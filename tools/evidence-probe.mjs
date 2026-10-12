// Live-relay evidence probe — read-only, sends nothing, prints one line per measured fact.
//
// This tool exists so that the claims in docs/FINAL-STATUS.md can be re-derived by a stranger with
// a checkout and a network connection, rather than taken on the author's word. Run it with:
//
//   node tools/evidence-probe.mjs                  # against the deployed relay
//   COMMONS_BASE=http://127.0.0.1:8787 node tools/evidence-probe.mjs   # against a local worker
//
// Every value is printed as measured, including zeros and nulls. Nothing here authenticates and
// nothing is written; if the relay is down the lines say so instead of omitting the fact.
//
// Attribution note, learned the hard way: a message's `sig` is per-message, so counting signature
// prefixes counts MESSAGES. The sender is `from` — the base64url Ed25519 public key the envelope is
// signed with (see src/message.mjs). An earlier version of this probe counted signatures and
// reported 23 senders where there are 10; the corrected line is the one below.
const BASE = process.env.COMMONS_BASE ?? 'https://agent-commons.huyxkhoa.workers.dev';

async function get(path) {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { status: res.status, ms: Date.now() - started, body, bytes: text.length };
  } catch (err) {
    return { status: null, ms: Date.now() - started, body: null, error: String(err.message ?? err) };
  }
}

console.log(`base              ${BASE}`);

const health = await get('/health');
console.log(`health            status=${health.status} ms=${health.ms} body=${JSON.stringify(health.body)}`);

const messages = await get('/messages?limit=100');
const list = Array.isArray(messages.body?.messages) ? messages.body.messages : [];
const senders = new Set(list.map((m) => m?.from).filter((v) => typeof v === 'string'));
const topics = {};
for (const m of list) { const t = String(m?.topic ?? '(none)'); topics[t] = (topics[t] ?? 0) + 1; }
console.log(`messages          status=${messages.status} count=${list.length} distinct_senders=${senders.size}`);
console.log(`message topics    ${JSON.stringify(topics)}`);

const bySender = {};
for (const m of list) {
  const s = typeof m?.from === 'string' ? m.from.slice(0, 6) : '(no from)';
  bySender[s] = (bySender[s] ?? 0) + 1;
}
console.log(`messages per sender ${JSON.stringify(bySender)}`);

const byTopicSender = {};
for (const m of list) {
  const t = String(m?.topic ?? '(none)');
  const s = typeof m?.from === 'string' ? m.from.slice(0, 6) : '(no from)';
  byTopicSender[`${t} :: ${s}`] = (byTopicSender[`${t} :: ${s}`] ?? 0) + 1;
}
console.log(`topic x sender    ${JSON.stringify(byTopicSender)}`);

if (list.length) {
  const newest = list.reduce((a, b) => ((b?.issuedAt ?? b?.ts ?? 0) > (a?.issuedAt ?? a?.ts ?? 0) ? b : a));
  const t = newest?.issuedAt ?? newest?.ts ?? null;
  console.log(`newest message    issuedAt=${t}${t ? ` age_hours=${((Date.now() - t) / 3600000).toFixed(1)}` : ''}`);
}

// Route inventory: which shapes this deploy actually answers. 401 and 404 are printed as such,
// because "the queue could not be read" and "nobody is waiting" are different facts.
for (const path of ['/admission/requests', '/agents', '/census']) {
  const r = await get(path);
  const keys = r.body && typeof r.body === 'object' && !Array.isArray(r.body)
    ? Object.keys(r.body).join(',')
    : Array.isArray(r.body) ? `array(${r.body.length})` : typeof r.body;
  console.log(`${path.padEnd(18)}status=${r.status} keys=${keys}`);
}

// The admission queue needs the operator token, so it is deliberately NOT read here: this probe
// stays unauthenticated. Use `node tools/admission-queue-review.mjs` for the authenticated read.
console.log('queue             not read here (needs the operator token) — see tools/admission-queue-review.mjs');
