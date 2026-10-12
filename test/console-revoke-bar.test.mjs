// THE QUESTION THE CONSOLE COULD NOT ANSWER.
//
// `POST /api/revoke` refuses a key that holds no permit here until the caller sends
// `acknowledgeUnknown: true`, because that same request is what a TYPO produces and the server
// cannot tell the two apart. The refusal is therefore a question, not a failure.
//
// The console could not answer it. Its `api()` helper built the error from the server's prose and
// dropped the machine-readable `code`, so every refusal reached the button as an opaque string; and
// no code path in `index.html` ever sent `acknowledgeUnknown`. The only thing in the repository that
// sent it was `tools/permit-seam-probe.mjs`. Net effect: the server deliberately supported "bar a key
// in advance", told the admin to "confirm that you mean to bar it in advance", and the product
// offered no way to confirm. The feature was unreachable, not missing.
//
// This test does not read the HTML and pattern-match it -- a grep would pass on code that is never
// called. It EXTRACTS the shipped functions out of the shipped file and RUNS them against stubs, so
// what is measured is behaviour. The red arm below then proves the test can tell the fixed client
// from the broken one, because a test that cannot fail is not evidence.

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
// deliberately so: the extracted text is immediately handed to `new Function`, so a bad extraction
// shows up as a parse error rather than as a silently weakened test.
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

// Build a live client: the real `api` and the real revoke path, over stub IO.
function makeClient({ responses, confirmAnswer = true }) {
  const calls = [];
  const prompts = [];
  const apiSrc = extractFn(HTML, 'api');
  const revokeSrc = extractFn(HTML, 'revokeWithBar');
  if (!apiSrc || !revokeSrc) return { calls, prompts, missing: !apiSrc ? 'api' : 'revokeWithBar' };

  let n = 0;
  const fetchStub = async (url, opts) => {
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    const r = responses[Math.min(n++, responses.length - 1)];
    return { ok: r.ok, status: r.status, json: async () => r.body };
  };
  const confirmStub = (msg) => { prompts.push(msg); return confirmAnswer; };

  const factory = new Function(
    'fetch', 'confirm', 'TOKEN', 'lock',
    `${apiSrc}\n${revokeSrc}\nreturn { api, revokeWithBar };`
  );
  return { calls, prompts, client: factory(fetchStub, confirmStub, 'tok', () => {}) };
}

console.log('the console can answer the question the server asks back');

const OK = { ok: true, status: 200, body: { issued: 'revoke', revokedCount: 1 } };
const NEEDS_ACK = {
  ok: false, status: 409,
  body: { error: 'That key holds no permit here. ... confirm that you mean to bar it in advance.', code: 'target_holds_no_permit' },
};
const ROOT = { ok: false, status: 409, body: { error: 'That key is a ROOT of this commons.', code: 'target_is_root' } };

// --- 0. the shipped file actually contains the fix -----------------------------------------------
check('the shipped ui preserves the server error code', /err\.code\s*=\s*data\.code/.test(HTML));
check('the shipped ui can send acknowledgeUnknown', /acknowledgeUnknown:\s*true/.test(HTML));

// --- 1. an ordinary revoke must NOT trip the bar prompt ------------------------------------------
{
  const { calls, prompts, client } = makeClient({ responses: [OK] });
  const out = await client.revokeWithBar('A'.repeat(43));
  check('an ordinary revoke succeeds', out.issued === 'revoke', JSON.stringify(out));
  check('  ...in exactly one request', calls.length === 1, `${calls.length} requests`);
  check('  ...and the ordinary path NEVER claims acknowledgement',
    calls[0].body.acknowledgeUnknown === undefined,
    'if the normal path sent acknowledgeUnknown the two-step guard would be defeated silently');
  check('  ...and asks the admin nothing', prompts.length === 0, `${prompts.length} prompts`);
}

