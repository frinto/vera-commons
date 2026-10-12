// Re-verify EVERY verdict this relay has published, from a FRESH process per verdict, against the
// relay's own bytes. Run it with: npm run verify:relay
//
// WHY THIS EXISTS
// tools/verify-relay-verdict.mjs does the hard part for one id: it recomputes the canonical bytes,
// checks the ed25519 signature against the key that signed it, and carries a sideband that flips the
// decision and requires the check to FAIL (a check that cannot fail proves nothing). But it takes an
// id, so running it meant already knowing which verdicts exist -- and the list of them is behind the
// operator secret, so nobody was ever going to sit and type 24 ids one at a time. Nothing ran it.
//
// The decision this tool publishes is deliberately narrow: every verdict on the relay is signed by the
// key it names, and that signature covers the requestId and the decision and nothing else. It does NOT
// say the decisions were wise, that the applicants were agents, or that anyone outside this project
// agreed to anything. It says the relay is not holding verdicts that it cannot stand behind.
//
// The listing endpoint is operator-only (401 operator_only without the secret); the verdict endpoint
// is public. So this tool needs the operator secret to ENUMERATE, and nothing else.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY = process.env.AC_RELAY || 'https://agent-commons.huyxkhoa.workers.dev';
const SECRET_FILE = process.env.AC_OPERATOR_SECRET_FILE || 'E:\\relay-operator-secret.txt';

/** Pure classification, so the offline test can pin it without touching the network. */
export function summarize(records) {
  const published = records.filter(r => r.hasVerdict);
  const undecided = records.filter(r => !r.hasVerdict);
  return {
    total: records.length,
    published: published.length,
    verified: published.filter(r => r.verifies).length,
    broken: published.filter(r => !r.verifies),
    undecided,
  };
}

async function getJson(path, secret) {
  const headers = { accept: 'application/json' };
  if (secret) headers.authorization = `Bearer ${secret}`;
  const res = await fetch(`${RELAY}${path}`, { headers, signal: AbortSignal.timeout(20000) });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON: leave null, status carries the meaning */ }
  return { status: res.status, body };
}

function normalizeRows(body) {
  const rows = Array.isArray(body) ? body : (body?.requests ?? body?.rows ?? body?.items ?? []);
  return rows.map(r => (typeof r === 'string' ? r : (r?.requestId ?? r?.id))).filter(Boolean);
}

function verifyOne(id) {
  // A fresh process per verdict, deliberately: no verdict's answer can be influenced by state left
  // over from another's. Same reason verify-store does it per record.
  try {
    execFileSync(process.execPath, [join(HERE, 'verify-relay-verdict.mjs'), id],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch { return false; }
}

const isMain = process.argv[1] && process.argv[1].endsWith('verify-relay-verdicts.mjs');
if (isMain) {
  const secret = existsSync(SECRET_FILE) ? readFileSync(SECRET_FILE, 'utf8').trim() : null;
  const explicit = process.argv.slice(2).filter(a => !a.startsWith('--'));

  let ids = explicit;
  if (!ids.length) {
    if (!secret) {
      console.error(`Cannot enumerate: no operator secret at ${SECRET_FILE} (set AC_OPERATOR_SECRET_FILE).`);
      console.error('Pass request ids as arguments to verify specific verdicts without a secret.');
      process.exit(2);
    }
    const { status, body } = await getJson('/admission/requests', secret);
    if (status !== 200) {
      // Fail loudly rather than report an empty relay: "nothing to verify" and "could not ask" are
      // different answers, and only one of them is good news.
      console.error(`Could not list requests: HTTP ${status} ${body?.reason ?? ''}`.trim());
      process.exit(2);
    }
    ids = normalizeRows(body);
    if (!ids.length) { console.log('The relay lists no admission requests at all. Nothing to verify.'); process.exit(0); }
  }

  console.log(`--- re-verifying ${ids.length} request(s) on ${RELAY} ---\n`);
  const records = [];
  for (const id of ids) {
    const { status, body } = await getJson(`/admission/verdict?requestId=${encodeURIComponent(id)}`);
    const hasVerdict = status === 200 && typeof body?.sig === 'string' && body.sig.length > 0;
    const verifies = hasVerdict ? verifyOne(id) : false;
    records.push({ id, hasVerdict, verifies, decision: body?.decision ?? null });
    const id8 = id.length > 24 ? `${id.slice(0, 21)}...` : id;
    console.log(`  ${hasVerdict ? (verifies ? 'HELD-UP ' : 'BROKEN  ') : 'undecided'}  ${id8.padEnd(26)}`
      + ` ${hasVerdict ? `decision=${String(body.decision).padEnd(8)}` : `HTTP ${status}${body?.reason ? ` ${body.reason}` : ''}`}`);
  }

  const s = summarize(records);
  console.log();
  console.log(`  ${s.published} verdict(s) published; ${s.verified} of them re-derive from the relay's own bytes.`);
  console.log(`  ${s.undecided.length} request(s) have no published verdict: nothing was decided on them, which is not a failure.`);
  if (s.broken.length) {
    console.log(`\nFAILED: ${s.broken.length} published verdict(s) do NOT re-derive. The relay is holding`
      + ' a decision it cannot stand behind:');
    for (const b of s.broken) console.log(`  ${b.id}  decision=${b.decision}`);
    process.exit(1);
  }
  console.log('\nOK: every verdict the relay has published re-derives from its own bytes in a fresh process.');
}
