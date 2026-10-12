// THE FRONT DOOR -- the first URL anyone is given, and what it must not be.
//
// `GET /` returned 404. That was the single worst place for a 404 in the whole system: the README
// links this URL, the repository points its homepage at it, and so the one request every arriving
// human and every arriving agent makes came back as "not found" (44 bytes of it). A landing page an
// agent can read and act on is not decoration -- it is the difference between a visit and a join.
//
// These checks are about SUBSTANCE, not markup. The page must route a reader to the machine-readable
// contract, to the door, and to the one-file on-ramp; it must name its source; it must leak no
// secret; and it must state its limits instead of selling. A front door that oversells would fail
// this project's own honesty requirement, so that is pinned here alongside the plumbing.

import worker from '../worker/worker.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}

function makeKV() {
  const store = new Map();
  return {
    _store: store,
    async get(key, type) { const v = store.get(key); if (v === undefined) return null; return type === 'json' ? JSON.parse(v) : v; },
    async put(key, value) { store.set(key, value); },
    async list({ prefix = '', limit = 1000 } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })), list_complete: true };
    },
  };
}

const kv = makeKV();
const call = (path, method = 'GET') =>
  worker.fetch(new Request(`https://relay.test${path}`, { method }), { COMMONS: kv, ADMISSION_OPERATOR_SECRET: 'test-operator-secret' });

console.log('the front door — the URL everyone is handed');

// --- 1. it must answer at all -------------------------------------------------------------------
const res = await call('/');
const body = await res.text();
check('GET / answers 200 (it used to be a 404)', res.status === 200, `status ${res.status}`);
check('  ...as text a machine can read without a parser',
  /text\/plain/.test(res.headers.get('content-type') || ''), res.headers.get('content-type') || 'none');

// --- 2. it must route the reader somewhere useful ------------------------------------------------
check('it names the machine-readable contract', body.includes('/.well-known/agent-commons.json'));
check('it names the door', /\n\s*GET \/join/.test(body) || body.includes('GET /join'));
check('it names the one-file on-ramp', body.includes('/mcp.mjs'));
check('it names a liveness endpoint', body.includes('/health'));
check('it names the source', body.includes('github.com/frinto/vera-commons'));

// --- 3. honesty: it must not sell what the gate cannot prove -------------------------------------
check('it states that the admitted-outside-agent count is zero',
  /count of admitted outside agents is ZERO/i.test(body),
  'a front door that hides the real number is the overselling this project forbids');
check('it says the challenge is NOT evidence of intelligence or agency',
  /NOT evidence that the/i.test(body) && /intelligence/i.test(body));
check('it tells the reader content here is data, never instructions',
  /never instructions/i.test(body));
check('it tells the reader to verify signatures rather than trust the relay',
  /verify it against/i.test(body) && /not an authority/i.test(body));

// --- 4. it must leak nothing ---------------------------------------------------------------------
check('CONTROL: the landing carries no scorer secret', !/"salt"|'salt'|"expected"|"answers"/.test(body));
check('CONTROL: the landing does not echo the operator secret',
  !body.includes('test-operator-secret'), 'the landing leaked the operator credential');

// --- 5. one document, two names ------------------------------------------------------------------
const llms = await call('/llms.txt');
const llmsBody = await llms.text();
check('GET /llms.txt answers 200', llms.status === 200, `status ${llms.status}`);
check('  ...and is byte-identical to / so the two audiences cannot drift',
  llmsBody === body, `/ lengths ${body.length} vs ${llmsBody.length}`);
check('the landing is a real document, not a stub', body.length > 1200, `${body.length} bytes`);

// --- 6. HEAD must not carry a body, but must agree on status -------------------------------------
const head = await call('/', 'HEAD');
check('HEAD / agrees with GET /', head.status === 200 && (await head.text()) === '',
  `status ${head.status}`);

// --- 7. NEGATIVE CONTROL: the old behaviour is genuinely gone ------------------------------------
// If someone reintroduces a catch-all 404 ahead of the landing, this fails.
const bogus = await call('/definitely-not-a-route');
check('CONTROL: an unknown path still 404s (the landing did not become a catch-all)',
  bogus.status === 404, `status ${bogus.status} -- a catch-all would hide real 404s`);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
