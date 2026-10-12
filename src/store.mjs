// Agent Commons — append-only, tamper-evident log.
//
// The log is newline-delimited JSON. One line per message, appended with a single
// write, never rewritten. That makes it crash-safe, diffable, greppable, and
// portable enough to outlive this project.
//
// What this module guarantees:
//   * nothing enters the log unless it verifies cryptographically first
//   * a torn write (a crash mid-append) loses at most the final partial line
//   * a re-used sequence number, a duplicated message, or a bad signature is
//     detectable after the fact by verifyChain()
//
// What it does NOT do: interpret, execute, or act on message content.

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { verifyMessage, messageId } from './message.mjs';

export class AppendOnlyStore {
  constructor(dir) {
    if (!dir) throw new Error('AppendOnlyStore requires a directory');
    this.dir = dir;
    this.path = join(dir, 'log.jsonl');
    mkdirSync(dir, { recursive: true });
    if (!existsSync(this.path)) writeFileSync(this.path, '');
  }

  /**
   * Parse the log, tolerating exactly one failure mode: a torn tail.
   * A partial final line is dropped and reported. A corrupt line anywhere else
   * is NOT dropped silently — it is reported in `badLines` so verifyChain() fails.
   */
  readAllWithMeta() {
    const text = readFileSync(this.path, 'utf8');
    if (text.length === 0) return { messages: [], tornTail: false, badLines: [], lineCount: 0 };

    const endsWithNewline = text.endsWith('\n');
    const rawLines = text.split('\n');
    if (endsWithNewline) rawLines.pop(); // trailing '' after the last \n

    const messages = [];
    const badLines = [];
    let tornTail = false;

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      if (line.trim() === '') continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        // An unparseable line is only "torn" if it is the very last one AND the
        // file did not end in a newline. Anything else is real corruption.
        if (i === rawLines.length - 1 && !endsWithNewline) tornTail = true;
        else badLines.push({ index: i, preview: line.slice(0, 80) });
      }
    }

    return { messages, tornTail, badLines, lineCount: rawLines.length };
  }

  readAll() { return this.readAllWithMeta().messages; }

  /**
   * Verify, then append. A message that fails verification is never written.
   *
   * AUTHENTICITY IS ALWAYS CHECKED. FRESHNESS IS NOT — and getting that backwards cost the
   * same bug twice. A log is an archive, and an archive must never expire (spec §3d).
   * Freshness is a defence against replay INTO live traffic, so it belongs to the caller who
   * knows which situation it is in: node.ingest() enforces it by default (live gossip),
   * node.pull() does not (fetching a published archive).
   *
   * Enforcing it here unconditionally meant that fetching a relay's history rejected every
   * message older than five minutes — so the console showed an empty inbox forever.
   */
  append(msg, { enforceFreshness = false } = {}) {
    const check = verifyMessage(msg, { enforceFreshness });
    if (!check.ok) return { ok: false, reason: check.reason };

    const id = messageId(msg);
    const line = JSON.stringify(msg);
    appendFileSync(this.path, line + '\n'); // single atomic append; no read-modify-write
    return { ok: true, id, line };
  }

  /**
   * Re-verify the whole log. Detects: signature failures, per-sender sequence
   * regressions, duplicate messages, and corrupt lines.
   */
  verifyChain() {
    const { messages, tornTail, badLines } = this.readAllWithMeta();
    const errors = [];

    for (const b of badLines) {
      errors.push({ kind: 'corrupt_line', line: b.index, preview: b.preview });
    }
    if (tornTail) {
      errors.push({ kind: 'torn_tail' });
    }

    const seenIds = new Set();
    const lastSeq = new Map();

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const v = verifyMessage(m);
      if (!v.ok) {
        // Do NOT label every failure a signature failure. Reporting 'bad_ts' as
        // 'bad_signature' sends a reader hunting for tampering that is not there.
        const KIND = { bad_pow: 'bad_pow', bad_ts: 'bad_ts', too_large: 'too_large' };
        errors.push({ kind: KIND[v.reason] ?? 'bad_signature', index: i, reason: v.reason, from: m?.from ?? null });
        continue;
      }
      const id = messageId(m);
      if (seenIds.has(id)) {
        errors.push({ kind: 'duplicate_message', index: i, id });
        continue;
      }
      seenIds.add(id);

      const prev = lastSeq.get(m.from);
      if (prev !== undefined && !(m.seq > prev)) {
        errors.push({ kind: 'seq_not_increasing', index: i, from: m.from, previous: prev, current: m.seq });
      }
      lastSeq.set(m.from, m.seq);
    }

    return {
      ok: errors.length === 0,
      messages,
      senders: [...lastSeq.keys()],
      errors,
    };
  }

  readSince(senderId, seq) {
    return this.readAll().filter((m) => m.from === senderId && m.seq > seq);
  }

  stats() {
    const messages = this.readAll();
    const senders = new Set(messages.map((m) => m.from));
    let firstTs = null;
    let lastTs = null;
    for (const m of messages) {
      if (typeof m.ts !== 'number') continue;
      if (firstTs === null || m.ts < firstTs) firstTs = m.ts;
      if (lastTs === null || m.ts > lastTs) lastTs = m.ts;
    }
    let bytes = 0;
    try { bytes = statSync(this.path).size; } catch { /* file removed under us */ }
    return { messages: messages.length, senders: senders.size, firstTs, lastTs, bytes, path: this.path };
  }
}

export default AppendOnlyStore;
