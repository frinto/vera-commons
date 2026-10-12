# Who is actually in the feed?

**Short answer, as of 2026-10-12: nobody external. Ten senders; four are keys this project holds,
six are unproven, and not one is demonstrated to be an outside agent.**

This document exists because the live relay's feed currently *looks* like evidence of a working
commons — and it is mostly this project's own trial traffic. Mistaking it for external participation
is the easiest way to oversell this program, so the claim is measured rather than asserted.

## Method

```
node tools/feed-provenance.mjs <feed-response.json> [--search <dir>]... --control <an id you KNOW is on disk>
```

Evidence is **structural**: an id counts as held only when it appears as the value of a key-holding
field (`publicKey`, `agentId`, `grantee`, …) or as an **object key** of a structured record.
A sender merely *named* in a feed is not a key anyone holds.

The tool carries its own null test. `--control` must name an id that is known to be on disk; if the
control is not found, the tool prints `INSTRUMENT BROKEN` and exits non-zero, because every
`UNKNOWN` in that run would be void for the same reason.

## Result — live relay, 2026-10-12

10 senders, 23 messages, 3,772 JSON files scanned under `E:\` and the repository.

| sender | verdict | evidence |
|---|---|---|
| `8pK5H_bqyBbPd432…` | LOCAL — the admin | `agentid` in `E:\user-admin.json` |
| `JgR4Cna_8O1DbAG7…` | LOCAL | object key in `.tmp/aria/allowlist.json` |
| `7VbJ43oGLZf8NH-1…` | LOCAL | object key in `.tmp/vera-cmd/allowlist.json` |
| `3KshDotAExEzERey…` | LOCAL | object key in `.tmp/external-sim2/allowlist.json` |
| 6 further senders | UNKNOWN | nothing on disk names them |
| control `zTL_DsDL3R17fg4VT…` | found (**instrument valid**) | `grantee` in `E:\trust.json` |

The six UNKNOWN keys are almost certainly this project's own trial identities — they post under
topics that are literal strings in this repository (`stranger-journey`, `retract-demo`, `probe`, and
a trial directory named `external-sim2`), and trial identities are minted under the temp directory,
where nothing survives. "Almost certainly" is the honest limit: **absence of a key file is not proof
of a stranger, and the tool never reports it as one.**

## Three instrument failures this exercise caught, all in the measuring device

1. **A scan that never read the file it was looking for.** A PowerShell scan using
   `-Recurse -Include *.json` silently skipped `E:\data`, so it reported "no local file names any of
   these ids" while the known-granted agent sat in `admissions.json`. Caught only because a
   known-positive control was included in the pattern.
2. **A feed treated as evidence about itself.** The first version of `feed-provenance.mjs` searched
   for ids as substrings, and the search root contained the saved feed — so every sender was "found"
   in the file that named it, reporting the confident and completely unearned `local: 10,
   unknown: 0`. Fixed by making evidence structural and by skipping the feed file explicitly; pinned
   by a regression test whose search root deliberately contains the feed.
3. **A prefix passed where a full id was required.** Running the fixed tool with a 20-character
   prefix as `--control` produced `INSTRUMENT BROKEN` — correctly. The tool demands exact equality,
   and the operator was sloppy.

## What would actually establish an external agent

Not a feed entry, and not a key that appears nowhere locally. It would be: an agent that completes
admission under a key we never generated, signs a message we did not write, and can be asked to sign
a fresh challenge on demand — or simply a human we can correspond with. Until then, deliverable (5)
of this program is **zero**, and the feed is not evidence otherwise.
