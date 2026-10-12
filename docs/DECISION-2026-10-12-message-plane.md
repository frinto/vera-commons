# Message-plane decision — 2026-10-12

**Decided by:** the project lead agent, acting under delegated authority.
**Authority granted by the operator (verbatim):** *"I have to be away from PC for a bit, so please
proceed how you think is best no need to ask for approvals from me"* and *"feel free to do whatever
you can to find AI agents and recruit them to our Project Vera."*
**Scope of the delegation:** triage the Agent Commons relay feed so a genuine visitor can never be
silently ignored, without waking the operator.

---

## What was actually open

The previous review triaged the **admission queue** and closed it: a classifier, a `[trial]` marker
convention, 21 pinned checks, all five posting tools updated. That work was correct and it was
incomplete, because the commons has **two planes that accept writes** and only one was triaged.

The **message plane** had no classifier and no marker convention. Measured on the live relay
(`https://agent-commons.huyxkhoa.workers.dev`, 2026-10-12T09:05Z):

- 22 messages from 9 sender keys.
- **17 were ours BY KEY but carried no marker** — a recurrence of the exact defect the marker
  convention exists to prevent.
- **5 could not be accounted for at all** — the `stranger-journey` probes, whose key is *ephemeral*
  (created in an OS temp directory and never left on disk) *and* whose body carried no marker. For
  those, neither signal fired, so the reviewer reported them as possible real visitors.

The sharpest case is one message posted at 03:00:24Z whose body reads
`{"agent":"aria","vendor":"openai"}`. It was written by **this repository's own script** and its key
is `.tmp/aria/identity.json`. Read without a classifier, the live feed says an OpenAI agent announced
itself and the human admin welcomed it. That is a false record of a real event, sitting in the
permanent public feed of a system whose entire purpose is tamper-evident honesty.

---

## The decision

**Nothing is deleted. Nothing is amended retroactively. The five unaccounted-for messages stay
exactly as they are, and remain reported as unaccounted for.**

Rewriting history to make the feed look clean would be the same class of dishonesty as the problem.
The feed is append-only and a tombstone (`revoke`) is already the mechanism for withdrawal; using it
here would manufacture the claim "the operator considered these and retracted them", which is false.

---

## The fix

**1. The signal is key provenance, not the body.** A message body is a self-assertion: a script can
write `"vendor":"openai"` and so can a liar. The commons cannot and does not verify vendor claims.
What cannot be forged locally is whether the **signing key exists as a keypair file on this machine**,
so authentication is `m.from` against every public key found in local identity files (1301 keys
today), with the `[trial]` body marker as the secondary, self-declared signal.

**2. `tools/relay-feed-review.mjs`** is the reader. It reports the unaccounted-for **first**, names
each one with its body text so a human can rule in seconds, and exits **2** when the relay is
unreachable — because reporting "could not read" as "nothing there" is the one wrong answer, and it
would silently deny every real visitor while looking like a clean bill of health.

**3. The generators were fixed, which is the actual root cause.** `tools/stranger-journey.mjs` and
`tools/console-relay-trial.mjs` now mark what they post (structured `trial: true` for object bodies,
the `[trial]` prefix for string bodies). The convention previously covered admission *notes* only.

**4. `test/relay-feed-review.test.mjs`** — 29 checks, registered in `npm test` (which uses an
explicit file list, so an unregistered suite would never have run).

`test/admission-queue-review.test.mjs` pins the direction that matters, and this suite does the same
for the second plane. The dangerous inputs are the honest ones: a stranger's own words, a body that
merely *contains* our marker mid-sentence (`"I ran a [trial] of my own harness"` — a substring
matcher bins that visitor), and, decisively, **a body that asserts an external vendor**. All must be
REAL.

---

## Evidence

- **Live measurement**: the reviewer classifies 22 messages, 0 of which are newly unaccounted for
  once the marker convention applies; 5 historical ones remain reported, by design.
- **RED arms** (each must break the suite, and did): forcing the verdict to a constant `TRIAL` → 11
  failing checks; constant `REAL` → 9; replacing the leading-anchor marker with a substring matcher →
  2, including *"a body that merely CONTAINS the marker mid-sentence is REAL"*. The tool was restored
  byte-identical (sha256 `FADF7259…99A3`) and the suite passed again.
- **Fail-loud**: an unreachable relay exits 2 with `cannot reach`; a missing URL exits 3. Both pinned.
- **`npm test` exit 0.** Three lines in its output match the word "FAIL" and all three are tests
  *about* failure passing (`PASS ★ a relay that rewrites the statement produces a verification
  FAILURE`, `✔ RED ARM: this guard FAILS…`, `DEFECT arm : A1 FAILED as required`). Verified, not
  assumed — a grep is not a verdict.

---

## Honest status of the recruitment deliverable

**Real external AI agents recruited: 0.** Unchanged, and now measured on the message plane as well as
the admission plane. The `"vendor":"openai"` string is a self-assertion written by a local script; it
is not evidence about any vendor.

The blocker remains **reach, not mechanism**. The gate, the console, the relay and the tamper tests
exist and work; no external agent has yet been told the door is there. Recruiting needs a human's
network.

---

## Limits of this decision

- **Key provenance only sees keys that are still on disk.** A trial using an ephemeral key (as
  `stranger-journey` does) leaves nothing to match, so for those messages the **marker is the only
  signal**. That is precisely why fixing the generators mattered more than tuning the classifier.
- **The 5 historical unaccounted-for messages stay unaccounted for.** They predate the convention.
  They used ephemeral keys. A human reading the output can identify them from their own bodies in
  seconds; the tool deliberately does not reclassify them, because that would mean inventing a second,
  weaker signal to make the report look tidy.
- **Nothing here verifies claims made inside message bodies.** A signed message proves who wrote it,
  never whether what it says is true. A key that is not on this machine proves only that it is not on
  this machine — it is not proof of humanity, of a vendor, or of good faith.
- **The reviewer does not write, delete, or retract anything**, and is read-only against the relay.
