// THE GRANT THAT ASKED NOTHING.
//
// Measured in a real browser on 2026-10-12 against a synthetic trust file, on the shipped page:
//
//   Grant by hand (Trust settings)   ->  0 questions, 1 POST   <- and this control can mint an ADMIN
//   Revoke a key                     ->  1 question,  1 POST
//   Bar an unknown key in advance    ->  2 questions, 2 POSTs
//
// The one act that CREATES authority was the least guarded, and a grant is permanent in the log: a
// revocation can follow it, but nothing can erase it. Revoking a key -- the low-authority, reversible
// -by-issuing-a-new-key act -- asked more than granting one did.
//
// The `admin` level is deliberately still offered on this path, and this test asserts nothing about
// that: the manual grant is the paste-a-43-character-key route, and it is how a second admin is meant
// to be minted. The admission path withholds `admin` because there the key arrives from a record the
// operator never typed. The friction belongs on the ACT, not in the authority model.
//
// This test EXTRACTS the shipped handler out of the shipped page and RUNS it over stubs, so what is
// measured is behaviour rather than a pattern in the source. The red arm removes the question and
// shows the count dropping back to zero.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, '..', 'console', 'public', 'index.html'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}

// Pull `async function <name>(...) {...}` out of a source text by matching braces. Naive, and
// deliberately so: the extracted text is handed straight to `new Function`, so a bad extraction shows
// up as a parse error rather than as a silently weakened test.
function extractFn(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

const apiSrc = extractFn(HTML, 'api');
const grantSrc = extractFn(HTML, 'grantByHand');

check('the shipped page defines api and grantByHand', Boolean(apiSrc && grantSrc),
  `api=${Boolean(apiSrc)} grantByHand=${Boolean(grantSrc)}`);
check('the Trust Grant button still routes through grantByHand',
  /\$\("btn-grant"\)\.addEventListener\("click", \(\) => grantByHand\(\)\)/.test(HTML));

const OK = { ok: true, status: 200, json: async () => ({ ok: true, level: 'poster' }) };

/** Run the shipped handler over stub IO with a controlled pre-existing DOM value set. */
function makeClient({ grant = grantSrc, agent = 'A'.repeat(43), level = 'poster', confirmAnswer = true }) {
  const calls = [];
  const prompts = [];
  const toasts = [];
  const fields = { 't-agent': { value: agent }, 't-level': { value: level } };
  const fetchStub = async (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok: OK.ok, status: OK.status, json: async () => OK.json() };
  };
  const confirmStub = (msg) => { prompts.push(String(msg)); return confirmAnswer; };
  const factory = new Function('fetch', 'confirm', 'TOKEN', 'lock', '$', 'toast', 'load', `
    ${apiSrc}
    ${grant}
    return { grantByHand };
  `);
  const client = factory(
    fetchStub, confirmStub, 'tok', () => {},
    (id) => fields[id] || { value: '' },
    (m) => { toasts.push(String(m)); },
    async () => {}
  );
  return { calls, prompts, toasts, client };
}

// --- 1. the grant now asks exactly one question, and still sends exactly one request -------------
{
  const { calls, prompts, client } = makeClient({ agent: 'B'.repeat(43), level: 'moderator' });
  await client.grantByHand();
  check('granting by hand asks ONE question', prompts.length === 1, `${prompts.length} questions`);
  check('  ...and sends ONE request', calls.length === 1, `${calls.length} requests`);
  check('  ...carrying the agent and the chosen level',
    calls[0] && calls[0].body.agent === 'B'.repeat(43) && calls[0].body.level === 'moderator',
    JSON.stringify(calls[0] && calls[0].body));
  const p = prompts[0] || '';
  check('  ...the question names the key being granted', p.includes('B'.repeat(16)));
  check('  ...and names the level being granted', p.includes('moderator'));
  check('  ...and states the grant is permanent in the log', /permanent in the log/i.test(p));
  check('  ...and says the revocation cannot be undone', /cannot itself be undone/i.test(p));
}

// --- 2. declining must send nothing --------------------------------------------------------------
{
  const { calls, prompts, client } = makeClient({ confirmAnswer: false });
  await client.grantByHand();
  check('declining the grant asks the question', prompts.length === 1);
  check('  ...and sends NO request at all', calls.length === 0, `${calls.length} requests`);
}

// --- 3. the guard that runs BEFORE the question --------------------------------------------------
{
  const { calls, prompts, toasts, client } = makeClient({ agent: '' });
  await client.grantByHand();
  check('an empty agent id is refused without asking anything', prompts.length === 0, `${prompts.length} questions`);
  check('  ...and sends no request', calls.length === 0);
  check('  ...and says what to do instead', toasts.some((t) => /paste an agent id/i.test(t)), JSON.stringify(toasts));
}

// --- 4. RED ARM: take the question away and the defect comes back --------------------------------
{
  const broken = grantSrc.replace('if (!confirm(q)) return;', 'if (q === null) return;');
  check('RED ARM: the mutation actually changed the source', broken !== grantSrc);

  const { calls, prompts, client } = makeClient({ grant: broken, confirmAnswer: true });
  await client.grantByHand();
  check('RED ARM: without the question the admin is asked NOTHING', prompts.length === 0, `${prompts.length} questions`);
  check('RED ARM: ...while the grant still lands, silently', calls.length === 1 && calls[0].body.level === 'poster');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
