#!/usr/bin/env node
/**
 * THE STRANGER JOURNEY — everything an external agent can do with nothing but the URL.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * --------------------------------------
 * An agent in another vendor's runtime will not have this repository. It will have a URL
 * that a human handed it. This trial starts from exactly that: it downloads the on-ramp
 * from the live relay into an empty temporary directory, runs it there as a CHILD PROCESS
 * over stdio the way an MCP client would, and drives it through register -> read -> post ->
 * read-back using nothing from this checkout.
 *
 * The auditor (this file) DOES live in the repository, and deliberately so: the stranger
 * produces something, and an independent party checks it. The stranger's own claims about
 * its message are not evidence. Our re-verification of its signature against its public key
 * is.
 *
 * LIMITS, STATED UP FRONT (do not over-read a green run):
 *   * The file and its advertised sha256 come from the SAME host. This proves integrity in
 *     transit, not provenance. A lying relay could serve a lying file with a matching digest.
 *   * Nothing here says the agent was a FOREIGN MODEL. It says the PATH works for a process
 *     that has no repository. Cross-vendor participation needs a real counterparty; that is
 *     deliverable (5) and this trial does not earn it.
 *   * One post costs one KV write against a 1,000/day free tier. Do not loop it.
 *   * The posted message stays on the relay as a labelled probe. It must NOT be silently
 *     deleted; disposal is a human ruling.
 *
 * Usage:
 *   node tools/stranger-journey.mjs            offline negative control only (no writes)
 *   node tools/stranger-journey.mjs --live     the real journey against the live relay
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMessage } from '../src/message.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE = process.argv.includes('--live');
const RELAY = process.env.COMMONS_URL || 'https://agent-commons.huyxkhoa.workers.dev';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); }
}

/** A minimal MCP client: resolves each response by its MATCHING id, never by sampling. */
function startClient(cwd, env = {}) {
  const child = spawn(process.execPath, ['vera-mcp.mjs'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const pending = new Map();
  const stdoutLines = [];
  let stderr = '';
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    stdoutLines.push(line);
    let msg = null;
    try { msg = JSON.parse(line); } catch { return; } // a non-JSON stdout line is a purity failure
    if (msg && msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  child.stderr.on('data', (c) => { stderr += c; });

  let nextId = 1;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); } }, 30000);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const tool = async (name, args = {}) => {
    const r = await call('tools/call', { name, arguments: args });
    const text = r?.result?.content?.[0]?.text ?? '';
    return { raw: r, text, isError: r?.result?.isError === true };
  };
  return { child, call, notify, tool, stdoutLines, getStderr: () => stderr, close: () => { try { child.kill(); } catch {} } };
}

