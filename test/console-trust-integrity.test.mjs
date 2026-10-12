// Trust-file reads must distinguish a clean absence from evidence of store corruption.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(join(HERE, '..', 'console', 'app.mjs'), 'utf8');
const HTML = readFileSync(join(HERE, '..', 'console', 'public', 'index.html'), 'utf8');
let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}
const statusSrc = extractFn(APP, 'readTrustStatus');
const readSrc = extractFn(APP, 'readTrust');
check('extracts the shipped status reader and fail-closed reader', Boolean(statusSrc && readSrc));
const warn = [];
const makeReaders = ({ exists = true, text = '', readError = null } = {}) => {
  const factory = new Function('existsSync', 'readFileSync', 'isAgentId', 'console', 'TRUST_FILE',
    `${statusSrc}\n${readSrc}\nreturn { readTrustStatus, readTrust };`);
  return factory(() => exists, () => { if (readError) throw readError; return text; },
    (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(id),
    { warn: (line) => warn.push(line) }, 'trust.json');
};

let readers = makeReaders({ exists: false });
let status = readers.readTrustStatus();
check('absent trust.json is a clean empty state', status.ok && status.state === 'clean'
  && status.reason === null && status.counts.roots === 0 && status.counts.permits === 0);
check('clean absence remains consumable as empty trust', readers.readTrust().roots.length === 0);

readers = makeReaders({ readError: new Error('access denied') });
status = readers.readTrustStatus();
check('unreadable trust.json is an integrity failure', !status.ok && status.state === 'integrity-failure' && status.reason === 'unreadable');
let threw = false;
try { readers.readTrust(); } catch (err) { threw = err.code === 'TRUST_INTEGRITY'; }
check('trust consumers fail closed on unreadable data', threw);

readers = makeReaders({ text: '{' });
status = readers.readTrustStatus();
check('invalid JSON is distinct from absence', !status.ok && status.reason === 'invalid_json');

readers = makeReaders({ text: '[]' });
status = readers.readTrustStatus();
check('parsed but wrong top-level shape is rejected', !status.ok && status.reason === 'invalid_shape');
readers = makeReaders({ text: JSON.stringify({ roots: [17], permits: [] }) });
status = readers.readTrustStatus();
check('non-identity root values are rejected', !status.ok && status.reason === 'invalid_shape');
readers = makeReaders({ text: JSON.stringify({ roots: [], permits: [null] }) });
status = readers.readTrustStatus();
check('non-record permits are rejected', !status.ok && status.reason === 'invalid_shape');
readers = makeReaders({ text: JSON.stringify({ roots: [], permits: [{ v: 1 }] }) });
status = readers.readTrustStatus();
check('record-shaped but unusable permits are rejected', !status.ok && status.reason === 'invalid_shape');

const validPermitShape = { v: 1, type: 'grant', issuer: 'A'.repeat(43), seq: 1, issuedAt: 0,
  notAfter: null, grantee: 'B'.repeat(43), level: 'admin', sig: 'signature' };
readers = makeReaders({ text: JSON.stringify({ roots: ['A'.repeat(43)], permits: [validPermitShape] }) });
status = readers.readTrustStatus();
check('valid store is distinguished and reports exact record counts', status.ok && status.state === 'valid'
  && status.counts.roots === 1 && status.counts.permits === 1 && readers.readTrust().roots.length === 1);
check('integrity failures emit a console warning', warn.some((line) => line.includes('[trust] integrity failure')));
check('status endpoint is GET-only and sits behind token verification',
  /if \(!tokenOK\(req, url\)\)[\s\S]*?url\.pathname === '\/api\/trust\/status' && req\.method === 'GET'[\s\S]*?\{ ok, state, reason, counts \}/.test(APP));
check('the console visibly warns and stops trust-dependent loading on failure',
  /id="trust-warning" role="alert"/.test(HTML)
    && /Trust store integrity failure \(" \+ trustStatus\.reason/.test(HTML)
    && /if \(!trustStatus\.ok\)[\s\S]*?return;/.test(HTML));
check('pre-edit reproduction artifact is retained', existsSync(join(HERE, '..', '.tmp', 'trust-shape-before.txt')));
console.log(`console-trust-integrity: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
