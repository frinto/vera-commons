/**
 * The invariant this file protects: an UNREAD queue must never be countable as an empty one, and a
 * relay that did not report completeness must never be rendered as if it had.
 *
 * Every check below is offline and TOTAL: the input is a literal payload, the expected verdict is
 * written out. The two CONTROL checks are the discrimination evidence -- they run the OLD
 * expressions on the same inputs and show they produce the reassuring answer the new one refuses.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPLETENESS_NOT_REPORTED,
  COMPLETENESS_REPORTED,
  completenessLine,
  readQueue,
} from '../src/queue-read.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail === undefined ? '' : ` -- ${detail}`}`);
  }
};

console.log('queue-read: what the relay said, versus what a consumer may claim');

// --- the clean case: a relay that reports everything must produce NO caveats ---------------------
const full = readQueue({
  ok: true,
  requests: [{ requestId: 'r1', joinKey: 'J1', note: 'I would like to join', at: 1 }],
  total: 1,
  truncated: false,
  unreadable: [],
});
check('a fully reported page reads', full.read === true);
check('a fully reported page keeps its rows', Array.isArray(full.rows) && full.rows.length === 1);
check('a fully reported page is COMPLETE and says so', full.completeness === COMPLETENESS_REPORTED && completenessLine(full) === 'page complete',
  completenessLine(full));
check('a clean page raises NO caveats (the warning path is not a rubber stamp)', full.caveats.length === 0, JSON.stringify(full.caveats));

// --- THE INVARIANT: an unread queue is a refusal, never a zero -----------------------------------
const unreadBodies = [
  ['a 200 with no requests field at all', { ok: true }],
  ['an empty object', {}],
  ['a null body', null],
  ['a body that is not an object', 'nope'],
  ['requests present but not a list', { ok: true, requests: {} }],
];
for (const [label, payload] of unreadBodies) {
  const v = readQueue(payload);
  check(`REFUSES to read: ${label}`, v.read === false, JSON.stringify(v).slice(0, 160));
  check(`  ... and rows is null, never [] : ${label}`, v.rows === null, `rows=${JSON.stringify(v.rows)}`);
  check(`  ... and it states a caveat: ${label}`, Array.isArray(v.caveats) && v.caveats.length > 0);
}

// --- the neighbouring case that MUST stay readable: the field is there and genuinely empty -------
const empty = readQueue({ ok: true, requests: [] });
check('an EMPTY-but-reported-absent page still reads (it is not an error)', empty.read === true);
check('  ... and its rows are an empty array', Array.isArray(empty.rows) && empty.rows.length === 0);
check('  ... but it is NOT completeness-reported', empty.completeness === COMPLETENESS_NOT_REPORTED, String(empty.completeness));
check('  ... so it carries a caveat and can never be a clean "nobody waiting"', empty.caveats.length > 0 && completenessLine(empty).includes('NOT REPORTED'),
  completenessLine(empty));

// --- the relay currently in service: requests yes, completeness signals no -----------------------
// Measured live 2026-10-12 (tools/relay-drift.mjs): the deployed relay omits total/truncated/unreadable.
const deployed = readQueue({ ok: true, requests: [{ requestId: 'x' }] });
check('the deployed relay shape reads', deployed.read === true);
check('  ... and it is reported as NOT REPORTED rather than complete', completenessLine(deployed) === 'completeness NOT REPORTED by this relay', completenessLine(deployed));
check('  ... with exactly one caveat, not three (one fact, one warning)',
  deployed.caveats.length === 1 && /truncated/.test(deployed.caveats[0]) && /total/.test(deployed.caveats[0]),
  JSON.stringify(deployed.caveats));

// --- a reported INCOMPLETE page must say so, with the names -----------------------------------
const cut = readQueue({ ok: true, requests: [{ requestId: 'x' }], total: 40, truncated: true, unreadable: ['req-corrupt'] });
check('truncated:true is INCOMPLETE', cut.truncated === true && completenessLine(cut).startsWith('INCOMPLETE'));
check('truncated:true names the fact in the caveats', cut.caveats.some((c) => /MORE requests are waiting/.test(c)), JSON.stringify(cut.caveats));
check('an unreadable entry is named, not counted away', cut.unreadable.length === 1 && cut.caveats.some((c) => c.includes('req-corrupt')),
  JSON.stringify(cut.caveats));
check('total is carried when the relay reports it', cut.total === 40);

// --- MALFORMED signals: present, but not the expected type ------------------------------------
const badFlag = readQueue({ ok: true, requests: [], truncated: 'yes', unreadable: [] });
check('a non-boolean truncated is NOT known', badFlag.truncated === null, String(badFlag.truncated));
check('  ... so completeness is not established', badFlag.completeness === COMPLETENESS_NOT_REPORTED, String(badFlag.completeness));
check('  ... and it never renders as "page complete"', completenessLine(badFlag) !== 'page complete', completenessLine(badFlag));
check('  ... with a caveat naming the malformed signal', badFlag.caveats.some((c) => /not true\/false/.test(c)), JSON.stringify(badFlag.caveats));

// The check that caught this module's own first draft: a well-formed `unreadable` must NOT be able
// to certify a page whose TRUNCATION is unstated or malformed. Only `truncated` licenses "complete".
const halfReported = readQueue({ ok: true, requests: [], truncated: false });
check('truncated:false with no unreadable count is NOT "page complete"',
  completenessLine(halfReported) !== 'page complete', completenessLine(halfReported));
check('  ... and it says which half is missing',
  halfReported.caveats.some((c) => /unreadable` absent/.test(c)), JSON.stringify(halfReported.caveats));
check('a well-formed unreadable cannot certify an unknown truncation',
  readQueue({ requests: [], truncated: 'yes', unreadable: [] }).completeness === COMPLETENESS_NOT_REPORTED);

const badList = readQueue({ ok: true, requests: [], unreadable: 'req-corrupt' });
check('a non-list unreadable is NOT silently dropped to []', badList.unreadable === null, JSON.stringify(badList.unreadable));
check('  ... it produces a caveat instead', badList.caveats.some((c) => /not a list/.test(c)), JSON.stringify(badList.caveats));

// --- CONTROL: the OLD expressions, on the same inputs, produce the reassuring answer -------------
// If these assertions ever fail, the new module has stopped being a fix and become a rewrite.
const oldRows = (p) => (p?.requests ?? []);
const oldReported = (b) => (b?.truncated !== undefined || (Array.isArray(b?.unreadable) ? b.unreadable : null) !== null);
const oldCompleteness = (b) => (oldReported(b) && b?.truncated !== true ? 'page complete' : 'not complete');

check('CONTROL: the old `?? []` turns the unread body into an empty queue', oldRows({ ok: true }).length === 0);
check('CONTROL: ... while readQueue refuses it', readQueue({ ok: true }).read === false);
check('CONTROL: the old flag test calls a malformed truncated "page complete"',
  oldCompleteness({ requests: [], truncated: 'yes' }) === 'page complete');
check('CONTROL: ... while readQueue refuses to certify it', completenessLine(badFlag) !== 'page complete');

// --- purity: this module is inlined into the Worker, so it must import nothing -------------------
const source = readFileSync(join(HERE, '..', 'src', 'queue-read.mjs'), 'utf8');
check('the module imports nothing (usable inside the Worker bundle)',
  !/^\s*import\s/m.test(source) && !/require\(/.test(source));

console.log(failures === 0 ? 'queue-read: all checks passed' : `queue-read: ${failures} FAILED`);
assert.equal(failures, 0);
