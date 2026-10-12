#!/usr/bin/env node
// Does the DEPLOYED relay still behave like THIS repository? Run: node tools/relay-drift.mjs
//
// WHY THIS EXISTS
// Round 48 fixed the deployed relay's operator queue in this repository and could not deploy it --
// there is no Cloudflare channel on this machine (no wrangler, no credentials, no CI; measured
// 2026-10-12). From then on "the deployed relay still runs the pre-fix worker" was a claim resting on
// ONE manual observation, and a claim that cannot be re-derived on demand is exactly what this
// program refuses to ship. The gap is not cosmetic: the old route dropped queue entries it could not
// read while answering ok:true, so an operator could be told "nobody is waiting" over a joiner who
// was. A remembered limitation decays; a re-runnable check does not.
//
// WHAT IS COMPARED, AND WHAT IS NOT
// The same request goes to two implementations: worker/worker.js from THIS tree (in process, on a
// mock KV seeded with ONE fixture message) and the deployed relay (over the network). Compared: the
// HTTP status and the RESPONSE SHAPE -- every JSON path with its type -- recursively. Deliberately
// NOT compared: values. The deployed relay holds real state and the local one holds a fixture, so
// value equality would be noise.
//
// WHY THE STORE IS SEEDED AND NOT EMPTY. An empty local store made `GET /messages` answer
// `cursor: null` (the route returns the request's `since` when there are no messages) while the
// relay answered `cursor: "<id>"`. That difference belonged to the FIXTURE, not to the code, and it
// arrived in the report dressed as drift -- "SAME PATH, DIFFERENT TYPE". A drift report that cries
// wolf on its own harness is one a reader learns to skim, and skimming costs exactly the real drift
// this tool exists to catch. With one fixture message both sides answer the same KINDS of facts, so
// a cursor that genuinely changed type is now reported instead of excused.
//
// A shape match therefore does NOT prove the deploy is current; it proves the deploy is not missing
// (or inventing) a field or a route that this tree emits. That limit is printed, not glossed.
//
// Exit: 0 = no shape drift on any probe; 1 = DRIFT, named per route and field;
//       2 = COULD NOT COMPARE (relay unreachable, a local call threw, secret unreadable).
//       2 is NEVER reported as 0: a comparison that did not happen is not a passing comparison.
//
// Usage:
//   node tools/relay-drift.mjs [--relay <url>] [--secret-file <path>] [--json]

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import worker from '../worker/worker.js';
import { messageId } from '../src/message.mjs';

const DEFAULT_RELAY = process.env.COMMONS_URL || 'https://agent-commons.huyxkhoa.workers.dev';
const DEFAULT_SECRET = process.env.AC_OPERATOR_SECRET_FILE
  || join(homedir(), '.dsh', 'agent-commons', 'relay-operator-secret.txt');

// Read-only probes, deliberately. This tool must be safe to point at the live relay at any time: it
// never POSTs, never writes, and never asks the operator route for anything but the queue.
const PROBES = [
  { name: 'GET /messages', path: '/messages', auth: false },
  { name: 'GET /admission/requests', path: '/admission/requests', auth: true },
  { name: 'GET /admission/bind (no params)', path: '/admission/bind', auth: false },
  { name: 'GET /health', path: '/health', auth: false },
];

// --- the comparison, kept pure and exported so it can be tested without a network ----------------

// A canonical description of a JSON value: every path it reaches, with the type found there. A
// missing field, an extra field and a changed type all fall out of this as set differences, which is
// the whole point -- "the deploy is older" is not one fact but a list of specific ones.
export function shapeOf(value, path = '$', out = new Set()) {
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  out.add(`${path}:${type}`);
  if (type === 'array') {
    // Only the first element is described: the question is what SHAPE the array carries, not how
    // many entries the two sides happen to hold.
    if (value.length > 0) shapeOf(value[0], `${path}[]`, out);
  } else if (type === 'object') {
    for (const key of Object.keys(value).sort()) shapeOf(value[key], `${path}.${key}`, out);
  }
  return out;
}

// `repo` is what this tree emits, `live` is what the deployed relay answers.
export function diffShape(repo, live) {
  return {
    missingLive: [...repo].filter((p) => !live.has(p)).sort(),
    extraLive: [...live].filter((p) => !repo.has(p)).sort(),
  };
}

// Every array path that held NO entries, with the element path this shape notation uses for it.
export function emptyArrayPaths(value, path = '$', out = []) {
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (type === 'array') {
    if (value.length === 0) out.push(`${path}[]`);
    else emptyArrayPaths(value[0], `${path}[]`, out);
  } else if (type === 'object') {
    for (const key of Object.keys(value)) emptyArrayPaths(value[key], `${path}.${key}`, out);
  }
  return out;
}