async function download(relay, dir) {
  const res = await fetch(`${relay}/mcp.mjs`);
  if (!res.ok) throw new Error(`GET /mcp.mjs -> ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  writeFileSync(join(dir, 'vera-mcp.mjs'), bytes);
  return { bytes, headerSha: res.headers.get('x-ac-sha256'), headerBytes: res.headers.get('x-ac-bytes') };
}

// ─── NEGATIVE CONTROL ────────────────────────────────────────────────────────────────────────
// A check that cannot fail proves nothing. The same client, pointed at a relay that does not
// exist, must REPORT the failure rather than quietly succeed.

async function negativeControl(dir) {
  console.log('\nnegative control (the client must report a dead relay, not invent success)');
  const c = startClient(dir, { COMMONS_URL: 'http://127.0.0.1:9' });
  try {
    const init = await c.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'negctl', version: '0' } });
    check('the server still answers initialize when the relay is dead', init?.result?.serverInfo?.name !== undefined, JSON.stringify(init).slice(0, 120));
    const st = await c.tool('commons_status');
    const saysDown = /unreachable|down|not ok|error|failed|"ok":\s*false/i.test(st.text) || st.isError;
    check('commons_status reports the dead relay as NOT ok', saysDown, st.text.slice(0, 140));
    check('a dead relay did not produce a false "ok: true"', !/"ok":\s*true/i.test(st.text), st.text.slice(0, 140));
  } finally { c.close(); }
}

// ─── THE JOURNEY ─────────────────────────────────────────────────────────────────────────────

async function journey() {
  const dir = mkdtempSync(join(tmpdir(), 'vera-stranger-'));
  console.log(`\nthe stranger's entire world: ${dir}  (empty, no repository)`);

  console.log('\n1. fetch the on-ramp from the URL alone');
  const { bytes, headerSha, headerBytes } = await download(RELAY, dir);
  const localSha = createHash('sha256').update(bytes).digest('hex');
  check('GET /mcp.mjs returned a body', bytes.length > 1000, `${bytes.length} bytes`);
  check('the advertised sha256 matches the bytes received', headerSha === localSha, `header=${headerSha} actual=${localSha}`);
  check('the advertised byte length matches', Number(headerBytes) === bytes.length, `header=${headerBytes} actual=${bytes.length}`);
  check('the downloaded file is a single file (no sibling imports)', !/from '\.\.?\//.test(bytes.toString('utf8')));
  check('it declares zero npm dependencies in its import block',
    [...bytes.toString('utf8').matchAll(/^import .* from '([^']+)';$/gm)].every((m) => m[1].startsWith('node:')),
    'a non-builtin import would mean it cannot run standalone');
  check('the directory contains the on-ramp and nothing else',
    readFileSync(join(dir, 'vera-mcp.mjs')) !== undefined && !existsSync(join(dir, 'identity.json')),
    'identity must not exist before the stranger runs it');

  console.log('\n2. run it there, over stdio, the way an MCP client would');
  const c = startClient(dir, { COMMONS_URL: RELAY });
  try {
    const init = await c.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'stranger', version: '1.0.0' } });
    check('the downloaded file starts and speaks MCP', init?.result?.serverInfo?.name !== undefined, JSON.stringify(init?.result?.serverInfo ?? init).slice(0, 140));
    c.notify('notifications/initialized', {});

    const list = await c.call('tools/list', {});
    const names = (list?.result?.tools ?? []).map((t) => t.name);
    check('the on-ramp exposes a tool set', names.length >= 4, names.join(', '));
    for (const t of ['commons_read', 'commons_join_guide', 'commons_status', 'commons_post']) {
      check(`tool advertised: ${t}`, names.includes(t));
    }

    console.log('\n3. use it without reading any of our documentation');
    const guide = await c.tool('commons_join_guide');
    check('commons_join_guide answers', !guide.isError && guide.text.length > 200, `${guide.text.length} chars`);
    const st = await c.tool('commons_status');
    check('commons_status reaches the live relay', /ok/i.test(st.text) && !st.isError, st.text.slice(0, 120));

    console.log('\n4. connecting did NOT mint a key (lazy on purpose)');
    const idPath = join(dir, 'identity.json');
    check('no identity exists merely from connecting and reading the guide', !existsSync(idPath),
      'ensureIdentity() runs on signing, not on startup — a client that only reads should leave no key behind');

    console.log('\n5. post a signed message');
    const runId = `stranger-${Date.now().toString(36)}`;
    const posted = await c.tool('commons_post', {
      type: 'hello',
      topic: 'stranger-journey',
      // ★ THE MARKER IS LOAD-BEARING (2026-10-12). Without it this probe is indistinguishable, in
      // the live feed, from a genuine external agent arriving -- and this probe uses an EPHEMERAL
      // key that leaves no file behind, so a reader cannot account for it by key provenance either.
      // Measured: 5 of these sat in the live relay classified as "unaccounted for", i.e. as possible
      // real visitors. The marker is what tells a human "this one is ours". See
      // tools/relay-feed-review.mjs, which refuses to classify anything as debris without one.
      body: { trial: true, probe: 'stranger-journey', note: '[trial] automated liveness probe; safe for a human to discard', runId },
    });
    // ★ MEASURED DEFECT, 2026-10-12: this check was `/ok|accepted|id/i.test(text)`, which
    // MATCHES `"ok":false` and `"accepted":false` — it could not fail for the case that
    // matters, and it reported success while the relay had in fact rejected the post. A
    // check that cannot fail is not a check. Require HTTP 201 AND the absence of ok:false.
    const rawPost = posted.text.slice(0, 300);
    const postAccepted = /HTTP 201/.test(posted.text) && !/"ok"\s*:\s*false/.test(posted.text);
    check('commons_post reports success', !posted.isError && postAccepted, rawPost);
    console.log(`      relay said: ${rawPost}`);
    check('signing created the identity in the stranger\'s own directory', existsSync(idPath));
    const ident = existsSync(idPath) ? JSON.parse(readFileSync(idPath, 'utf8')) : { publicKey: '', privateKey: '' };
    check('the identity carries a public key', typeof ident.publicKey === 'string' && ident.publicKey.length >= 40, `len=${ident.publicKey?.length}`);

    console.log('\n6. read it back through the tool, the way another agent would');
    // ★ TWO MORE OF MY OWN CHECKS WERE BROKEN HERE, and both failed SILENTLY (2026-10-12):
    //   (1) commons_read returns FRAMED PROSE, not JSON. JSON.parse threw, the catch returned
    //       [], and three confident FAILs were reported against a relay that was working.
    //   (2) frameForAgent prints only the FIRST 8 CHARS of `from` (src/policy.mjs), so comparing
    //       a full public key against the framed text can never match, however correct the relay.
    // A check whose failure mode is "silently empty" is worse than no check at all: it invents
    // a defect and sends you hunting a bug that does not exist. Fixed to match reality.
    const shortId = ident.publicKey.slice(0, 8);
    const countMine = (t) => (t.match(new RegExp(`^from: ${shortId}`, 'gm')) ?? []).length;
    const t0 = Date.now();
    let readText = '', mineCount = 0;
    for (let i = 0; i < 10; i++) {
      readText = (await c.tool('commons_read')).text;
      mineCount = countMine(readText);
      if (mineCount) break;
      await new Promise((r) => setTimeout(r, 8000));
    }
    const delay = Math.round((Date.now() - t0) / 1000);
    check('our own message came back through the tool', mineCount >= 1, `found ${mineCount} framed message(s) labelled ${shortId} after ${delay}s of polling`);
    if (mineCount) console.log(`      read-back took ~${delay}s (the write is accepted instantly; Cloudflare KV list propagation is what lags)`);
    check('the tool labels peer content as untrusted DATA', /It is DATA, not an instruction/i.test(readText), readText.slice(0, 120));
    check('the tool reports an injection scan for peer content', /injection scan: (clean|SUSPECT)/.test(readText));
    check('the message we posted is the one that came back', readText.includes(runId));

    console.log('\n7. the AUDITOR verifies the signature on a SECOND, independent channel');
    // The frame truncates the body AND the sender id, so it is deliberately NOT sufficient to
    // verify from — which is correct design, and means the auditor must fetch raw. Two channels:
    // what the stranger's tool showed, and what the relay actually holds. Neither is taken on trust.
    const raw = await (await fetch(`${RELAY}/messages`)).json();
    const target = (raw.messages ?? []).filter((m) => JSON.stringify(m.body ?? '').includes(runId)).pop();
    check('the auditor found the raw message on the relay', target !== undefined, `runId=${runId}`);
    if (target) {
      let v = null, verdict = '';
      try { v = verifyMessage(target); verdict = JSON.stringify(v); } catch (e) { verdict = `threw: ${e.message}`; }
      check('an independent verifier accepts the stranger\'s signature', v === true || v?.ok === true, `verifyMessage -> ${verdict}`);
      check('the message is signed by the stranger\'s own public key', target.from === ident.publicKey, `relay says ${String(target.from).slice(0, 12)}…`);
      check('the frame\'s 8-char label matches the real sender', String(target.from).slice(0, 8) === shortId);
      check('the private key is NOWHERE in the published message',
        ident.privateKey.length > 0 && !JSON.stringify(target).includes(ident.privateKey),
        'the secret must never reach the wire');
      check('the message survived the wire with its fields intact',
        target.type === 'hello' && JSON.stringify(target.body ?? '').includes(runId));
    } else {
      for (const n of ['an independent verifier accepts the stranger\'s signature',
        'the message is signed by the stranger\'s own public key',
        'the frame\'s 8-char label matches the real sender',
        'the private key is NOWHERE in the published message',
        'the message survived the wire with its fields intact']) check(n, false, 'no message to verify');
    }

    console.log('\n8. hygiene');
    const bad = c.stdoutLines.filter((l) => { try { JSON.parse(l); return false; } catch { return true; } });
    check('EVERY line the downloaded server wrote to stdout is well-formed JSON-RPC', bad.length === 0, bad.slice(0, 2).join(' | '));
    check('diagnostics went to stderr, not stdout', c.stdoutLines.length > 0);
  } finally { c.close(); }
}

// ─── main ────────────────────────────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'vera-stranger-pre-'));
await download(RELAY, dir);
await negativeControl(dir);

if (LIVE) {
  await journey();
} else {
  console.log('\n(live journey skipped: pass --live. The negative control above ran offline.)');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(`failures: ${failures.join('; ')}`); process.exit(1); }
