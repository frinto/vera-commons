// Agent Commons — discovery tests.
//
// The claim under test: two nodes that have NEVER been told about each other can
// still find each other, and the finding is VERIFIABLE rather than trust-on-first-use.
//
// The end-to-end case is the one that matters. Carol is created fresh and told
// nothing — no key, no id, no endpoint. She is handed one URL. She must end up
// knowing who is there and having read their signed messages.
//
// Run: node test/discovery.test.mjs

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

import { CommonsNode } from '../src/node.mjs';
import { createCommonsServer } from '../src/server.mjs';
import { HttpTransport } from '../src/transport-http.mjs';
import { discover, verifyDiscovery, buildDiscovery, WELL_KNOWN_PATH, PROTOCOL } from '../src/discovery.mjs';
import worker from '../worker/worker.js';

const BASE = join(import.meta.dirname, '..', '.tmp', `discovery-${Date.now()}`);
mkdirSync(BASE, { recursive: true });

let n = 0;
const pass = (s) => { n++; console.log(`PASS ${s}`); };

async function main() {
  // --- 1. a node publishes a signed document about itself -------------------
  const alice = CommonsNode.open({ dir: join(BASE, 'alice') });
  alice.post({ type: 'hello', topic: 'discovery', body: { name: 'alice' } });

  const doc = buildDiscovery(alice, { baseUrl: 'http://relay.test' });
  const v = verifyDiscovery(doc);
  assert.equal(v.ok, true, `expected ok, got ${JSON.stringify(v)}`);
  assert.equal(v.signed, true, 'a node with a key publishes a signed document');
  assert.equal(v.agentId, alice.agentId, 'the signature must bind the document to the node key');
  pass('a node publishes a signed discovery document');

  // The document must survive a JSON round trip — it travels over HTTP.
  const roundTripped = JSON.parse(JSON.stringify(doc));
  assert.equal(verifyDiscovery(roundTripped).ok, true, 'the document must verify after a JSON round trip');
  pass('the document verifies after a JSON round trip');

  // --- 2. tampering with discovery is detected ------------------------------
  {
    const forged = JSON.parse(JSON.stringify(doc));
    forged.peers.push({ agentId: 'z'.repeat(43), short: 'zzzzzzzz', level: 'admin', messages: 999, lastTs: Date.now() });
    const verdict = verifyDiscovery(forged);
    assert.equal(verdict.ok, false, 'injecting a fake admin peer must invalidate the document');
    assert.equal(verdict.reason, 'bad_signature');
    pass('injecting a peer into the document is detected');
  }
  {
    const forged = JSON.parse(JSON.stringify(doc));
    forged.pow.bits = 4; // lower the anti-flood cost the node advertises
    assert.equal(verifyDiscovery(forged).reason, 'bad_signature');
    pass('lowering the advertised proof-of-work cost is detected');
  }
  {
    const forged = JSON.parse(JSON.stringify(doc));
    forged.baseUrl = 'https://attacker.example';
    assert.equal(verifyDiscovery(forged).reason, 'bad_signature');
    pass('redirecting the advertised endpoint is detected');
  }
  {
    const forged = JSON.parse(JSON.stringify(doc));
    forged.protocol = 'something-else/9';
    assert.equal(verifyDiscovery(forged).reason, 'bad_protocol');
    pass('a foreign protocol is refused');
  }
  {
    const forged = JSON.parse(JSON.stringify(doc));
    delete forged.sig;
    assert.equal(verifyDiscovery(forged).reason, 'missing_signature');
    pass('a stripped signature is refused');
  }

  // --- 3. a keyless relay is honest about being unsigned --------------------
  {
    const relayDoc = buildDiscovery(null, { baseUrl: 'https://relay.test' });
    const rv = verifyDiscovery(relayDoc);
    assert.equal(rv.ok, true);
    assert.equal(rv.signed, false);
    assert.equal(rv.reason, 'unsigned_relay');
    pass('a keyless relay validates but is reported as unsigned');

    const liar = { ...relayDoc, sig: 'A'.repeat(86) };
    assert.equal(verifyDiscovery(liar).reason, 'sig_without_identity');
    pass('a relay that attaches a signature without an identity is refused');
  }

  // --- 4. THE CASE THAT MATTERS: discovery with no out-of-band information ---
  const server = createCommonsServer({ dir: join(BASE, 'alice') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // Carol knows only the URL. She has never seen alice's key, id or endpoint.
  const carol = CommonsNode.open({ dir: join(BASE, 'carol') });
  assert.equal(carol.peers().length, 0, 'carol must start knowing nobody');

  const found = await discover(base);
  assert.equal(found.ok, true, `discovery failed: ${JSON.stringify(found)}`);
  assert.equal(found.signed, true);
  assert.equal(found.agentId, alice.agentId, 'carol must recover alice\'s identity from the network alone');
  pass('a fresh node discovers a stranger\'s identity from one URL');

  // She now talks to the endpoint the document advertised, and nothing else.
  const endpoint = new URL(found.doc.endpoints.messages, found.doc.baseUrl).origin;
  const t = new HttpTransport({ endpoint });
  const synced = await t.syncIn(carol);
  assert.equal(synced.ok, true, `sync failed: ${JSON.stringify(synced)}`);
  assert.equal(synced.accepted, 1, `expected 1 message, got ${JSON.stringify(synced)}`);
  pass('she pulls and ingests that stranger\'s signed messages');

  const peers = carol.peers();
  assert.equal(peers.length, 1);
  assert.equal(peers[0].agentId, alice.agentId, 'the peer carol learned must be the one the signature named');
  assert.equal(carol.verify().ok, true, 'everything carol learned must verify');
  pass('the peer she learned about is the one the signature named, and it verifies');

  assert.equal(carol.allowList.levelOf(alice.agentId), 'observer', 'discovery must not confer privileges');
  pass('discovery confers no privileges: the discovered peer is still an observer');

  await new Promise((r) => server.close(r));

  // --- 5. the free-tier relay advertises itself the same way -----------------
  {
    const kv = { async get() { return null; }, async put() {}, async list() { return { keys: [], list_complete: true }; } };
    const res = await worker.fetch(new Request(`https://relay.test${WELL_KNOWN_PATH}`), { COMMONS: kv });
    assert.equal(res.status, 200);
    const relayDoc = await res.json();
    assert.equal(relayDoc.baseUrl, 'https://relay.test', 'the relay must advertise its own origin');
    assert.equal(relayDoc.endpoints.messages, '/messages');
    const rv = verifyDiscovery(relayDoc);
    assert.equal(rv.ok, true, `relay document must validate: ${JSON.stringify(rv)}`);
    assert.equal(rv.signed, false, 'the relay holds no keys and must not pretend otherwise');
    assert.equal(relayDoc.protocol, PROTOCOL);
    pass('the free-tier relay serves a valid unsigned discovery document');
  }

  console.log(`\n${n} assertions passed.`);
}

main().catch((err) => {
  console.error('\nFAIL:', err?.message || err);
  process.exit(1);
});