// A difference INSIDE an array that one side holds no entries for is not drift, and neither is a
// difference inside a MESSAGE BODY.
//
// (a) Emptiness: a side that holds no entries cannot describe entry fields at all, and the other
// side's real entries then look like fields it "sends extra". Counting those as drift is the defect
// this program keeps finding -- a read whose known incompleteness is turned into a confident
// assertion. They are reported as STATED LIMITS instead, and the honest drift signal (a field this
// tree sends and the deploy does not) is left standing on its own.
//
// (b) Peer content: a message's `body` is ANY JSON value by specification
// (spec/COMMONS-SPEC.md: "body": { "any": "JSON value" }). Its interior is therefore whatever a
// stranger chose to send, not a wire contract -- and if it were compared key by key, this tool's
// verdict would depend on WHICH message happened to be newest on the relay. The type of `body` is
// still compared (string vs object IS a real difference); only its interior is a stated limit. One
// fixture message can match an envelope; it can never match arbitrary peer content, and saying so is
// more honest than a fixture that claims to.
export const PEER_CONTENT = /^\$\.messages\[\]\.body\./;

export function splitByComparability(diff, repoEmpties, liveEmpties) {
  const under = (p, prefixes) => prefixes.some((a) => p.startsWith(a));
  const missingLive = [];
  const extraLive = [];
  const notComparable = [];
  for (const p of diff.missingLive) {
    if (PEER_CONTENT.test(p)) {
      notComparable.push({ path: p, why: '`body` is any JSON value by spec: its interior is peer content, not a wire contract' });
    } else if (under(p, liveEmpties)) {
      notComparable.push({ path: p, why: 'the relay returned NO entries here, so entry fields cannot be compared' });
    } else missingLive.push(p);
  }
  for (const p of diff.extraLive) {
    if (PEER_CONTENT.test(p)) {
      notComparable.push({ path: p, why: '`body` is any JSON value by spec: its interior is peer content, not a wire contract' });
    } else if (under(p, repoEmpties)) {
      notComparable.push({ path: p, why: 'this side holds NO entries here, so entry fields cannot be compared' });
    } else extraLive.push(p);
  }
  return { missingLive, extraLive, notComparable };
}

// --- the two sides -------------------------------------------------------------------------------

// A path present on BOTH sides with a DIFFERENT TYPE is a real difference in this tree, but it can
// also be a difference in STATE: an empty list answers `cursor: null` where a populated one answers a
// string. Pairing them lets the report say which kind it is looking at, instead of letting a reader
// conclude that the deployed CODE differs when only the data does.
export function typeOnlyPairs(missingLive, extraLive) {
  const pathOf = (p) => p.slice(0, p.lastIndexOf(':'));
  const typeOf = (p) => p.slice(p.lastIndexOf(':') + 1);
  const pairs = [];
  for (const m of missingLive) {
    const match = extraLive.find((x) => pathOf(x) === pathOf(m));
    if (match) pairs.push({ path: pathOf(m), here: typeOf(m), relay: typeOf(match) });
  }
  return pairs;
}

// The local store is NOT empty, and that is deliberate (see the header). One fixture message, in the
// shape the Worker's own validator demands (v/from/seq/ts/type/sig/pow, `from` a 40-64 char key), so
// that `GET /messages` answers on this side with the facts a live relay answers with -- a real cursor
// string rather than null. The key uses the Worker's own format: `m:<ts padded to 13>:<messageId>`.
export const FIXTURE_MESSAGE = {
  v: 1,
  from: 'a'.repeat(64),
  seq: 1,
  ts: 1750000000000,
  type: 'announce',
  sig: 'b'.repeat(64),
  pow: 'fixture',
  topic: 'drift-fixture',
  // `refs` is envelope, not peer content: src/message.mjs:86 always emits it (`fields.refs ?? []`) and
  // :97-101 requires it to be present and to be an array of strings. An empty array here, which is what
  // a first message carries -- live entries with refs will have their ELEMENTS demoted by the emptiness
  // rule, since this side holds no entries under `$.messages[].refs[]`.
  refs: [],
  // `body` is ANY JSON value by spec. An OBJECT here, because that is what the live messages carry, so
  // the TYPE matches and a string-vs-object difference would still be reported as drift. What is inside
  // it is peer content and is compared only for its presence, never key by key (see PEER_CONTENT).
  body: { text: 'fixture message: it exists so the local /messages has the same SHAPE as a live one' },
};

export async function fixtureSeed() {
  const id = await messageId(FIXTURE_MESSAGE);
  return { [`m:${String(FIXTURE_MESSAGE.ts).padStart(13, '0')}:${id}`]: FIXTURE_MESSAGE };
}

export function mockKV(seed = {}) {
  const store = new Map(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) { store.set(key, value); },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit)
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

async function readJson(res) {
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    // A non-JSON body is itself a shape, and a real one: an HTML error page from an edge is not the
    // same answer as this tree's JSON, and pretending otherwise would hide a whole class of drift.
    return { status: res.status, body: `(non-JSON body, ${text.length} chars)` };
  }
}

