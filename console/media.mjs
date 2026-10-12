// Agent Commons Console — the media gate.
//
// WHY THIS EXISTS, stated precisely, including what it does NOT buy.
//
// The console's original gate reads the admin key file from the stick. That is a good gate, and
// its property is exact: AUTHORITY REQUIRES POSSESSION OF THE KEY FILE. Reading the key is the
// check, so there is no cached flag that can disagree with reality.
//
// What it does not notice is WHERE that file is sitting. Copy the stick to a laptop's internal
// disk — a backup, a sync folder, one careless drag — and the console starts from the fixed disk
// and holds full admin authority there, indefinitely, with no stick in the machine. The deliverable
// asks for a USB-gated console; a gate that cannot tell a stick from a hard drive is only half of
// one.
//
// So this module adds the second half: the volume the console runs from must actually be
// removable media.
//
// THE HONEST LIMIT — do not oversell this. It raises the cost of running the console from a copy;
// it does NOT protect an adversary who already holds the stick, and it is not a cryptographic
// factor. Anyone who can edit the console's source can also delete this check. What it removes is
// the SILENT case: a console running from a copy, looking exactly like a console running from the
// stick.
//
// FAIL CLOSED. If the volume kind cannot be determined, the answer is NO. An undeterminable volume
// is exactly the situation a copied console is likely to be in, so "unknown" must never mean "yes".

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse, resolve } from 'node:path';

export const REMOVABLE = 'removable';
export const FIXED = 'fixed';
export const NETWORK = 'network';
export const UNKNOWN = 'unknown';

/**
 * Win32_LogicalDisk.DriveType, per Microsoft's documented values.
 * 0 unknown, 1 no root dir, 2 removable, 3 local disk, 4 network, 5 CD-ROM, 6 RAM disk.
 * Only 2 is treated as a stick. A RAM disk (6) is deliberately NOT accepted: it is memory
 * pretending to be media, and "the stick was pulled" would be meaningless against it.
 */
const WIN32_DRIVE_TYPE = {
  0: UNKNOWN,
  1: UNKNOWN,
  2: REMOVABLE,
  3: FIXED,
  4: NETWORK,
  5: UNKNOWN,
  6: UNKNOWN,
};

export function classifyDriveType(n) {
  return WIN32_DRIVE_TYPE[n] ?? UNKNOWN;
}

/** The Windows volume root for a path, e.g. `C:\`. */
export function volumeRoot(dir) {
  return parse(resolve(dir)).root;
}

function queryWindowsDriveType(dir, exec) {
  const root = volumeRoot(dir);
  const letter = root.replace(/[\\/]+$/, '');
  const cmd = `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}'").DriveType`;
  const out = exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  const n = Number.parseInt(String(out).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * What kind of volume is `dir` on?
 *
 * @returns {Promise<{kind: string, detail: string}>} `detail` is the raw evidence, kept so a
 *          refusal can be argued with rather than merely obeyed.
 */
export async function volumeKind(dir, io = {}) {
  const platform = io.platform ?? process.platform;
  const exec = io.exec ?? execFileSync;

  try {
    if (platform === 'win32') {
      const n = queryWindowsDriveType(dir, exec);
      if (n === null) return { kind: UNKNOWN, detail: 'the drive-type query returned nothing' };
      return { kind: classifyDriveType(n), detail: `Win32_LogicalDisk.DriveType=${n}` };
    }
    if (platform === 'linux') {
      // /sys/block/<dev>/removable is "1" for removable media. Resolve which block device backs
      // this path via /proc/mounts; if that cannot be read, fail closed.
      const mounts = (io.readFile ?? readFileSync)('/proc/mounts', 'utf8');
      const real = resolve(dir);
      const best = mounts
        .split('\n')
        .map((l) => l.split(/\s+/))
        .filter((c) => c.length >= 2 && real.startsWith(c[1]))
        .sort((a, b) => b[1].length - a[1].length)[0];
      if (!best) return { kind: UNKNOWN, detail: `no /proc/mounts entry covers ${real}` };
      const dev = best[0].replace('/dev/', '').replace(/\d+$/, '').replace(/^mapper\//, '');
      const flag = (io.readFile ?? readFileSync)(`/sys/block/${dev}/removable`, 'utf8').trim();
      return { kind: flag === '1' ? REMOVABLE : FIXED, detail: `/sys/block/${dev}/removable=${flag}` };
    }
    return { kind: UNKNOWN, detail: `no removable-media probe is implemented for ${platform}` };
  } catch (err) {
    return { kind: UNKNOWN, detail: `probe failed: ${err.message}` };
  }
}

/**
 * The decision, kept pure so it can be tested without a stick, a server, or a disk.
 *
 * @param {{kind: string, override?: boolean}} args
 * @returns {{ok: boolean, reason: string, overridden: boolean}}
 */
export function admitMedia({ kind, override = false }) {
  if (kind === REMOVABLE) {
    return { ok: true, reason: 'running from removable media', overridden: false };
  }
  if (override) {
    return { ok: true, reason: `OVERRIDDEN: running from ${kind} media`, overridden: true };
  }
  const why = {
    [FIXED]: 'it is running from a fixed disk',
    [NETWORK]: 'it is running from a network share',
    [UNKNOWN]: 'the type of the volume it is running from could not be determined',
  }[kind] ?? `the volume is "${kind}"`;
  return {
    ok: false,
    reason: `REFUSED: ${why}. This console administers a commons and is meant to run from the `
      + 'USB stick that holds its admin key. A console running from a copy behaves identically and '
      + 'is indistinguishable from the real thing, which is the case this gate exists to remove. '
      + 'If you are the operator and you mean to run it here anyway, pass --allow-fixed-disk.',
    overridden: false,
  };
}

/** The refusal banner, so the message the operator sees is the same one the tests assert. */
export function refusalBanner(kind, detail) {
  return [
    '',
    '  ============================================================',
    '   REFUSING TO START — this is not the USB stick.',
    '',
    `   Volume:  ${kind}   (${detail})`,
    '',
    ...wrap(admitMedia({ kind }).reason, 60).map((l) => `   ${l}`),
    '  ============================================================',
    '',
  ].join('\n');
}

function wrap(text, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else {
      line += ' ' + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}
