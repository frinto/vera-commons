// test/feed-roundtrip.test.mjs
//
// WHY THIS EXISTS: tools/verify-feed.mjs was a checker NOTHING ran — a claim nothing checks. It
// verifies a feed response against an id computed BEFORE the message was sent, because the obvious
// substitute ("did returned.id equal sent.id?") compares two fields that do not exist on the wire
// and therefore always passes. Its own header says so. A check that cannot fail is not a check, so
// this test drives the real round trip — a real local relay, real HTTP, the bytes as received — and
// then makes the verifier FAIL on purpose, twice: once on a mutated body, once on a feed holding no
// message at all. If the tool ever becomes decorative again, this test stops passing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCommonsServer } from '../src/server.mjs';
import { generateIdentity } from '../src/identity.mjs';
import { createMessage, messageId } from '../src/message.mjs';

const TOOL = fileURLToPath(new URL('../tools/verify-feed.mjs', import.meta.url));

function runVerifier(expectedId, file) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [TOOL, expectedId, file], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('a message survives the wire byte-for-byte, and the checker can FAIL', async () => {
  const BASE = mkdtempSync(join(tmpdir(), 'ac-feed-'));
  const relay = createCommonsServer({ dir: join(BASE, 'relay') });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${relay.address().port}`;
  try {
    const who = generateIdentity();
    const msg = createMessage(who, { type: 'hello', body: { note: 'feed round trip', n: 1 } });

    // ★ THE ID IS COMPUTED BEFORE THE MESSAGE IS SENT. That is the whole point: computed
    // afterwards the comparison is circular and passes for any bytes at all.
    const expectedId = messageId(msg);

    const posted = await fetch(`${endpoint}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(msg),
    });
    assert.equal(posted.status, 201, `POST /messages answered ${posted.status}`);

    const res = await fetch(`${endpoint}/messages?limit=1`);
    const wire = await res.text(); // the bytes AS RECEIVED — never re-serialized before checking
    const feedFile = join(BASE, 'feed.json');
    writeFileSync(feedFile, wire);

    const ok = runVerifier(expectedId, feedFile);
    assert.equal(ok.code, 0, `the round trip must verify, but the checker refused it:\n${ok.out}`);

    // NEGATIVE CONTROL 1 — one field changed. The verifier MUST refuse, and must say why.
    const mutated = JSON.parse(wire);
    mutated.messages[0].body.n = 2;
    const mutatedFile = join(BASE, 'feed-mutated.json');
    writeFileSync(mutatedFile, JSON.stringify(mutated));
    const bad = runVerifier(expectedId, mutatedFile);
    assert.notEqual(bad.code, 0, 'the checker PASSED a feed whose bytes had changed — it is decorative');
    assert.match(bad.out, /id mismatch/, `expected an id mismatch, got: ${bad.out}`);

    // NEGATIVE CONTROL 2 — a feed with no message must not read as success either.
    const emptyFile = join(BASE, 'feed-empty.json');
    writeFileSync(emptyFile, JSON.stringify({ ok: true, messages: [] }));
    const none = runVerifier(expectedId, emptyFile);
    assert.notEqual(none.code, 0, 'an empty feed must not verify');
    assert.match(none.out, /expected exactly 1 message/, `expected the empty-feed refusal, got: ${none.out}`);
  } finally {
    relay.closeAllConnections?.();
    relay.close();
  }
});
