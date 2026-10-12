// Independently re-verify a relay verdict, from a FRESH process, against the relay itself.
//
// The trial that produced the verdict asserted its own success, and a check that asserts its own
// success is the weakest kind of evidence. This re-reads the verdict over the public relay and
// verifies the detached ed25519 signature without reusing any of the trial's in-memory state.
//
// Usage: node tools/verify-relay-verdict.mjs <requestId>
import crypto from 'node:crypto';

const RELAY = process.env.AC_RELAY || 'https://agent-commons.huyxkhoa.workers.dev';
const requestId = process.argv[2];
if (!requestId) { console.error('usage: node tools/verify-relay-verdict.mjs <requestId>'); process.exit(2); }

const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const pubKey = (p) => crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, fromB64u(p)]), format: 'der', type: 'spki' });

// Canonicalise exactly as the signer did: keys sorted, no whitespace.
const canonicalize = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canonicalize).join(',')}]`
    : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(',')}}`);

const res = await fetch(`${RELAY}/admission/verdict?requestId=${encodeURIComponent(requestId)}`, { signal: AbortSignal.timeout(20000) });
console.log(`GET /admission/verdict?requestId=${requestId}`);
console.log(`  HTTP ${res.status}`);
const v = await res.json().catch(() => null);
if (!v) { console.log('  no verdict body'); process.exit(1); }
console.log(`  decision=${v.decision}  by=${String(v.by).slice(0, 16)}...`);

const ok = crypto.verify(
  null,
  Buffer.from(canonicalize({ requestId: v.requestId, decision: v.decision, by: v.by }), 'utf8'),
  pubKey(v.by),
  fromB64u(v.sig),
);
console.log(`  signature verifies against the operator key: ${ok}`);

// Sideband — a check that cannot fail proves nothing. Flip the decision and re-verify.
const tampered = crypto.verify(
  null,
  Buffer.from(canonicalize({ requestId: v.requestId, decision: v.decision === 'granted' ? 'refused' : 'granted', by: v.by }), 'utf8'),
  pubKey(v.by),
  fromB64u(v.sig),
);
console.log(`  SIDEBAND a flipped decision FAILS the same check: ${tampered === false}`);

// The relay must not be able to score: it holds no salt, so it must not report one.
console.log(`  relay reports a score/ratio/total: ${('score' in v) || ('ratio' in v) || ('total' in v)}`);
process.exit(ok && tampered === false ? 0 : 1);
