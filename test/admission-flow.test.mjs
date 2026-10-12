// THE ADMISSION FLOW, WALKED END TO END -- and where it dead-ends.
//
// The front door tells a joiner: "A verdict records a SCORE. Only a PERMIT, issued by the human
// admin, confers standing." That sentence implies two objects and a durable standing. The worker
// has ONE object, and it expires. That gap is what this file measures.
//
// One real defect, plus one mistake this test made and now records.
//
//   F3  GRANTING BEFORE BINDING IS A PERMANENT DEAD END. `/admission/bind` refuses forever once a
//       verdict exists (`already_decided`), and a grant used to be accepted with no key bound -- so
//       the operator admitted a key they were never shown, the applicant could never bind, and
//       NOTHING told either of them. The published machine-readable `order` did not even list
//       `bind`, so an automated joiner following it walked straight in. THIS WAS REAL, and it is
//       the finding this file exists for.
//
//   M1  "NO PERMIT EXISTS" WAS WRONG, and the wrong version is preserved in check comments below.
//       The first draft measured the relay alone and concluded the door's promise of a permit was
//       unfulfilled. It is not: this project already defines a permit as a signed grant in the
//       authority chain of spec 3f, issued by an admin node and verifiable OFFLINE with
//       src/permit.mjs. The relay is not supposed to mint one. Had the first draft's fix shipped,
//       it would have created a competing source of truth for "who is admitted" -- the one
//       question that must have exactly one answer. Measuring a component in isolation and
//       assuming it is the whole system is how a test invents a defect that is not there.
//
// RUNS IN-PROCESS against the real worker with a fake KV. No network, no live relay, no debris.

import { identityFromSeed } from '../src/identity.mjs';
import { stampPow, DEFAULT_POW_BITS } from '../src/message.mjs';
import worker from '../worker/worker.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}

