/**
 * Is our server.json VALID, and does the URL it advertises actually speak MCP?
 *
 * WHAT WENT WRONG THE FIRST TIME (kept here because it is the whole reason this file looks like this):
 * v1 of this tool validated server.json against the published schema FILE and reported PASS. The
 * official registry then rejected the very same document with HTTP 422 -- `unexpected property
 * body.website_url`. The schema file at 2025-07-09 declares `website_url`; the live registry runs
 * 2025-12-11 and wants `websiteUrl`. So the tool was green on a document the actual consumer refuses.
 *
 * THE LESSON, which is general: A SCHEMA FILE IS NOT THE CONSUMER. Validating against a spec you
 * fetched is still validating against a copy of someone's intent, and copies drift. The only check
 * that cannot drift out of sync with the registry is the registry's own validator, so that is now the
 * authoritative arm here and the schema file is demoted to a secondary structural check.
 *
 * There is a second trap this file now avoids: when the local schema check cannot interpret a schema
 * version, it must say so. An uninterpretable schema yields an empty constraint set, every document
 * trivially satisfies an empty constraint set, and the tool would print PASS while checking NOTHING.
 * A green result from a check that cannot fail is not evidence, it is decoration.
 *
 * Three arms, in order of authority:
 *   1. AUTHORITATIVE -- the live registry's own POST /v0.1/validate.
 *   2. STRUCTURAL    -- the schema file named by the document itself, for readable diagnostics.
 *   3. THE PROMISE   -- a real MCP handshake against the URL the descriptor advertises. A
 *                       schema-perfect file pointing at a dead endpoint is worse than none: it turns
 *                       a curious arrival into a failed one, and the arrival is the scarce resource.
 *
 * Zero dependencies. Usage:
 *   node tools/mcp-registry-check.mjs              all three arms
 *   node tools/mcp-registry-check.mjs --file-only  skip BOTH network arms (offline)
 *   node tools/mcp-registry-check.mjs --self-test  prove every arm can REJECT
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REGISTRY = 'https://registry.modelcontextprotocol.io/v0.1';

let failures = 0;
const ok = (m) => console.log('  PASS ' + m);
const bad = (m) => { failures++; console.log('  FAIL ' + m); };

/* ---------------------------------------------------------------- arm 2: structural */

/** Pull the constraints that apply to our shape out of a schema document. `props` empty => not understood. */
export function constraintsFrom(schema) {
  const d = schema.definitions || {};
  const detail = d.ServerDetail || {};
  const fromAllOf = (detail.allOf || []).find((p) => p && p.properties) || {};
  const props = { ...(d.Server?.properties || {}), ...(detail.properties || {}), ...(fromAllOf.properties || {}) };
  return {
    understood: Object.keys(props).length > 0,
    // Schema generations differ on where `required` lives: 2025-07-09 puts it on a separate Server
    // definition, 2025-12-11 puts it directly on ServerDetail. Reading only one of them silently
    // yields an empty required list, and an empty required list accepts EVERYTHING -- the exact
    // cannot-fail trap this file exists to avoid.
    required: d.Server?.required || detail.required || [],
    props,
    transportTypeEnum: d.StreamableHttpTransport?.properties?.type?.enum || [],
    remoteRequired: d.StreamableHttpTransport?.required || [],
    repositoryRequired: d.Repository?.required || [],
  };
}

const isUri = (v) => { try { new URL(v); return true; } catch { return false; } };

