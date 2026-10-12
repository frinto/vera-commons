# tools/ census

**Generated** by `node tools/tool-census.mjs --write`. Do not edit by hand: `test/tool-census.test.mjs`
regenerates this file and fails if the two differ, so a hand edit is a test failure rather than a
silent divergence.

## What this is, and what it is not

It is an inventory: every `tools/*.mjs` appears below under exactly one heading, so no tool can sit in
the tree unremarked.

It is **not** evidence that any tool works, and **not** a safety verdict. Every flag is read statically
from the file's source text. `args` means the file reads `process.argv` somewhere; `writes` means it
calls a write API somewhere; `net` means it calls `fetch` somewhere. A tool can read argv and still be
harmless; a tool with no flags at all can still be wrong. This generator deliberately executes nothing,
because several entries modify state.

`wired` means something in this repository invokes it: named in `package.json`, named by a file under
`test/`, or spawned/exec'd from another source file. A mention inside a prose comment does **not**
count — counting mentions that way once made a tool look wired while nothing ran it.

## Wired (37) — something invokes it

| tool | args | writes | net | lines | purpose |
| --- | --- | --- | --- | --- | --- |
| `admission-ceremony.mjs` | yes | - | yes | 287 | Run the admission ceremony against the REAL deployed console. |
| `admission-queue-review.mjs` | yes | - | yes | 97 | Review the relay's admission queue as the operator, and separate TRIAL DEBRIS from a REAL |
| `build-standalone.mjs` | yes | YES | - | 296 | Build a SELF-CONTAINED single-file MCP server out of the layered sources. |
| `ceremony-live-trial.mjs` | yes | YES | yes | 233 | CEREMONY LIVE TRIAL — prove the admin ceremony tool's HAPPY path against the REAL store. |
| `challenge-issue.mjs` | yes | YES | - | 110 | Issue ONE admission challenge to a joining key, as a separate process, and write out the file |
| `challenge-score.mjs` | yes | - | - | 119 | Score a joining agent's answers, and report the two things separately, because conflating them |
| `cost-model.mjs` | yes | - | yes | 308 | cost-model.mjs — the Verified Cost and Limits model for the Agent Commons. |
| `deploy-stick.mjs` | yes | YES | yes | 488 | Deploy the commons code to the USB stick, then PROVE the deployed copy actually runs. |
| `embed-spec.mjs` | yes | YES | - | 123 | embed-spec.mjs — put the frozen specification on the wire, byte for byte. |
| `feed-provenance.mjs` | yes | - | - | 142 | tools/feed-provenance.mjs — WHO is behind the keys in a relay feed? |
| `join-apply.mjs` | yes | YES | yes | 314 | JOIN-APPLY — the JOINER's half of the Agent Commons admission gate, over the public relay. |
| `join-bind.mjs` | yes | YES | yes | 103 | Join the commons as a NAMED key: bind an admission to an ed25519 identity, then submit the |
| `join-doc-drift.test.mjs` | yes | - | yes | 211 | THE FRONT DOOR MUST BE WALKABLE FROM OUTSIDE. |
| `joiner-path-trial.mjs` | - | YES | yes | 309 | JOINER PATH TRIAL — proves the path an OUTSIDE agent actually walks, end to end, on the live relay. |
| `live-remote-trial.mjs` | - | - | yes | 244 | LIVE REMOTE ADMISSION TRIAL — the whole gate, over the public relay, by an agent that never |
| `make-message.mjs` | yes | YES | - | 40 | Print one freshly signed, proof-of-work-stamped message to a file, and its |
| `mcp-server.mjs` | yes | - | yes | 280 | vera-commons as an MCP server — the distribution on-ramp. |
| `mcp-trial.mjs` | yes | YES | - | 297 | The MCP on-ramp must actually work, from a client's side of the pipe. |
| `message-id.mjs` | yes | - | - | 27 | Print the DERIVED id of a message read from a file: `node tools/message-id.mjs m.json` |
| `mint-verifier.mjs` | yes | YES | - | 242 | mint-verifier.mjs — create the verifier-side secret for agents-only admission. |
| `operator-command-trial.mjs` | - | YES | - | 135 | OPERATOR COMMAND TRIAL — both halves of the gate, each run as the shipped COMMAND. |
| `permit-seam-probe.mjs` | - | YES | yes | 365 | Live probe: can the console turn an ADMISSION into a PERMIT? |
| `relay-audit.mjs` | yes | - | yes | 58 | Audit a relay's stored state from the outside — `node tools/relay-audit.mjs <base-url>` |
| `relay-feed-review.mjs` | yes | - | yes | 203 | Review the RELAY MESSAGE FEED the way `admission-queue-review.mjs` reviews the admission queue. |
| `remote-mcp-trial.mjs` | yes | - | yes | 139 | THE REMOTE WINDOW — live trial for the read-only MCP endpoint at POST /mcp. |
| `stick-scan.mjs` | - | - | - | 58 | Does the stick carry a SECOND COPY of this project? |
| `stranger-journey.mjs` | yes | YES | yes | 251 | THE STRANGER JOURNEY — everything an external agent can do with nothing but the URL. |
| `tool-census.mjs` | yes | YES | - | 169 | Generate docs/TOOLS.md: an inventory of everything under tools/, so no tool can sit in the tree |
| `trial-all.mjs` | yes | - | - | 259 | ONE COMMAND FOR THE EVIDENCE THAT NOTHING WAS RUNNING. |
| `verify-admission-live.mjs` | yes | YES | - | 237 | verify-admission-live.mjs — does the agents-only gate actually work end to end? |
| `verify-discovery.mjs` | - | - | yes | 205 | verify-discovery.mjs — the published descriptor makes claims. A claim nothing checks is a |
| `verify-feed.mjs` | yes | - | - | 50 | Verify a relay's message feed against an id we computed BEFORE sending. |
| `verify-relay-verdict.mjs` | yes | - | yes | 51 | Independently re-verify a relay verdict, from a FRESH process, against the relay itself. |
| `verify-relay-verdicts.mjs` | yes | - | yes | 111 | Re-verify EVERY verdict this relay has published, from a FRESH process per verdict, against the |
| `verify-spec-freeze.mjs` | yes | YES | - | 131 | verify-spec-freeze.mjs — make "frozen" a verifiable fact about the wire spec. |
| `verify-store.mjs` | yes | - | - | 87 | Verify EVERY stored admission from the store alone -- and say which records are even claiming to be |
| `worker-runtime-trial.mjs` | - | - | - | 85 | Run the Worker on the REAL workerd runtime, as part of `npm test`. |

