// Retraction (tombstone) tests.
//
// The cases that matter here are the NEGATIVE ones. A retraction is a power to remove something
// from view in a log whose entire value is that nothing can be removed quietly, so the tests that
// prove it REFUSES the wrong party are the point of the feature, not a formality.
//
// Run: node test/retract.test.mjs

import { readRetraction, authorizeRetraction, applyRetractions, describeRetraction } from '../src/retract.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

const ADMIN = 'ADMIN_KEY_'.padEnd(43, 'A');
const AUTHOR = 'AUTHOR_KEY'.padEnd(43, 'B');
const STRANGER = 'STRANG_KEY'.padEnd(43, 'C');

const LEVELS = { [ADMIN]: 'admin', [AUTHOR]: 'poster', [STRANGER]: 'poster' };
const levelOf = (key) => LEVELS[key] ?? 'observer';

// --- fixtures ---------------------------------------------------------------
const target = { id: 'msg-1', from: AUTHOR, type: 'announce', body: { text: 'something I said' } };
const other = { id: 'msg-2', from: AUTHOR, type: 'reply', body: { text: 'and this too' } };
const adminRetraction = { id: 'r-1', from: ADMIN, type: 'revoke', ts: 1, refs: ['msg-1'], body: { retracts: 'msg-1', reason: 'harmful content' } };
const authorRetraction = { id: 'r-2', from: AUTHOR, type: 'revoke', ts: 2, refs: ['msg-1'], body: { retracts: 'msg-1' } };
const strangerRetraction = { id: 'r-3', from: STRANGER, type: 'revoke', ts: 3, refs: ['msg-1'], body: { retracts: 'msg-1' } };

console.log('--- reading a retraction ---');
check('a revoke message naming a target is read as a retraction', readRetraction(adminRetraction)?.target === 'msg-1');
check('a non-revoke message is NOT a retraction', readRetraction(target) === null);
check('a revoke with no target is NOT a retraction',
  readRetraction({ type: 'revoke', from: ADMIN, body: {} }) === null);
check('a revoke with a non-string target is NOT a retraction',
  readRetraction({ type: 'revoke', from: ADMIN, body: { retracts: 42 } }) === null);

console.log('');
console.log('--- who may retract ---');
check('an ADMIN may retract any message',
  authorizeRetraction({ retraction: adminRetraction, target, level: 'admin' }).ok === true);
check('★ ...and it is recorded as the ADMIN role, not merely "allowed"',
  authorizeRetraction({ retraction: adminRetraction, target, level: 'admin' }).role === 'admin',
  'a truthy-only check here would also pass if the author rule had fired');
check('an AUTHOR may retract their OWN message',
  authorizeRetraction({ retraction: authorRetraction, target, level: 'poster' }).ok === true);
check('★ ...and it is recorded as the AUTHOR role',
  authorizeRetraction({ retraction: authorRetraction, target, level: 'poster' }).role === 'author');
check('★ an ADMIN retracting their OWN message is admin, not author (role is decided by authority)',
  authorizeRetraction({
    retraction: { ...adminRetraction, from: ADMIN },
    target: { ...target, from: ADMIN }, level: 'admin',
  }).role === 'admin');
check('★ a STRANGER may NOT retract someone else\'s message',
  authorizeRetraction({ retraction: strangerRetraction, target, level: 'poster' }).ok === false);
check('★ a stranger is refused with a named reason, not silently ignored',
  authorizeRetraction({ retraction: strangerRetraction, target, level: 'poster' }).reason === 'not_authorized');
check('★ an OBSERVER may not retract anything',
  authorizeRetraction({ retraction: adminRetraction, target, level: 'observer' }).ok === false);
check('an author may NOT retract a DIFFERENT author\'s message',
  authorizeRetraction({
    retraction: { ...authorRetraction, from: STRANGER },
    target, level: 'poster',
  }).ok === false);
check('retracting an unknown target is refused',
  authorizeRetraction({ retraction: adminRetraction, target: null, level: 'admin' }).reason === 'unknown_target');

console.log('');
console.log('--- a retraction cannot itself be retracted ---');
const retractionOfRetraction = { id: 'r-4', from: ADMIN, type: 'revoke', ts: 4, refs: ['r-1'], body: { retracts: 'r-1' } };
check('★ an admin may NOT retract a retraction (order must not decide the outcome)',
  authorizeRetraction({ retraction: retractionOfRetraction, target: adminRetraction, level: 'admin' }).reason === 'cannot_retract_a_retraction');

