/**
 * Does the stick carry a SECOND COPY of this project?
 *
 * `deploy-stick.mjs --check` compares the files this tool DEPLOYS, which makes it structurally blind
 * to a tree it never wrote. Measured 2026-10-12: a console started from E:\AgentCommons\ (a stale
 * second copy of this project, left on the volume by an earlier layout) held 127.0.0.1:7788 for
 * 7h19m, and on Windows two processes can hold ONE port -- so a later trial could have been answered
 * by THAT build while every check in this repository reported the deployment healthy. Nothing in the
 * repository could see it. This module is the rule that can.
 *
 * The rule is deliberately narrow, because a detector that cries wolf about the operator's own files
 * is a detector whose output nobody reads. A directory is reported only when BOTH hold:
 *   - it carries this project's own module path `src/admission.mjs`, and
 *   - at least one runnable entry of the same shape (`app.mjs`, `console/app.mjs`, `package.json`),
 *     because a copy that cannot start a console cannot serve stale code either.
 * So an unrelated Node app of the operator's (app.mjs + package.json, no src/admission.mjs) is NOT
 * reported, and neither is a folder of documents or a lone src/ with no entry point.
 *
 * Pure and read-only by construction: it takes a directory and returns findings. It writes nothing
 * and deletes nothing -- what a tree the tool did not create MEANS is the operator's ruling, never a
 * tool's.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// This project's own module path. Not a generic name: it is what makes the rule specific enough to
// stay silent about somebody else's application.
export const STRAY_SHAPE = 'src/admission.mjs';
// An entry point that could actually start a console from that folder.
export const STRAY_RUNNABLE = ['app.mjs', 'console/app.mjs', 'package.json'];

const seg = (p) => p.split('/');

export function findStrayCopies(root, { deployedTop = [], skipDirs = [] } = {}) {
  const skip = new Set([...deployedTop, ...skipDirs]);
  const found = [];
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return found;   // an unreadable or absent volume is the caller's verdict to make, not this rule's
  }
  for (const name of [...names].sort()) {
    if (skip.has(name)) continue;
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;   // a file we cannot stat cannot be a second copy of a project
    }
    if (!existsSync(join(dir, ...seg(STRAY_SHAPE)))) continue;
    const runnable = STRAY_RUNNABLE.filter((m) => existsSync(join(dir, ...seg(m))));
    if (runnable.length === 0) continue;
    found.push({ name, dir, marks: [STRAY_SHAPE, ...runnable] });
  }
  return found;
}