async function compareOne(probe, { relay, secret }) {
  const headers = probe.auth ? { authorization: `Bearer ${secret}`, 'cache-control': 'no-store' } : {};
  const url = `${relay.replace(/\/+$/, '')}${probe.path}`;

  let local;
  try {
    const res = await worker.fetch(new Request(`https://local.test${probe.path}`, { headers }),
      { COMMONS: mockKV(await fixtureSeed()), ADMISSION_OPERATOR_SECRET: secret });
    local = await readJson(res);
  } catch (err) {
    return { probe, skipped: `the LOCAL worker threw: ${err?.message || err}` };
  }

  let live;
  try {
    const res = await fetch(`${url}${probe.path.includes('?') ? '&' : '?'}cb=${Date.now().toString(36)}`,
      { headers, cache: 'no-store' });
    live = await readJson(res);
  } catch (err) {
    return { probe, skipped: `the DEPLOYED relay could not be reached: ${err?.message || err}` };
  }

  const repoShape = shapeOf(local.body);
  const liveShape = shapeOf(live.body);
  const split = splitByComparability(
    diffShape(repoShape, liveShape),
    emptyArrayPaths(local.body),
    emptyArrayPaths(live.body),
  );
  const statusDrift = local.status !== live.status;
  return {
    probe, local, live, statusDrift, ...split,
    drift: statusDrift || split.missingLive.length > 0 || split.extraLive.length > 0,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const asJson = argv.includes('--json');
  const relay = arg('relay', DEFAULT_RELAY);
  const secretFile = arg('secret-file', DEFAULT_SECRET);

  if (!existsSync(secretFile)) {
    console.error(`relay drift: FAIL -- no operator secret at ${secretFile}`);
    console.error('  Without it the operator route answers 401 on BOTH sides, and a 401-vs-401');
    console.error('  "match" is not a comparison of the queue. Refusing rather than reporting one.');
    process.exit(2);
  }
  const secret = readFileSync(secretFile, 'utf8').trim();

  return (async () => {
    const results = [];
    for (const probe of PROBES) results.push(await compareOne(probe, { relay, secret }));

    const skipped = results.filter((r) => r.skipped);
    const drifted = results.filter((r) => !r.skipped && r.drift);

    if (asJson) {
      console.log(JSON.stringify({
        relay,
        compared: results.filter((r) => !r.skipped).length,
        drifted: drifted.length,
        couldNotCompare: skipped.length,
        results: results.map((r) => (r.skipped
          ? { probe: r.probe.name, skipped: r.skipped }
          : {
            probe: r.probe.name, status: `${r.local.status} vs ${r.live.status}`,
            drift: r.drift, missingLive: r.missingLive, extraLive: r.extraLive,
            notComparable: r.notComparable,
          })),
      }, null, 2));
    } else {
      console.log(`\n--- deployed relay vs this tree ---`);
      console.log(`  deployed: ${relay}`);
      console.log(`  local:    worker/worker.js from this working tree, in process, on a mock KV seeded with one fixture message\n`);
      for (const r of results) {
        if (r.skipped) { console.log(`  COULD-NOT-COMPARE  ${r.probe.name}\n      ${r.skipped}`); continue; }
        const label = r.drift ? 'DRIFT            ' : (r.notComparable.length ? 'same (limits)    ' : 'same             ');
        console.log(`  ${label} ${r.probe.name}  (status ${r.local.status} vs ${r.live.status})`);
        for (const p of r.missingLive) console.log(`      the deploy does NOT send  ${p}`);
        for (const p of r.extraLive) console.log(`      the deploy ALSO sends     ${p}`);
        for (const n of r.notComparable) console.log(`      NOT COMPARABLE here:      ${n.path} -- ${n.why}`);
        for (const t of typeOnlyPairs(r.missingLive, r.extraLive)) {
          console.log(`      SAME PATH, DIFFERENT TYPE: ${t.path} (${t.here} in this tree, ${t.relay} on the relay)`
            + ' -- this CAN be state-dependent, since values were not compared');
        }
        if (r.statusDrift) console.log(`      status differs: this tree answers ${r.local.status}, the deploy answers ${r.live.status}`);
      }
      console.log('\n  Compared: HTTP status and response SHAPE (every JSON path with its type).');
      console.log('  Peer content: a message `body` is any JSON value by spec, so its interior is a stated');
      console.log('  limit -- only its TYPE is compared. The message ENVELOPE is compared field by field.');
      console.log('  NOT compared: values. The deploy holds real state and the local side holds a fixture,');
      console.log('  so a shape match means "the deploy is not missing a field or route this tree has"');
      console.log('  -- it does NOT mean the deploy is current. Absence of drift is not a deploy.');
    }

    if (skipped.length) {
      console.error(`\nCOULD NOT COMPARE: ${skipped.length} of ${PROBES.length} probe(s) never ran to`
        + ' a comparison. That is not a pass, and it must not be read as one.\n');
      process.exit(2);
    }
    if (drifted.length) {
      console.error(`\nDRIFT: ${drifted.length} of ${results.length} probe(s) answer a different shape than`
        + ' this tree. The deployed relay is behind (or ahead of) the code in this checkout.\n');
      process.exit(1);
    }
    console.log(`\nNo shape drift on ${results.length} probe(s). Limits stated above.\n`);
    process.exit(0);
  })();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