/** @returns {string[]} every violation, so one run reports all of them rather than the first. */
export function validate(doc, c) {
  const out = [];
  for (const key of c.required) if (doc[key] === undefined) out.push(`missing required field \`${key}\``);
  const rule = (name) => c.props[name] || {};

  if (doc.name !== undefined) {
    const r = rule('name');
    if (typeof doc.name !== 'string') out.push('`name` must be a string');
    else {
      if (r.pattern && !new RegExp(r.pattern).test(doc.name)) out.push(`\`name\` ${JSON.stringify(doc.name)} does not match ${r.pattern}`);
      if (doc.name.split('/').length !== 2) out.push('`name` must contain EXACTLY one forward slash (namespace/server)');
      if (r.minLength && doc.name.length < r.minLength) out.push(`\`name\` shorter than ${r.minLength}`);
      if (r.maxLength && doc.name.length > r.maxLength) out.push(`\`name\` longer than ${r.maxLength}`);
    }
  }
  if (doc.description !== undefined) {
    const r = rule('description');
    if (typeof doc.description !== 'string') out.push('`description` must be a string');
    else {
      if (r.minLength && doc.description.length < r.minLength) out.push('`description` is empty');
      if (r.maxLength && doc.description.length > r.maxLength) out.push(`\`description\` is ${doc.description.length} chars, over the ${r.maxLength} limit`);
    }
  }
  if (doc.version !== undefined) {
    const r = rule('version');
    if (typeof doc.version !== 'string') out.push('`version` must be a string');
    else if (r.maxLength && doc.version.length > r.maxLength) out.push(`\`version\` longer than ${r.maxLength}`);
  }
  // Deliberately checks BOTH spellings: the point is that they are not interchangeable, and only the
  // live registry can say which one this schema version wants.
  for (const k of ['website_url', 'websiteUrl']) {
    if (doc[k] !== undefined && !isUri(doc[k])) out.push(`\`${k}\` must be an absolute URI`);
  }
  if (doc.repository !== undefined) {
    for (const key of c.repositoryRequired) if (doc.repository?.[key] === undefined) out.push(`\`repository.${key}\` is required`);
    if (doc.repository?.url !== undefined && !isUri(doc.repository.url)) out.push('`repository.url` must be an absolute URI');
  }
  if (doc.remotes !== undefined) {
    if (!Array.isArray(doc.remotes) || doc.remotes.length === 0) out.push('`remotes` must be a non-empty array');
    else doc.remotes.forEach((r, i) => {
      for (const key of c.remoteRequired) if (r[key] === undefined) out.push(`\`remotes[${i}].${key}\` is required`);
      if (c.transportTypeEnum.length && !c.transportTypeEnum.includes(r.type)) {
        out.push(`\`remotes[${i}].type\` ${JSON.stringify(r.type)} is not one of ${JSON.stringify(c.transportTypeEnum)}`);
      }
      if (!isUri(String(r.url))) out.push(`\`remotes[${i}].url\` must be an absolute URI`);
    });
  }
  return out;
}

/* ---------------------------------------------------------------- arms 1 and 3: the network */

/** THE authoritative arm: the registry's own validator, which cannot drift from the registry. */
export async function validateAgainstLiveRegistry(doc) {
  try {
    const res = await fetch(REGISTRY + '/validate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc),
    });
    const body = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* reported below */ }
    if (res.status === 200 && parsed?.valid === true) return { ok: true, status: res.status };
    const why = (parsed?.errors || []).map((e) => (e.location ? e.location + ': ' : '') + e.message).join('; ');
    return { ok: false, status: res.status, why: why || body.slice(0, 300) };
  } catch (e) { return { ok: false, status: 0, why: 'could not reach the registry: ' + e.message }; }
}

/** The descriptor's central promise: this URL speaks MCP. Ask it, over the wire, right now. */
export async function handshake(url) {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-registry-check', version: '1.1.0' } },
  });
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  if (res.status !== 200) return { ok: false, why: `HTTP ${res.status}` };
  let j; try { j = await res.json(); } catch { return { ok: false, why: 'the response was not JSON' }; }
  const info = j?.result?.serverInfo;
  if (!info?.name) return { ok: false, why: 'no result.serverInfo.name -- this does not look like an MCP server' };
  return { ok: true, name: info.name, version: info.version, protocol: j.result.protocolVersion };
}

/* ---------------------------------------------------------------- self-test */

const LOCAL_FIXTURES = [
  ['a valid document', {}, []],
  ['a missing required field', { delete: 'version' }, ['missing required field']],
  ['a name with no namespace', { set: { name: 'vera-commons' } }, ['EXACTLY one forward slash']],
  ['an over-long description', { set: { description: 'x'.repeat(101) } }, ['over the 100 limit']],
  ['a wrong transport enum', { set: { remotes: [{ type: 'http', url: 'https://example.com/mcp' }] } }, ['is not one of']],
  ['a relative remote url', { set: { remotes: [{ type: 'streamable-http', url: '/mcp' }] } }, ['absolute URI']],
  ['a repository without a source', { set: { repository: { url: 'https://example.com' } } }, ['repository.source']],
];

function applyMutation(doc, mutate) {
  const copy = JSON.parse(JSON.stringify(doc));
  if (mutate.delete) delete copy[mutate.delete];
  if (mutate.set) Object.assign(copy, mutate.set);
  return copy;
}

