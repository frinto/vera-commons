// NEGATIVE CONTROL for test/standalone.test.mjs. Do not "fix" this file.
//
// This is `src/server.mjs` with the ORIGINAL, Windows-broken main-module guard
// restored verbatim:
//
//     if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
//
// `import.meta.url` is `file:///C:/...` (three slashes). The template builds
// `file://C:/...` (two). They are never equal on Windows, so the block never
// runs, the process exits 0, and nothing ever listens — with no error, no
// output, and a success exit code.
//
// A test that cannot fail proves nothing. test/standalone.test.mjs must PASS
// against ../src/server.mjs and FAIL against this file:
//
//     node test/standalone.test.mjs
//     COMMONS_SERVER=test/broken-main-guard.mjs node test/standalone.test.mjs   # must FAIL
//
// If the second command ever passes, the regression test has stopped testing
// anything.

import { createCommonsServer } from '../src/server.mjs';

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const srv = createCommonsServer({ dir: arg('dir', '.node') });
  srv.listen(Number(arg('port', 8787)), '127.0.0.1', () => {
    console.log('this line is unreachable on Windows — that is the entire point');
  });
}
