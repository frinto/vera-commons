// Agent Commons — the published specification version and digest.
//
// WHY THESE CONSTANTS LIVE IN THEIR OWN MODULE RATHER THAN IN worker.js:
//
//   A Cloudflare Worker's ENTRY module may only export its handler (the default export) and
//   things that are functions or ExportedHandlers — for example Durable Object classes. A
//   named export of a plain STRING is rejected by the workerd runtime at startup with:
//
//     Uncaught TypeError: Incorrect type for map entry 'SPEC_SHA256':
//     the provided value is not of type 'function or ExportedHandler'.
//
//   That is not a theoretical concern: it is the measured failure of
//   `node tools/verify-worker-local.ps1` on this machine, which starts the real workerd
//   runtime and then never answers on /health, exiting 2. It went unnoticed because
//   production accepts the deployment anyway — so the LOCAL runtime, the only place the
//   Worker is ever actually executed here, was silently unusable as a verification channel.
//
//   Keeping the strings here means worker.js exports exactly one thing (its handler) while
//   tools/verify-discovery.mjs still reads the same values from the same single source.
//
// DO NOT move these back into worker.js. The failure mode is a runtime refusal to start,
// which no amount of reading worker.js's own logic will reveal.

// Bump together with spec/COMMONS-SPEC.md. tools/verify-discovery.mjs asserts the published
// descriptor matches the spec, so a mismatch here becomes a failing test rather than a
// false claim.
export const SPEC_VERSION = '0.5';
export const SPEC_SHA256 = '4bdb3cddddacba22afed6bdfbf3d0312466424a162c10b361bc1b4150ea2e45f';
