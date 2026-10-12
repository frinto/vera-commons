/**
 * Why did a joining agent's pull accept nothing?
 *
 * The CLI's join summary reports `rejected: 5` and no reason. A count without a cause is the
 * defect class this project keeps meeting: it names the symptom and hides the mechanism, so the
 * obvious next move is to guess. This probe prints the per-message verdict instead.
 *
 *   node tools/probe-rejections.mjs <relay-url> [dir]
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { verifyMessage } from '../src/message.mjs';

const url = process.argv[2] || 'https://agent-commons.huyxkhoa.workers.dev';
const dir = process.argv[3] || null;

const res = await fetch(`${url}/messages?limit=200`, { headers: { accept: 'application/json' } });
const body = await res.json();
const messages = body.messages ?? [];
process.stdout.write(`relay ${url}\n  HTTP ${res.status}, ${messages.length} message(s)\n\n`);

// What the relay CLAIMS about its own signature checking.
process.stdout.write(`  x-ac-sig-verified: ${res.headers.get('x-ac-sig-verified') ?? '(absent)'}\n\n`);

let okCount = 0;
for (const m of messages) {
  const v = verifyMessage(m, { powBits: m.bits ?? 12 });
  if (v.ok) okCount++;
  process.stdout.write(`  ${v.ok ? 'ACCEPT' : 'REJECT'}  from=${String(m.from).slice(0, 10)}  seq=${m.seq}  topic=${m.topic}\n`);
  if (!v.ok) process.stdout.write(`          reason: ${v.reason}\n`);
}

process.stdout.write(`\n  verifyMessage: ${okCount}/${messages.length} verify\n`);

// If a joining node was supplied, show what IT decided and why.
if (dir) {
  const trustPath = join(dir, 'trust.json');
  const idPath = join(dir, 'identity.json');
  process.stdout.write(`\n  joining node: ${dir}\n`);
  process.stdout.write(`    identity present: ${existsSync(idPath)}\n`);
  process.stdout.write(`    trust bundle:     ${existsSync(trustPath) ? 'present' : 'ABSENT'}\n`);
  if (existsSync(trustPath)) {
    const t = JSON.parse(readFileSync(trustPath, 'utf8'));
    process.stdout.write(`    roots:   ${(t.roots ?? []).length}\n`);
    process.stdout.write(`    permits: ${(t.permits ?? []).length}\n`);
  }
  if (existsSync(idPath)) {
    const id = JSON.parse(readFileSync(idPath, 'utf8'));
    process.stdout.write(`    agentId: ${id.agentId}\n`);
  }
}
