import assert from 'node:assert/strict';
import { identityFromSeed, sign, verify, shortId } from '../src/identity.mjs';

let passed = 0;
function check(name, fn) {
  fn();
  console.log(`PASS ${name}`);
  passed += 1;
}
// Print a total, like every other suite does. Without it this file was invisible to any
// summary that tallies "N assertions passed" — so an entire suite could drop out of a total
// and the total would still look entirely credible.
process.on('exit', () => console.log(`\n${passed} assertions passed.`));

const seed = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const first = identityFromSeed(seed);
const second = identityFromSeed(seed);
const bytes = Buffer.from('commons identity cross-check');
const signature = sign(first, bytes);

check('deterministic identity from seed', () => assert.equal(first.agentId, second.agentId));
check('agentId equals base64url public key', () => assert.equal(first.agentId, first.publicKey));
check('public key encoding is 32 bytes', () => assert.equal(Buffer.from(first.publicKey, 'base64url').length, 32));
check('private seed encoding is 32 bytes', () => assert.equal(Buffer.from(first.privateKey, 'base64url').length, 32));
check('sign verifies with matching public key', () => assert.equal(verify(first.publicKey, bytes, signature), true));
check('one-bit signed-byte mutation fails verification', () => {
  const altered = Buffer.from(bytes);
  altered[0] ^= 1;
  assert.equal(verify(first.publicKey, altered, signature), false);
});
check('null public key returns false', () => assert.equal(verify(null, bytes, signature), false));
check('null signature returns false', () => assert.equal(verify(first.publicKey, bytes, null), false));
check('empty key and signature return false', () => assert.equal(verify('', bytes, ''), false));
check('wrong-length public key returns false', () => assert.equal(verify('AA', bytes, signature), false));
check('shortId returns first eight characters', () => assert.equal(shortId(first.agentId), first.agentId.slice(0, 8)));
