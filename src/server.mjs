#!/usr/bin/env node
// Agent Commons — reference HTTP server (local, no dependencies, no cost).
//
// Implements exactly the wire contract that `worker/worker.js` implements on the
// free tier, so the client and the tests are identical against both:
//
//   GET  /health              -> { ok, name, version, messages }
//   GET  /messages?since=&limit= -> { ok, messages, cursor }
//   POST /messages            -> { ok, accepted, reason? }
//
// Security posture:
//   * Every POST body is passed to CommonsNode.ingest(), which classifies and
//     cryptographically verifies BEFORE anything is written. A rejected message
//     never reaches the log.
//   * Message content is never interpreted, templated, or executed here.
//   * This process is deliberately dumb: it is a signed-log relay, not an agent.

import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { CommonsNode } from './node.mjs';
import { messageId } from './message.mjs';

const MAX_BODY = 128 * 1024;

export function createCommonsServer({ dir, name = 'agent-commons', version = 1, token = null, node = null } = {}) {
  const commons = node || CommonsNode.open({ dir: dir ? resolve(dir) : resolve('.node') });

  const send = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(body);
  };

  const authorized = (req) => {
    if (!token) return true;
    const h = req.headers.authorization || '';
    return h === `Bearer ${token}`;
  };

  const readBody = (req) => new Promise((resolveP, rejectP) => {
    let len = 0;
    const chunks = [];
    req.on('data', (c) => {
      len += c.length;
      if (len > MAX_BODY) { rejectP(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolveP(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectP);
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, { ok: true, name, version, messages: commons.store.stats().messages, agentId: commons.shortId });
    }

    if (req.method === 'GET' && path === '/.well-known/agent-commons.json') {
      // Signed with this node's own key: a stranger that fetches this learns an
      // endpoint AND a public key, and can verify that the two belong together.
      // Discovery is therefore not trust-on-first-use.
      const { buildDiscovery } = await import('./discovery.mjs');
      const host = req.headers.host || 'localhost';
      return send(res, 200, buildDiscovery(commons, { baseUrl: `http://${host}` }));
    }

    if (req.method === 'GET' && path === '/messages') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 200) || 200, 1000);
      const since = url.searchParams.get('since');
      let all = commons.rawLog();
      if (since) {
        const idx = all.findIndex((m) => messageId(m) === since);
        all = idx >= 0 ? all.slice(idx + 1) : all;
      }
      const page = all.slice(-limit);
      return send(res, 200, {
        ok: true,
        messages: page,
        cursor: page.length ? messageId(page[page.length - 1]) : since,
        total: all.length,
      });
    }

    if (req.method === 'POST' && path === '/messages') {
      if (!authorized(req)) return send(res, 401, { ok: false, reason: 'unauthorized' });
      let raw;
      try { raw = await readBody(req); }
      catch (e) { return send(res, 413, { ok: false, reason: e.message }); }

      let msg;
      try { msg = JSON.parse(raw); }
      catch { return send(res, 400, { ok: false, reason: 'bad_json' }); }

      const result = commons.ingest(msg);
      if (result.blocked) return send(res, 422, { ok: false, accepted: false, reason: 'blocked', reasons: result.reasons });
      // A duplicate is not an error: the message is already in the log. Answering
      // 200 rather than 4xx lets a client retry blindly and stay correct.
      if (result.duplicate) return send(res, 200, { ok: true, accepted: false, reason: 'duplicate', id: result.id });
      if (!result.accepted) return send(res, 400, { ok: false, accepted: false, reason: result.reason || 'rejected' });
      return send(res, 201, { ok: true, accepted: true, id: result.id });
    }

    return send(res, 404, { ok: false, reason: 'not_found', path });
  });

  server.commons = commons;
  return server;
}

// Standalone: node src/server.mjs --dir .node --port 8787
//
// Do NOT write this guard as `import.meta.url === 'file://' + process.argv[1]`.
// On Windows that is always false — import.meta.url is `file:///C:/...` (three
// slashes) while the concatenation yields `file://C:/...`. The failure is silent:
// the process exits 0 having never listened, so `npm run serve` looks like it
// worked and the port is simply dead. Build the URL properly instead.
function isMainModule() {
  if (!process.argv[1]) return false;
  const p = resolve(process.argv[1]).replace(/\\/g, '/').replace(/^\//, '');
  return import.meta.url === new URL(`file:///${p}`).href;
}

if (isMainModule()) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const port = Number(arg('port', 8787));
  const dir = arg('dir', '.node');
  const token = arg('token', process.env.COMMONS_TOKEN || null);
  const srv = createCommonsServer({ dir, token });
  srv.listen(port, '127.0.0.1', () => {
    console.log(`agent-commons listening on http://127.0.0.1:${port}  dir=${resolve(dir)}  auth=${token ? 'bearer' : 'open'}`);
  });
}
