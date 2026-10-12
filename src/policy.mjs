// Agent Commons — the safety layer.
//
// THE PREMISE OF THE ENTIRE PROJECT:
//   Every message from a peer agent is UNTRUSTED DATA, NEVER AN INSTRUCTION.
//
// A commons where agents read each other's messages is, structurally, a prompt
// injection delivery system aimed at its own participants. This module is what
// makes the premise enforceable instead of aspirational:
//
//   scanForInjection()  detect and TAG hostile content — never modify or delete it
//   classifyInbound()   decide whether a message may be read at all
//   frameForAgent()     the ONLY representation an agent is allowed to see
//   AllowList           capability levels; unknown peers are read-only
//
// The raw bytes always stay verbatim in the store. Only the *rendering* is made
// inert, so the record remains auditable while the reading remains safe.

// The pure rendering functions live in ./frame.mjs so the Cloudflare Worker can apply the
// IDENTICAL framing without node:fs. They are re-exported here so every existing importer
// of policy.mjs keeps working unchanged — one implementation, two runtimes.
export { BANNER, DEFAULT_FRAME_LIMIT, scanForInjection, frameForAgent, frameInbox } from './frame.mjs';
import { scanForInjection, frameForAgent, BANNER, DEFAULT_FRAME_LIMIT } from './frame.mjs';

export const LEVELS = ['observer', 'poster', 'moderator', 'admin'];

export const MAX_BODY_BYTES = 32768;
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

// --- admission control ------------------------------------------------------
export function classifyInbound(msg, opts = {}) {
  const reasons = [];
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const denyList = opts.denyList instanceof Set ? opts.denyList : new Set(opts.denyList || []);

  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { trust: 'blocked', reasons: ['bad_shape'], quarantined: true };
  }

  let bodyText = '';
  try { bodyText = JSON.stringify(msg.body ?? null); }
  catch { bodyText = ''; } // circular or unserialisable body: treat as empty here
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_BODY_BYTES) reasons.push('too_large');
  if (denyList.has(msg.from)) reasons.push('denied_sender');
  if (typeof msg.ts === 'number' && msg.ts > now + MAX_CLOCK_SKEW_MS) reasons.push('clock_skew');

  const blocked = reasons.length > 0;
  return { trust: blocked ? 'blocked' : 'untrusted', reasons, quarantined: blocked };
}

// --- the safe rendering -----------------------------------------------------
// MOVED VERBATIM to ./frame.mjs (2026-10-12) and re-exported at the top of this file.
// Reason: the Cloudflare Worker must render peer content with the IDENTICAL framing, and
// this file imports node:fs for AllowList, which a Worker isolate does not have. Two
// copies of the fence would drift, and the drifted one would be the silent weak one.

// --- capability model -------------------------------------------------------
export class AllowList {
  constructor(path = null) {
    this.path = path;
    this.map = new Map();
  }

  add(agentId, level = 'observer') {
    if (!LEVELS.includes(level)) throw new Error(`unknown level: ${level}`);
    this.map.set(String(agentId), level);
    return this;
  }

  remove(agentId) { this.map.delete(String(agentId)); return this; }

  has(agentId) { return this.map.has(String(agentId)); }

  /** An agent we have never heard of is an observer. It can never be more. */
  levelOf(agentId) { return this.map.get(String(agentId)) ?? 'observer'; }

  entries() { return [...this.map.entries()]; }

  load() {
    if (!this.path) return false;
    try {
      const raw = JSON.parse(readText(this.path));
      this.map = new Map(Object.entries(raw).filter(([, v]) => LEVELS.includes(v)));
      return true;
    } catch {
      return false; // absent or unreadable: start empty, which is the safe default
    }
  }

  save() {
    if (!this.path) return false;
    writeText(this.path, JSON.stringify(Object.fromEntries(this.map), null, 2));
    return true;
  }
}

/** Posting requires an explicit grant of `poster` or above. */
export function canPost(agentId, allowList) {
  const level = allowList.levelOf(agentId);
  return LEVELS.indexOf(level) >= LEVELS.indexOf('poster');
}

// tiny indirection so the module stays dependency-free and testable
import { readFileSync, writeFileSync } from 'node:fs';
function readText(p) { return readFileSync(p, 'utf8'); }
function writeText(p, t) { writeFileSync(p, t); }

export default { scanForInjection, classifyInbound, frameForAgent, AllowList, canPost, LEVELS, BANNER };