// A KV that REMEMBERS the options each write carried. This is the whole reason a bespoke fake is
// needed: the 24-hour expiry in F2 is invisible in the stored value and only exists in the write's
// options, so a fake that ignores `opts` cannot see the defect at all.
function makeKV() {
  const store = new Map();
  return {
    _store: store,
    _ttl: (key) => store.get(key)?.opts?.expirationTtl ?? null,
    async get(key, type) {
      const e = store.get(key);
      if (!e) return null;
      return type === 'json' ? JSON.parse(e.value) : e.value;
    },
    async put(key, value, opts) { store.set(key, { value, opts: opts || {} }); },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort()
        .slice(0, limit).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

const OPERATOR = 'test-operator-secret';
const env = (kv) => ({ COMMONS: kv, ADMISSION_OPERATOR_SECRET: OPERATOR });
const call = (path, { method = 'GET', body, operator = false, kv } = {}) => {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (operator) headers.authorization = `Bearer ${OPERATOR}`;
  return worker.fetch(new Request(`https://relay.test${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env(kv));
};

const rid = (n) => `flowtest-${String(n).padStart(8, '0')}`;
const joinKey = (c) => c.repeat(44).slice(0, 44);
const agentIdOf = (seedByte) => {
  const id = identityFromSeed(new Uint8Array(32).fill(seedByte));
  return id.agentId ?? id.publicKey;
};

/** Walk a joiner up to (but not through) the bind, and return the kv plus the ids. */
async function openChallenge(n, seedByte) {
  const kv = makeKV();
  const r = rid(n);
  const join = joinKey('a');
  const req = await stampPow({ requestId: r, joinKey: join, note: 'flow test' }, DEFAULT_POW_BITS);
  const rq = await call('/admission/request', { method: 'POST', body: req, kv });
  if (rq.status !== 201) throw new Error(`request failed: ${rq.status} ${await rq.text()}`);
  const ch = await call('/admission/challenge', {
    method: 'POST', operator: true, kv, body: { requestId: r, challenge: { items: [{ q: 'q', o: ['a'] }], windowMs: 45000 } },
  });
  if (ch.status !== 201) throw new Error(`challenge failed: ${ch.status} ${await ch.text()}`);
  return { kv, r, joinKey: join, agentId: agentIdOf(seedByte) };
}

const bindBody = (r, agentId) => stampPow({
  requestId: r, agentId, sig: 'x'.repeat(60),
}, DEFAULT_POW_BITS);

const verdictBody = (r, decision) => ({
  requestId: r, decision, by: 'y'.repeat(43), sig: 'z'.repeat(60),
});

console.log('admission flow — where a joiner gets stuck, and whether a permit is a thing');

// --- 1. the happy order: bind, THEN the operator decides ---------------------------------------
{
  const { kv, r, agentId } = await openChallenge(1, 31);

  const b = await call('/admission/bind', { method: 'POST', kv, body: bindBody(r, agentId) });
  check('bind succeeds while no verdict exists', b.status === 201, `status ${b.status}`);
  check('  ...and the relay now knows which key is being admitted',
    (await kv.get(`a:bnd:${r}`, 'json'))?.agentId === agentId);

  const v = await call('/admission/verdict', { method: 'POST', operator: true, kv, body: verdictBody(r, 'granted') });
  check('the operator can grant once a key is bound', v.status === 201, `status ${v.status}`);

  // F1/F2 WERE THIS TEST'S OWN MISTAKE, and they are kept here as the correction. The first draft
  // asserted that a grant must write a durable relay-side "permit". It must not: this project
  // already defines a permit as a signed grant in the authority chain of spec 3f, issued by an
  // admin node and verifiable OFFLINE (src/permit.mjs), and a relay-side duplicate would be a
  // competing source of truth for "who is admitted". Measuring the relay in isolation and assuming
  // it was the whole system is exactly how a test invents a defect that is not there.
  const verdict = await kv.get(`a:vrd:${r}`, 'json');
  check('a grant records the key it admitted', verdict?.agentId === agentId,
    'without this the public verdict is unlinkable to any key and the grant cannot be audited');

  const permits = [...kv._store.keys()].filter((k) => k.startsWith('a:prm:'));
  check('CORRECTED: the relay writes NO relay-side permit', permits.length === 0,
    `a second source of truth for "who is admitted" appeared: ${JSON.stringify(permits)}`);

  const p = await call(`/admission/permit?agentId=${encodeURIComponent(agentId)}`, { kv });
  const pb = await p.json().catch(() => ({}));
  check('the relay refuses to answer "is this agent admitted?" rather than guessing',
    p.status === 501 && pb.reason === 'permits_are_not_a_relay_object',
    `status ${p.status} reason ${JSON.stringify(pb.reason)}; a 404 here would read as "not admitted yet"`);
}

// --- 1b. the public verdict must be readable, and must be honest about what it is not ----------
{
  const { kv, r, agentId } = await openChallenge(11, 41);
  await call('/admission/bind', { method: 'POST', kv, body: bindBody(r, agentId) });
  await call('/admission/verdict', { method: 'POST', operator: true, kv, body: verdictBody(r, 'granted') });

  const pub = await (await call(`/admission/verdict?requestId=${encodeURIComponent(r)}`, { kv })).json();
  check('the public verdict names the admitted key', pub.agentId === agentId, `agentId=${pub.agentId}`);
  check('the public verdict says it is not a permit',
    /not an authority|not a permit|verify/i.test(pub.verify || ''), `verify=${JSON.stringify(pub.verify)}`);
}

// --- 2. F3: the operator decides BEFORE the applicant binds ------------------------------------
{
  const { kv, r, agentId } = await openChallenge(2, 32);

  // Nothing wrong has happened yet. The operator, who has no way to know the applicant has not
  // bound, grants.
  const v = await call('/admission/verdict', { method: 'POST', operator: true, kv, body: verdictBody(r, 'granted') });
  check('F3: granting before a key is bound is REFUSED, not silently accepted',
    v.status === 409, `status ${v.status} -- a grant that names no key must not look like success`);
  if (v.status !== 201) {
    const b2 = await v.json().catch(() => ({}));
    check('  ...and the operator is told WHY', b2.reason === 'no_binding_yet', `reason ${JSON.stringify(b2.reason)}`);
  }

  // And if it ever IS accepted, the applicant must not be left with a permanent dead end.
  const b = await call('/admission/bind', { method: 'POST', kv, body: bindBody(r, agentId) });
  check('F3: a grant never strands the applicant -- bind remains possible',
    b.status === 201, `status ${b.status}; the applicant can never bind again and nobody is told`);
}

// --- 3. the machine-readable order must not omit a mandatory step -------------------------------
{
  const kv = makeKV();
  const disc = await (await call('/.well-known/agent-commons.json', { kv })).json();
  const order = disc?.admission?.order ?? [];
  check('F3: the published order includes the mandatory bind step',
    order.some((s) => /bind/i.test(s)), `order = ${JSON.stringify(order)}`);
  check('F3: the published order states that binding PRECEDES the verdict',
    /before|precede|then grant|prior/i.test(order.join(' ')) && /bind/i.test(order.join(' ')),
    `order = ${JSON.stringify(order)}`);
  check('the discovery document warns that permits are not relay objects',
    /permitsAreNotRelayObjects/.test(JSON.stringify(disc)) && /src\/permit\.mjs/.test(JSON.stringify(disc)),
    'a machine reader is not told where a permit actually comes from');

  // The DOOR is the artifact a joiner actually reads. Asserting this against the discovery JSON
  // was this test's own first bug: the sentence is in /join, and checking the wrong artifact
  // fails for a reason that has nothing to do with the product.
  const door = await (await call('/join', { kv })).text();
  check('the door still says an answer with no bind admits nobody',
    /no bind admits nobody/i.test(door));
  check('the door warns that binding must precede the verdict',
    /bind BEFORE an admin decides/i.test(door));
  check('the door says the relay cannot sell you a permit, and why',
    /THE RELAY CANNOT SELL YOU ONE/i.test(door) && /spec 3f/.test(door));
}

// --- 4. NEGATIVE CONTROL: a refusal must not mint standing -------------------------------------
// Refusing someone who never bound is coherent, so a refusal is allowed without a bind -- and it
// must therefore be impossible to launder a refusal into a permit.
{
  const { kv, r } = await openChallenge(4, 34);
  const v = await call('/admission/verdict', { method: 'POST', operator: true, kv, body: verdictBody(r, 'refused') });
  check('CONTROL: a refusal needs no bind', v.status === 201, `status ${v.status}`);
  const permits = [...kv._store.keys()].filter((k) => k.startsWith('a:prm:'));
  check('CONTROL: a refusal writes no permit at all', permits.length === 0,
    `permits written: ${JSON.stringify(permits)}`);
  check('CONTROL: the refusal is still recorded as a verdict',
    (await kv.get(`a:vrd:${r}`, 'json'))?.decision === 'refused');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