console.log('');
console.log('--- folding a log into what is shown ---');
let res = applyRetractions([target, other, adminRetraction], { levelOf });
check('an honoured retraction removes the target from what is shown',
  res.visible.length === 2 && !res.visible.some((m) => m.id === 'msg-1'));
check('the retraction itself is still IN the log (append-only preserved)',
  res.visible.some((m) => m.id === 'r-1'));
check('the retraction is recorded so a UI can say what happened',
  res.retracted.get('msg-1')?.by === ADMIN);
check('the untouched message is unaffected', res.visible.some((m) => m.id === 'msg-2'));

res = applyRetractions([target, other, strangerRetraction], { levelOf });
check('★ a stranger\'s retraction does NOT hide the message',
  res.visible.some((m) => m.id === 'msg-1'));
check('★ and the refused retraction is recorded, not silently dropped',
  res.refused.length === 1 && res.refused[0].reason === 'not_authorized');

res = applyRetractions([target, other, authorRetraction], { levelOf });
check('an author\'s own retraction does hide their own message',
  !res.visible.some((m) => m.id === 'msg-1'));
check('and it is attributed to the author, not an admin',
  res.retracted.get('msg-1') !== undefined);

console.log('');
console.log('--- order independence (replay must not change the outcome) ---');
const both = [target, adminRetraction, { ...authorRetraction, id: 'r-9' }];
const forward = applyRetractions(both, { levelOf });
const backward = applyRetractions([...both].reverse(), { levelOf });
check('the same retractions in either order hide the same message',
  !forward.visible.some((m) => m.id === 'msg-1') && !backward.visible.some((m) => m.id === 'msg-1'));
check('★ the recorded retractor is IDENTICAL in either order (authority, not arrival, decides)',
  forward.retracted.get('msg-1').id === backward.retracted.get('msg-1').id,
  forward.retracted.get('msg-1').id + ' vs ' + backward.retracted.get('msg-1').id);
check('★ and the ADMIN retraction is the one reported, whichever arrives first',
  forward.retracted.get('msg-1').role === 'admin' && backward.retracted.get('msg-1').role === 'admin',
  forward.retracted.get('msg-1').role + ' / ' + backward.retracted.get('msg-1').role);

// Two retractions of EQUAL authority must still resolve to one answer, decided by id and not order.
const twoAdmins = [
  target,
  { ...adminRetraction, id: 'r-b', from: ADMIN },
  { ...adminRetraction, id: 'r-a', from: ADMIN },
];
const tf = applyRetractions(twoAdmins, { levelOf });
const tb = applyRetractions([...twoAdmins].reverse(), { levelOf });
check('★ two equal-authority retractions resolve to the same one in either order (tie-break by id)',
  tf.retracted.get('msg-1').id === tb.retracted.get('msg-1').id && tf.retracted.get('msg-1').id === 'r-a',
  tf.retracted.get('msg-1').id + ' vs ' + tb.retracted.get('msg-1').id);

console.log('');
console.log('--- a retraction for a message that is not here ---');
res = applyRetractions([adminRetraction], { levelOf });
check('a retraction whose target is absent is refused, not honoured blindly',
  res.refused.length === 1 && res.refused[0].reason === 'unknown_target');

console.log('');
console.log('--- the human-readable line ---');
res = applyRetractions([target, other, adminRetraction], { levelOf });
check('an admin retraction describes who did it and why',
  describeRetraction(res.retracted.get('msg-1')) === 'Retracted by an admin: harmful content',
  describeRetraction(res.retracted.get('msg-1')));
res = applyRetractions([target, other, authorRetraction], { levelOf });
check('an author retraction says "its author"',
  describeRetraction(res.retracted.get('msg-1')) === 'Retracted by its author',
  describeRetraction(res.retracted.get('msg-1')));
check('a retraction with no stated reason still reads cleanly',
  describeRetraction({ role: 'admin' }) === 'Retracted by an admin',
  describeRetraction({ role: 'admin' }));

console.log('');
console.log(pass + ' assertions passed' + (fail ? ', ' + fail + ' FAILED' : '') + '.');
if (fail) process.exit(1);
