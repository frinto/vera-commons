// The console's media gate, tested where it can actually be wrong.
//
// The interesting assertions here are the NEGATIVE ones. A gate that has only ever been observed
// saying yes is not known to be a gate, so this file checks three things the gate must REFUSE:
// a fixed disk, a network share, and an undeterminable volume. The last one is the important one:
// "I could not tell" must never resolve to "yes".
//
// It also exercises the real probe against this machine's own drive. That is a genuine negative
// control rather than a mock, because the repository lives on a fixed disk -- so the probe is
// asked a question whose answer is known in advance, and a probe that answered REMOVABLE here
// would be provably broken.

import { volumeKind, admitMedia, classifyDriveType, volumeRoot, REMOVABLE, FIXED, NETWORK, UNKNOWN } from '../console/media.mjs';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}

console.log('console media gate');

// --- 1. the Windows drive-type mapping --------------------------------------------------------
// Only 2 (removable) may pass. 3 is a local disk, 4 network, 6 RAM disk -- all refused.
check('DriveType 2 is removable', classifyDriveType(2) === REMOVABLE);
check('DriveType 3 is fixed', classifyDriveType(3) === FIXED);
check('DriveType 4 is network', classifyDriveType(4) === NETWORK);
check('DriveType 6 (RAM disk) is NOT accepted as a stick', classifyDriveType(6) !== REMOVABLE, `got ${classifyDriveType(6)}`);
check('an undocumented DriveType fails closed', classifyDriveType(99) === UNKNOWN, `got ${classifyDriveType(99)}`);

// --- 2. the decision, exhaustively ------------------------------------------------------------
check('removable media is admitted', admitMedia({ kind: REMOVABLE }).ok === true);
check('a fixed disk is refused', admitMedia({ kind: FIXED }).ok === false);
check('a network share is refused', admitMedia({ kind: NETWORK }).ok === false);
check('an UNDETERMINABLE volume is refused (fail closed)', admitMedia({ kind: UNKNOWN }).ok === false);
check('an unexpected kind string is refused', admitMedia({ kind: 'something-new' }).ok === false);
check('the override admits a fixed disk', admitMedia({ kind: FIXED, override: true }).ok === true);
check('the override is reported, not silent', admitMedia({ kind: FIXED, override: true }).overridden === true);
check('an overridden run is still marked as overridden when removable', admitMedia({ kind: REMOVABLE, override: true }).overridden === false,
  'a legitimate stick run must not be labelled an override');
check('a refusal names the override so the operator is not stranded', /--allow-fixed-disk/.test(admitMedia({ kind: FIXED }).reason));

// --- 3. the real probe, against a volume whose answer is known --------------------------------
const here = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const probe = await volumeKind(here);
console.log(`  ...   probe of ${volumeRoot(here)} -> ${probe.kind} (${probe.detail})`);
check('the real probe determines this machine\'s volume', probe.kind !== UNKNOWN, probe.detail);
check('this repository is on a FIXED disk, and the probe says so', probe.kind === FIXED,
  `expected fixed, got ${probe.kind} -- if this machine really has the repo on a stick, adjust the test, do not weaken it`);
check('the gate therefore refuses to run from this checkout',
  admitMedia({ kind: probe.kind }).ok === false);

// --- 4. a probe that throws must fail closed, not crash ---------------------------------------
const broken = await volumeKind(here, { exec: () => { throw new Error('no powershell on PATH'); } , platform: 'win32' });
check('a probe that throws yields UNKNOWN rather than an exception', broken.kind === UNKNOWN, broken.kind);
check('and UNKNOWN is then refused', admitMedia({ kind: broken.kind }).ok === false);
const unsupported = await volumeKind(here, { platform: 'plan9' });
check('an unimplemented platform fails closed', unsupported.kind === UNKNOWN, unsupported.kind);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