// --- 2. the bar path: refused once, confirmed, then sent WITH the acknowledgement ----------------
{
  const { calls, prompts, client } = makeClient({ responses: [NEEDS_ACK, { ok: true, status: 200, body: { issued: 'revoke', revokedCount: 1 } }] });
  const out = await client.revokeWithBar('B'.repeat(43));
  check('a key with no permit can be barred after confirmation', out.issued === 'revoke');
  check('  ...which takes exactly two requests', calls.length === 2, `${calls.length}`);
  check('  ...the retry carries acknowledgeUnknown:true', calls[1].body.acknowledgeUnknown === true);
  check('  ...and the admin was asked exactly once', prompts.length === 1, `${prompts.length} prompts`);
}

// --- 3. declining the bar must send nothing ------------------------------------------------------
{
  const { calls, prompts, client } = makeClient({ responses: [NEEDS_ACK], confirmAnswer: false });
  let threw = null;
  try { await client.revokeWithBar('C'.repeat(43)); } catch (e) { threw = e; }
  check('declining the bar throws rather than reporting success', threw !== null);
  check('  ...and sends no second request at all', calls.length === 1, `${calls.length} requests`);
  check('  ...and nothing was ever acknowledged', calls.every((c) => c.body.acknowledgeUnknown === undefined));
  check('  ...and the refusal is legible to the admin',
    threw && /holds no permit/i.test(threw.message), threw ? threw.message : 'no error');
}

// --- 4. CONTROL: the retry is keyed on the CODE, not on "any failure" ----------------------------
{
  const { calls, prompts, client } = makeClient({ responses: [ROOT] });
  let threw = null;
  try { await client.revokeWithBar('D'.repeat(43)); } catch (e) { threw = e; }
  check('CONTROL: a different 409 does not trigger the bar prompt', prompts.length === 0,
    'a blanket retry would let an admin click through a root-key refusal');
  check('  ...and it stays a single request', calls.length === 1);
  check('  ...and is still reported', threw !== null && /ROOT/.test(threw.message));
}

// --- 5. the second prompt must be a DIFFERENT question -------------------------------------------
{
  const { prompts, client } = makeClient({ responses: [NEEDS_ACK, OK] });
  await client.revokeWithBar('E'.repeat(43));
  const p = prompts[0] || '';
  check('the bar prompt says NOTHING will be removed', /NOTHING will be removed/.test(p));
  check('  ...and says it is a bar, not a removal', /BAR/i.test(p));
  check('  ...and warns it is permanent', /cannot be undone/i.test(p));
  check('  ...and shows the key so a typo is visible', p.includes('E'.repeat(16)));
  check('  ...and is not the sentence the first confirm uses',
    !/This also revokes every key it granted/.test(p),
    're-asking the first question would make the two-step guard a rubber stamp');
}

// --- 6. RED ARM: with the old, code-dropping api the bar path is unreachable ---------------------
// This is the whole reason the defect existed. If this arm passes trivially, the test above is
// measuring nothing.
{
  const apiSrc = extractFn(HTML, 'api');
  const revokeSrc = extractFn(HTML, 'revokeWithBar');
  const brokenApi = apiSrc.replace(/err\.code = data\.code;/, '');     // exactly the old behaviour
  check('RED ARM: the mutation actually changed the source', brokenApi !== apiSrc);

  const calls = [];
  const prompts = [];
  let n = 0;
  const responses = [NEEDS_ACK, OK];
  const factory = new Function('fetch', 'confirm', 'TOKEN', 'lock',
    `${brokenApi}\n${revokeSrc}\nreturn { revokeWithBar };`);
  const client = factory(
    async (url, opts) => {
      calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      const r = responses[Math.min(n++, responses.length - 1)];
      return { ok: r.ok, status: r.status, json: async () => r.body };
    },
    (m) => { prompts.push(m); return true; },
    'tok', () => {}
  );
  let threw = null;
  try { await client.revokeWithBar('F'.repeat(43)); } catch (e) { threw = e; }
  check('RED ARM: without the code the bar prompt never appears', prompts.length === 0,
    'the defect reproduced');
  check('RED ARM: ...so the admin is stuck at a refusal they cannot answer', threw !== null && calls.length === 1);
  check('RED ARM: ...and the server is never told they meant it', calls.every((c) => c.body.acknowledgeUnknown === undefined));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
