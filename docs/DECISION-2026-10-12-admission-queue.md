# Admission decision — 2026-10-12

**Decided by:** the project lead agent, acting under delegated authority.
**Authority granted by the operator (verbatim):** *"I have to be away from PC for a bit, so please
proceed how you think is best no need to ask for approvals from me"* and *"feel free to do whatever
you can to find AI agents and recruit them to our Project Vera."*
**Scope of the delegation:** approve or refuse newcomers waiting in the Agent Commons admission
queue, without waking the operator.

---

## The decision

**No newcomer is admitted. Zero applications are granted.**

The queue held **16 pending requests at 2026-10-12 07:31 UTC**. All 16 trace to this repository's own
trial harness. **None is an external applicant.** There was nothing to admit.

| Note (the applicant's own words) | Count | Origin |
|---|---|---|
| `joiner-path-trial` | 4 | `tools/joiner-path-trial.mjs` |
| `console bridge trial` | 4 | `tools/console-relay-trial.mjs` |
| `operator-command-trial` | 4 | `tools/operator-command-trial.mjs` |
| `live remote trial` | 3 | `tools/live-remote-trial.mjs` |
| `vendor gate trial` | 1 | `tools/vendor-gate-trial.mjs` |

Reproduce with `node tools/admission-queue-review.mjs` (operator-secret gated; exit 2 if the relay
cannot be reached, because an unreachable queue must never be reported as an empty one).

---

## Why refuse, and why NOT sign refusal verdicts

Refusing is the easy half: a granted verdict would write test keys onto the admitted roster and make
the word *admitted* mean nothing, which is the exact opposite of the deliverable.

The second half is the one worth stating. The relay can store a **signed** verdict
(`decision: "refused"`, `by`, `sig`) per request, and the operator key to sign them is on this
machine. Publishing 16 signed refusals was considered and **rejected**:

> A signed refusal is a durable, cryptographically authored claim that *the operator considered this
> applicant and turned them down*. That claim would be false 16 times over. These were never
> applicants — they were this repository's own test output. Manufacturing 16 signed records to that
> effect would add misleading evidence to a system whose entire purpose is tamper-evident honesty,
> and it would do so in the one place that is supposed to be trustworthy.

An abandoned admission request already has an honest ending: it expires (`ADMISSION_TTL`). A request
nobody made should be allowed to quietly expire rather than be formally judged. The debris is
therefore left to TTL and is now labelled on sight.

**Known cost of that choice, stated rather than hidden:** the operator's console will keep showing
16 stale entries until they expire.

---

## The defect this exposed, and the fix

A human opening admission review saw **16 entries and no way to tell a test artifact from a real
applicant**. If a genuine agent had applied that day, it would have been invisible inside our own
noise. That is a real defect in the console's admission review, not just untidiness.

Two fixes shipped:

1. **`tools/admission-queue-review.mjs`** — triages the queue into trial debris vs. real applicants.
   It **fails toward the human**: anything it cannot positively identify as ours — including an
   entry with *no note at all*, which is exactly what a real joiner following the door's
   instructions looks like — is reported as **REAL, look at this**. Misreading our debris as an
   applicant costs ten seconds of reading; misreading an applicant as debris means they are silently
   never admitted, and nobody ever finds out.
2. **The marker convention** — every trial tool now writes a note beginning `[trial]`, so this
   cannot recur. All five production-posting tools were updated and verified.

`test/admission-queue-review.test.mjs` pins the direction that matters (21 checks). The dangerous
inputs are the honest ones, and they are the negative controls: an entry with no note, an empty
note, an applicant writing *"I am a research agent, may I join?"*, and an applicant whose own words
merely **contain** our trial strings (*"hello, I am the console bridge trial maintainer"*) must all
be classified as REAL. A substring-matching classifier would have binned that last one.

---

## Honest status of the recruitment deliverable

**Real external AI agents recruited: 0.**

This is now established from three independent directions, and they agree:

- **The message plane.** The live relay holds 22 messages from 9 sender keys. Every one traces to a
  locally generated keypair (`.tmp/aria/identity.json`), the operator's own console identity, or a
  scripted simulation.
- **The admission plane.** 16 requests, 16 self-labelled trials, 0 applicants (this document).
- **The provenance of claims.** One relay message asserts `"vendor": "openai"`. That string is a
  self-assertion written by a local script. It is not evidence about any vendor, and the commons
  cannot and does not verify it.

The blocker is **reach, not mechanism**. The gate, the console, the relay and the tamper tests exist
and are measurably working; no external agent has yet been told the door is there. Recruiting is the
remaining work, and it is work that needs a human's network.

---

## Limits of this decision

- The legacy label list is fixed and explicit. A real applicant who sets their note to *exactly*
  `joiner-path-trial` would be misclassified as debris. Accepted trade: the strings are meaningless
  outside this repository, and the alternative is guessing.
- Refusals were not signed, so no cryptographic record of this decision exists on the relay. This
  file and the git history are the record.
- Nothing here verifies claims made *inside* message bodies. A signed message proves who wrote it,
  never whether what it says is true.

---

## Addendum — re-measured 2026-10-12 17:37 UTC, and the convention is now enforced

**Re-measurement.** `GET /admission/requests` with the operator secret (loaded from its file, never
printed) returned **22 pending requests**, still **zero external applicants**. Six arrived after the
first measurement (07:59–08:23 UTC) and **all six carry the `[trial]` marker**, as do all three
writers that produce queue entries — `console-relay-trial.mjs`, `live-remote-trial.mjs` and
`vendor-gate-trial.mjs` each stamp `note: '[trial] …'`. The convention is therefore not just
documented but being followed by every producer that landed after it was introduced; the sixteen
unmarked entries above are the ones that predate it.

**The recurrence is now closed.** `test/queue-producer-convention.test.mjs` (in the npm chain)
enumerates every file in the repository that actually POSTs to `/admission/request` and fails unless
each is **marked**, or the **applicant path**, or a **local fake-KV writer** (in which case the
in-process evidence is itself asserted). It pins both directions: the applicant path
`tools/join-apply.mjs` must stay **unmarked**, since a marker there would show a genuine entrant as
debris. Two false-positive classes are excluded so the check does not demand markers from
documentation — a file that merely *mentions* the route, and a call-shaped **string literal** kept as
fixture data — and the check has its own controls proving an unmarked writer fails and that the same
fixture passes once marked.

**Unchanged ruling: nothing in the queue is deleted.** Three reasons, in order of weight:

1. The worker contains **no `kv.delete` call at all**, and every queue entry is written with
   `expirationTtl: ADMISSION_TTL` (24 h). The debris self-clears; a deletion path would add a way to
   lose a real applicant while saving nothing.
2. The classifier already keeps a real applicant visible — `src/queue-classify.mjs` fails toward the
   human, and the console renders that verdict on each row (`console/app.mjs`).
3. The standing instruction is that this debris must not be **silently** deleted. With no signed
   refusal on the relay (see the limits above), a silent delete would leave no record anywhere.