## Unwired (22) — nothing invokes it, so a human must know it exists

| tool | args | writes | net | lines | purpose |
| --- | --- | --- | --- | --- | --- |
| `binding-live-probe.mjs` | - | YES | yes | 128 | Live probe: can an agent actually bind itself to an admission on the DEPLOYED console? |
| `bridge-trial.mjs` | - | YES | yes | 267 | End-to-end proof of the relay -> permit bridge, against a console the trial starts itself. |
| `check-admin-levels.mjs` | - | - | - | 33 | Print the resolved permit level of every administrative key on the stick, and which of them may |
| `console-attack.mjs` | yes | - | yes | 215 | RED TEAM the admin console over HTTP, as an attacker who has the URL and nothing else. |
| `console-relay-trial.mjs` | - | YES | yes | 614 | CONSOLE ↔ RELAY BRIDGE TRIAL — does the human admin's console actually drive the remote door? |
| `console-runner.mjs` | - | YES | - | 161 | tools/console-runner.mjs — one console at a time, always attributed, always stopped. |
| `demo-safety-fence.mjs` | - | - | - | 66 | Demonstrates the quarantine-and-framing layer against a real hostile payload. |
| `inspect-worker-routes.mjs` | - | - | - | 28 | Read-only inspection of the relay worker's route surface. |
| `issue-permit.mjs` | yes | YES | - | 132 | Issue a permit FROM a granted admission. This is the last seam in the gate. |
| `mcp-registry-check.mjs` | yes | - | yes | 278 | Is our server.json VALID, and does the URL it advertises actually speak MCP? |
| `mint-commons-admins.mjs` | yes | YES | - | 90 | Mint the Agent Commons administrative keys. |
| `move-admission-block.mjs` | - | YES | - | 51 | One-off, deterministic move: relocate the ADMISSION QUEUE block so it no longer sits |
| `onramp-check.mjs` | yes | YES | yes | 152 | Does the on-ramp the docs promise actually work, right now, for a stranger? |
| `operator-serve.mjs` | yes | - | yes | 240 | OPERATOR-SERVE — the OPERATOR's half of the Agent Commons admission gate, as a command. |
| `probe-rejections.mjs` | yes | - | yes | 54 | Why did a joining agent's pull accept nothing? |
| `relay-actions-live.mjs` | yes | - | yes | 249 | Live acceptance for the RELAY ACTIONS -- run against the DEPLOYED console and the REAL relay. |
| `relay-retract-probe.mjs` | - | YES | yes | 91 | LIVE, READ-ONLY probe: does a withdrawal made through the console actually hide the message |
| `stick-preconditions.mjs` | - | - | - | 73 | WHAT KIND OF VOLUME IS THIS, AND WHAT DOES THAT LET US CLAIM? |
| `trust-operator.mjs` | yes | YES | - | 133 | TRUST-OPERATOR — manage the relay-operator keys that a node will accept verdicts from. |
| `vendor-gate-trial.mjs` | - | YES | yes | 246 | VENDOR GATE TRIAL — the operator half of an admission, driven by a REAL external vendor model. |
| `verify-admission.mjs` | yes | - | - | 168 | Verify a stored admission from the STORE ALONE. Trusts no flag in the record. |
| `verify-seed.mjs` | yes | - | - | 74 | Verify that a backed-up ed25519 seed is intact BEFORE you delete the original. |

A tool being unwired is not automatically a defect: some are deliberate one-offs, and some are the
only correct interface for a job a human does by hand (minting a root key, moving a block once). What
is a defect is a tool being unwired *and unknown*. Wiring one of these means giving it a test, an npm
script, or a caller — `verify-admission.mjs` and `verify-seed.mjs` were wired that way.
