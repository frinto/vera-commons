import { createHash } from 'node:crypto';
import { sign, verify } from './identity.mjs';

export const DEFAULT_POW_BITS = 12;
const MAX_MESSAGE_BYTES = 64 * 1024;
export const ALLOWED_TYPES = new Set(['hello', 'announce', 'offer', 'request', 'reply', 'presence', 'revoke']);

function sortedJsonValue(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new TypeError('Cannot canonicalize cyclic data');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => sortedJsonValue(item, seen));
  } else {
    result = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined && typeof item !== 'function' && typeof item !== 'symbol') {
        result[key] = sortedJsonValue(item, seen);
      }
    }
  }
  seen.delete(value);
  return result;
}

export function canonicalize(value) {
  const json = JSON.stringify(sortedJsonValue(value));
  if (json === undefined) throw new TypeError('Value is not JSON-serializable');
  return Buffer.from(json, 'utf8');
}

function withoutFields(message, fields) {
  const copy = { ...message };
  for (const field of fields) delete copy[field];
  return copy;
}

export function signingBytes(message) {
  return canonicalize(withoutFields(message, ['sig', 'pow', 'id']));
}

export function messageId(message) {
  return createHash('sha256')
    .update(canonicalize(withoutFields(message, ['sig', 'pow'])))
    .digest().subarray(0, 16).toString('hex');
}

export function powOK(message, bits = DEFAULT_POW_BITS) {
  if (!Number.isInteger(bits) || bits < 0 || bits > 256 || typeof message?.pow !== 'string') return false;
  try {
    const digest = createHash('sha256')
      .update(Buffer.concat([
        canonicalize(withoutFields(message, ['sig', 'pow'])),
        Buffer.from(message.pow, 'utf8'),
      ]))
      .digest();
    const fullBytes = Math.floor(bits / 8);
    for (let i = 0; i < fullBytes; i += 1) if (digest[i] !== 0) return false;
    const remainingBits = bits % 8;
    return remainingBits === 0 || (digest[fullBytes] >>> (8 - remainingBits)) === 0;
  } catch {
    return false;
  }
}

export function stampPow(message, bits = DEFAULT_POW_BITS) {
  if (!Number.isInteger(bits) || bits < 0 || bits > 256) throw new RangeError('bits must be an integer from 0 to 256');
  const stamped = { ...message, pow: '' };
  for (let nonce = 0; ; nonce += 1) {
    stamped.pow = nonce.toString(16);
    if (powOK(stamped, bits)) return stamped;
  }
}

export function createMessage(identity, fields, opts = {}) {
  const message = {
    v: 1,
    from: identity.publicKey,
    seq: opts.seq ?? 1,
    ts: opts.ts ?? Date.now(),
    type: fields.type,
    topic: fields.topic ?? null,
    body: fields.body,
    refs: fields.refs ?? [],
    pow: '',
    sig: '',
  };
  const stamped = stampPow(message, opts.bits ?? DEFAULT_POW_BITS);
  stamped.sig = sign(identity, signingBytes(stamped));
  return stamped;
}

export function verifyMessage(message, opts = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
      || !['v', 'from', 'seq', 'ts', 'type', 'topic', 'body', 'refs', 'pow', 'sig'].every((key) => Object.hasOwn(message, key))
      || typeof message.from !== 'string'
      || typeof message.type !== 'string'
      || !(message.topic === null || typeof message.topic === 'string')
      || !Array.isArray(message.refs) || !message.refs.every((ref) => typeof ref === 'string')
      || typeof message.pow !== 'string' || typeof message.sig !== 'string') {
    return { ok: false, reason: 'bad_shape' };
  }
  if (message.v !== 1) return { ok: false, reason: 'bad_version' };
  const publicKey = Buffer.from(message.from, 'base64url');
  if (publicKey.length !== 32 || publicKey.toString('base64url') !== message.from) return { ok: false, reason: 'bad_from' };
  if (!Number.isSafeInteger(message.seq) || message.seq < 1) return { ok: false, reason: 'bad_seq' };
  if (!Number.isSafeInteger(message.ts)) return { ok: false, reason: 'bad_ts' };
  // Freshness is a REPLAY defence, not a property of authenticity: a message does not
  // become a forgery as it ages. Enforcing this window by default made every stored
  // message fail verification five minutes after it was written — measured: a node's own
  // archive returned ok:false with reason 'bad_ts', and the relay feed that verified
  // cleanly at 03:04 failed at 03:08 with nothing having changed. An archive that expires
  // is not tamper-evident, it is tamper-evident-for-five-minutes. Ingest opts in with
  // { enforceFreshness: true }; verification at rest must not.
  if (opts.enforceFreshness) {
    const now = opts.now ?? Date.now();
    const windowMs = opts.windowMs ?? 5 * 60 * 1000;
    if (!Number.isFinite(now) || Math.abs(message.ts - now) > windowMs) return { ok: false, reason: 'bad_ts' };
  }
  if (!ALLOWED_TYPES.has(message.type) || (message.topic !== null && message.topic.length > 64)) return { ok: false, reason: 'bad_type' };
  let size;
  try {
    size = canonicalize(message).length;
  } catch {
    return { ok: false, reason: 'bad_shape' };
  }
  if (size > (opts.maxBytes ?? MAX_MESSAGE_BYTES)) return { ok: false, reason: 'too_large' };
  if (!powOK(message, opts.bits ?? DEFAULT_POW_BITS)) return { ok: false, reason: 'bad_pow' };
  if (!verify(message.from, signingBytes(message), message.sig)) return { ok: false, reason: 'bad_sig' };
  return { ok: true };
}