async function selfTest(doc, c) {
  let wrong = 0;
  console.log('--- arm 2 (structural): can it reject? ---');
  if (!c.understood) {
    bad('the schema was not understood, so this arm proves nothing -- not counting it as a pass');
    wrong++;
  } else for (const [label, mutate, expect] of LOCAL_FIXTURES) {
    const found = validate(applyMutation(doc, mutate), c);
    if (expect.length === 0) {
      if (found.length === 0) ok(`${label}: accepted, as it should be`);
      else { wrong++; bad(`${label}: rejected a document that SHOULD pass -> ${found.join('; ')}`); }
      continue;
    }
    if (expect.every((e) => found.some((f) => f.includes(e)))) ok(`${label}: rejected`);
    else { wrong++; bad(`${label}: NOT rejected, got: ${found.join('; ') || '(nothing)'}`); }
  }

  console.log('');
  console.log('--- arm 1 (live registry): can IT reject? the only arm that matters ---');
  const good = await validateAgainstLiveRegistry(doc);
  if (good.ok) ok('the live registry ACCEPTS our shipped server.json');
  else { wrong++; bad('the live registry REJECTS our shipped server.json: ' + good.why); }

  // The negative control that would have caught the original defect: a wrong field SPELLING. The
  // structural arm cannot see it (both spellings are plausible URIs); only the registry can.
  const misspelled = applyMutation(doc, { delete: 'websiteUrl', set: { website_url: doc.websiteUrl || 'https://example.com' } });
  const neg = await validateAgainstLiveRegistry(misspelled);
  if (!neg.ok) ok(`and it REJECTS a mis-spelled field: the live arm can fail (${neg.why.slice(0, 70)})`);
  else { wrong++; bad('the live arm ACCEPTED a document with website_url instead of websiteUrl -- it cannot discriminate'); }

  const noVersion = await validateAgainstLiveRegistry(applyMutation(doc, { delete: 'version' }));
  if (!noVersion.ok) ok('and it REJECTS a document with no version');
  else { wrong++; bad('the live arm accepted a document with no version'); }

  return wrong;
}

/* ---------------------------------------------------------------- main */

async function main() {
  const argv = process.argv.slice(2);
  const fileOnly = argv.includes('--file-only');
  const selfTestOnly = argv.includes('--self-test');
  const doc = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8'));

  let schema = null;
  try {
    const sUrl = doc.$schema;
    const r = await fetch(sUrl);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    schema = await r.json();
  } catch (e) {
    console.log('--- arm 2 (structural) ---');
    bad('could not fetch the schema named by the document: ' + e.message);
  }

  const c = schema ? constraintsFrom(schema) : { understood: false, required: [], props: {}, transportTypeEnum: [], remoteRequired: [], repositoryRequired: [] };

  if (selfTestOnly) {
    const w = await selfTest(doc, c);
    console.log('');
    console.log(w ? `${w} self-test case(s) did not discriminate.` : 'Every arm discriminates.');
    process.exit(failures || w ? 1 : 0);
  }

  console.log('--- arm 1 (AUTHORITATIVE): the live registry validates our document ---');
  console.log('  endpoint: ' + REGISTRY + '/validate');
  if (fileOnly) {
    console.log('  SKIPPED (--file-only) -- nothing in this run says the registry accepts the file.');
  } else {
    const live = await validateAgainstLiveRegistry(doc);
    if (live.ok) ok('the live registry accepts server.json (HTTP 200, valid:true)');
    else bad(`the live registry REJECTED server.json (HTTP ${live.status}): ${live.why}`);
  }

  console.log('');
  console.log('--- arm 2 (structural, secondary): the schema file named by the document ---');
  console.log('  schema: ' + doc.$schema);
  if (!c.understood) {
    bad('this schema version was not understood -- the structural arm checked NOTHING, and reports that rather than a pass');
  } else {
    const violations = validate(doc, c);
    if (violations.length === 0) ok('no structural violations');
    else for (const v of violations) bad(v);
    const dmax = c.props.description?.maxLength;
    if (dmax) ok(`description is ${doc.description.length} chars (limit ${dmax})`);
  }

  const url = doc.remotes?.[0]?.url;
  console.log('');
  console.log('--- arm 3 (the promise): does the advertised URL speak MCP? ---');
  console.log('  url: ' + url);
  if (fileOnly || !url) {
    console.log('  SKIPPED -- nothing in this run says the URL is live.');
  } else {
    try {
      const h = await handshake(url);
      if (h.ok) ok(`live handshake succeeded: serverInfo.name=${h.name} version=${h.version} protocol=${h.protocol}`);
      else bad('live handshake failed: ' + h.why);
    } catch (e) { bad('could not reach the advertised URL: ' + e.message); }
  }

  console.log('');
  if (failures) { console.log(failures + ' check(s) FAILED.'); process.exit(1); }
  console.log(fileOnly
    ? 'Structural result only: BOTH network arms were skipped, so this says nothing about the registry or the endpoint.'
    : 'Validated by the live registry AND the advertised URL answered a live MCP handshake.');
}

if (process.argv[1] && process.argv[1].endsWith('mcp-registry-check.mjs')) await main();
