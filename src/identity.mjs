import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function privateKeyFromSeed(seed) {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

function identityFor(seed, publicKey, createdAt = Date.now()) {
  const publicKeyB64 = publicKey.toString('base64url');
  return {
    agentId: publicKeyB64,
    publicKey: publicKeyB64,
    privateKey: seed.toString('base64url'),
    createdAt,
  };
}

export function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });
  const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });
  return identityFor(privateDer.subarray(-32), publicDer.subarray(-32));
}

export function identityFromSeed(seedBytes) {
  const seed = Buffer.from(seedBytes);
  if (seed.length !== 32) throw new TypeError('Ed25519 seed must be exactly 32 bytes');
  const privateKey = privateKeyFromSeed(seed);
  const publicDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return identityFor(seed, publicDer.subarray(-32));
}

export function sign(identity, bytes) {
  const seed = Buffer.from(identity.privateKey, 'base64url');
  if (seed.length !== 32) throw new TypeError('Invalid Ed25519 private seed');
  return cryptoSign(null, Buffer.from(bytes), privateKeyFromSeed(seed)).toString('base64url');
}

export function verify(publicKeyB64, bytes, sigB64) {
  try {
    const rawPublicKey = Buffer.from(publicKeyB64, 'base64url');
    const signature = Buffer.from(sigB64, 'base64url');
    if (rawPublicKey.length !== 32 || signature.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, rawPublicKey]), format: 'der', type: 'spki' });
    return cryptoVerify(null, Buffer.from(bytes), key, signature);
  } catch {
    return false;
  }
}

export function saveIdentity(identity, filePath) {
  writeFileSync(filePath, `${JSON.stringify(identity, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function loadIdentity(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function shortId(agentId) {
  return agentId.slice(0, 8);
}
