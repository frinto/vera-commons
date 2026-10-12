/**
 * Is our server.json VALID against the published schema, and does the URL it advertises actually
 * speak MCP?
 *
 * WHY BOTH HALVES. A descriptor is a promise made to a machine that will never read our README. Two
 * independent things can be wrong with it, and each is invisible from the other side:
 *
 *   1. The FILE can violate the schema. The official constraints are not guessable -- `description`
 *      is capped at 100 characters, `name` must be reverse-DNS with EXACTLY one slash, the website
 *      field is `website_url` while the Go-era docs say `websiteUrl`, and the transport type is the
 *      literal enum `streamable-http`. A file that violates any of these is rejected by a registry
 *      crawler silently, which looks exactly like not having submitted anything at all.
 *   2. The URL can be a LIE. A perfectly schema-valid descriptor pointing at a dead or non-MCP
 *      endpoint is worse than none: it converts a curious arrival into a failed one, and the arrival
 *      is the scarce resource here.
 *
 * So this checks the file against the LIVE published schema (fetched, not vendored, so schema drift
 * surfaces as a failure rather than as silent invalidity) and then performs a real MCP handshake
 * against the exact URL the file advertises.
 *
 * Zero dependencies: the constraint extraction and validation are hand-written for the subset the
 * schema actually declares for our shape. `--self-test` proves the validator can reject.
 *
 * Usage:
 *   node tools/mcp-registry-check.mjs             schema + live handshake
 *   node tools/mcp-registry-check.mjs --file-only skip the network handshake (offline)
 *   node tools/mcp-registry-check.mjs --self-test prove the validator REJECTS bad input
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCHEMA_URL = 'https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json';

let failures = 0;
const ok = (m) => console.log('  PASS ' + m);
const bad = (m) => { failures++; console.log('  FAIL ' + m); };

/** Pull the constraints that apply to our shape out of the live schema, without a JSON-Schema engine. */
export function constraintsFrom(schema) {
  const d = schema.definitions || {};
  const detail = d.ServerDetail || {};
  const fromAllOf = (detail.allOf || []).find((p) => p.properties) || {};
  const props = { ...(d.Server?.properties || {}), ...(fromAllOf.properties || {}) };
  return {
    required: d.Server?.required || [],
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
  for (const key of c.required) {
    if (doc[key] === undefined) out.push(`missing required field \`${key}\``);
  }
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

  if (doc.website_url !== undefined) {
    if (typeof doc.website_url !== 'string' || !isUri(doc.website_url)) out.push('`website_url` must be an absolute URI');
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

/** The descriptor's central promise: this URL speaks MCP. Ask it, over the wire, right now. */
export async function handshake(url) {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-registry-check', version: '1.0.0' } },
  });
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  if (res.status !== 200) return { ok: false, why: `HTTP ${res.status}` };
  let j;
  try { j = await res.json(); } catch { return { ok: false, why: 'the response was not JSON' }; }
  const info = j?.result?.serverInfo;
  if (!info?.name) return { ok: false, why: 'no result.serverInfo.name -- this does not look like an MCP server' };
  return { ok: true, name: info.name, version: info.version, protocol: j.result.protocolVersion };
}

const FIXTURES = [
  ['a valid document', {}, []],
  ['a missing required field', { delete: 'version' }, ['missing required field']],
  ['a name with no namespace', { set: { name: 'vera-commons' } }, ['EXACTLY one forward slash']],
  ['a name with two slashes', { set: { name: 'io/github/vera' } }, ['EXACTLY one forward slash']],
  ['a name with an illegal character', { set: { name: 'io.github!frinto/vera' } }, ['does not match']],
  ['an over-long description', { set: { description: 'x'.repeat(101) } }, ['over the 100 limit']],
  ['a wrong transport enum', { set: { remotes: [{ type: 'http', url: 'https://example.com/mcp' }] } }, ['is not one of']],
  ['a relative remote url', { set: { remotes: [{ type: 'streamable-http', url: '/mcp' }] } }, ['absolute URI']],
  ['a repository without a source', { set: { repository: { url: 'https://example.com' } } }, ['repository.source']],
];

function selfTest(doc, c) {
  console.log('--- does the validator actually REJECT bad input? ---');
  let wrong = 0;
  for (const [label, mutate, expect] of FIXTURES) {
    const copy = JSON.parse(JSON.stringify(doc));
    if (mutate.delete) delete copy[mutate.delete];
    if (mutate.set) Object.assign(copy, mutate.set);
    const found = validate(copy, c);
    if (expect.length === 0) {
      if (found.length === 0) ok(`${label}: accepted, as it should be`);
      else { wrong++; bad(`${label}: rejected a DOCUMENT THAT SHOULD PASS -> ${found.join('; ')}`); }
      continue;
    }
    const hit = expect.every((e) => found.some((f) => f.includes(e)));
    if (hit) ok(`${label}: rejected (${found.length} violation(s), matched "${expect[0]}")`);
    else { wrong++; bad(`${label}: NOT rejected as expected, got: ${found.join('; ') || '(nothing)'}`); }
  }
  console.log('');
  console.log(wrong ? `${wrong} self-test case(s) did not discriminate.` : 'The validator discriminates: it accepts the good document and rejects every bad one.');
  return wrong;
}

async function main() {
  const argv = process.argv.slice(2);
  const fileOnly = argv.includes('--file-only');
  const selfTestOnly = argv.includes('--self-test');
  const doc = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8'));

  console.log('--- server.json against the LIVE published schema ---');
  console.log('  schema: ' + SCHEMA_URL);
  let schema;
  try {
    const r = await fetch(SCHEMA_URL);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    schema = await r.json();
    ok(`fetched the published schema (${Object.keys(schema.definitions || {}).length} definitions)`);
  } catch (e) {
    bad('could not fetch the schema: ' + e.message);
    console.log('');
    console.log(failures + ' check(s) FAILED.');
    process.exit(1);
  }

  const c = constraintsFrom(schema);
  ok(`extracted constraints: required=[${c.required.join(', ')}] transport enum=${JSON.stringify(c.transportTypeEnum)}`);

  const violations = validate(doc, c);
  if (violations.length === 0) ok('server.json satisfies every constraint the schema declares for our shape');
  else for (const v of violations) bad(v);

  const n = c.props.name?.maxLength;
  if (n && doc.description.length <= (c.props.description.maxLength ?? Infinity)) {
    ok(`description is ${doc.description.length} chars (limit ${c.props.description.maxLength}) and the name is ${doc.name.length} (limit ${n})`);
  }

  if (selfTestOnly) { const w = selfTest(doc, c); process.exit(violations.length || w ? 1 : 0); }

  const url = doc.remotes?.[0]?.url;
  if (!fileOnly && url) {
    console.log('');
    console.log('--- the promise: does the advertised URL actually speak MCP? ---');
    console.log('  url: ' + url);
    try {
      const h = await handshake(url);
      if (h.ok) ok(`live handshake succeeded: serverInfo.name=${h.name} version=${h.version} protocol=${h.protocol}`);
      else bad('live handshake failed: ' + h.why);
    } catch (e) { bad('could not reach the advertised URL: ' + e.message); }
  }

  console.log('');
  if (failures) { console.log(failures + ' check(s) FAILED.'); process.exit(1); }
  console.log(fileOnly
    ? 'server.json is schema-valid. The URL was NOT contacted (--file-only), so nothing here says it is live.'
    : 'server.json is schema-valid AND the URL it advertises answered a live MCP handshake.');
}

if (process.argv[1] && process.argv[1].endsWith('mcp-registry-check.mjs')) await main();
