/**
 * ONE definition of where a verifier's admissions store lives.
 *
 * This rule exists in exactly one file on purpose. When the minter, the gate and the console each
 * carried their own copy of it, they were free to disagree — and the disagreement would have been
 * SILENT. The console would have read an empty store while the gate wrote to a full one, and both
 * halves would have reported success. A shared import makes that class of bug unrepresentable.
 *
 * THE RULE: a relative `dir` resolves against the directory that CONTAINS verifier.json.
 *   - NOT the app folder: that path differs between the dev tree and the stick.
 *   - NOT the process working directory: that is wherever the user happened to launch from.
 * The verifier's own directory is the only base that stays correct across machines, across drive
 * letters (E: here, D: elsewhere) and across launch methods.
 *
 * An ABSOLUTE `dir` is refused rather than honoured. It resolves on the machine that minted it
 * and fails everywhere else, which is the worst possible failure mode for a file that travels on
 * a USB stick: it works perfectly until the day it silently does not.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/** Throws on anything that would not survive the stick being mounted under a different letter. */
export function resolveAdmissionsDir(verifier, verifierPath) {
  if (typeof verifierPath !== 'string' || verifierPath === '') {
    throw new Error('verifier-path: verifierPath is required to resolve a relative dir');
  }
  if (verifier === null || typeof verifier !== 'object') {
    throw new Error('verifier-path: verifier must be an object');
  }
  const dir = verifier.dir;
  if (typeof dir !== 'string' || dir === '') {
    throw new Error('verifier-path: verifier has no "dir" — refusing to guess a fallback');
  }
  if (isAbsolute(dir)) {
    throw new Error(
      `verifier-path: refusing the absolute dir "${dir}". An absolute path resolves on the machine ` +
        'that minted it and fails on every other, which is exactly the failure a stick must not have. ' +
        'Re-mint with a stick-relative dir such as "data/admissions".',
    );
  }
  return resolve(dirname(verifierPath), dir);
}

/** Reads and shape-checks a verifier file. Never echoes parser output into the error. */
export function loadVerifierFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Deliberately does not embed the underlying error: it can carry fragments of the file.
    throw new Error(`verifier-path: cannot read ${path}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`verifier-path: ${path} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`verifier-path: ${path} is not a JSON object`);
  }
  const chains = parsed?.kb?.chains;
  if (!Array.isArray(chains) || chains.length === 0) {
    throw new Error(`verifier-path: ${path} has no knowledge base`);
  }
  if (typeof parsed.salt !== 'string' || parsed.salt.length < 16) {
    throw new Error(`verifier-path: ${path} has no usable salt`);
  }
  return parsed;
}
