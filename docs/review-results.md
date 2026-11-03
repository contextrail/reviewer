# Results and PR feedback

[Documentation index](README.md) · [Reviewer overview](../README.md)

Start with the outcome, findings and unresolved criteria. A successful execution and a complete assessment are different things.

## Interpret judgments and exit codes

Adherence and confidence answer different questions:

| Judgment             | Meaning                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adherence 0          | Supported non-adherence to the applicable criterion.                                                                                                    |
| Adherence 1          | Demonstrated partial adherence with a specific unmet criterion.                                                                                         |
| Adherence 2          | Supported adherence within the examined scope, including permitted alternatives that satisfy Guidance intent.                                           |
| Confidence 1 / 2 / 3 | The model reports low / medium / high confidence in the judgment, with an explanation of support and uncertainty. This is not a calibrated probability. |

Unresolved or not-evaluated entries have null scores. Reasoned not-applicable
entries have null adherence and may have confidence. Missing evidence is not a
violation or a zero. Citations establish where evidence came from; they do not
prove the model interpreted it correctly.

| Option                     | Policy effect                                                                                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--min-adherence 0\|1\|2`  | Adds a gate for evaluated applicable entries below this threshold. Binding violations and behavioral defects still block at lower thresholds. Omitted: no numerical adherence gate. |
| `--min-confidence 1\|2\|3` | Low or unavailable confidence makes an entry incomplete, including a not-applicable judgment. Independently verified blocking findings still block. Omitted: no confidence gate.    |
| `--advisory`               | Keeps findings but suppresses finding/adherence blockers. Unresolved scope, confidence shortfalls and execution/report failures still prevent success.                              |

By default, supported binding violations and behavioral defects block. A
discretionary Guidance departure alone does not block without an adherence gate.

| Review exit | Meaning                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **0**       | Completed bounded review accepted by the effective policy.                                                                                   |
| **1**       | At least one supported qualifying blocker. Other unresolved or unexamined entries can remain; inspect completion and scope even with exit 1. |
| **2**       | Incomplete review without a qualifying blocker, invalid configuration, execution failure, or failure to produce the required usable report.  |

An execution or required local-report failure returns 2 even when an earlier
blocker exists; `decision.reviewExit` preserves the underlying review judgment
separately from `decision.exitCode`. Feedback submission failure does not change
that exit. Neither preparation success nor advisory success erases the limits of
the underlying assessment.

## PR comments and inline corrections

The PR comment leads with the governed assessment outcome, verified findings and context
coverage. A complete table retains one row per original governed criterion, separating its
outcome from independent verification and counting only verified findings. Pending and
unexamined results remain explicit. A factual change summary uses the prepared file inventory,
with exclusions or unavailable inventory stated. Each finding identifies the criterion, code
location, consequence and correction; unresolved evidence needs remain separate. Prior runs, cost and brief diagnostics appear
in collapsed run details at the bottom. The Action job summary emphasizes operational
health, per-phase model/timing/usage and delivery outcomes.

Only verified binding violations and behavioral defects are eligible for inline comments; guidance remains in the summary.

Set `inline-comments: 'true'` alongside `post-comment: 'true'` to publish verified
findings on exact diff lines. Eligible corrections include GitHub suggestion blocks that
the developer can apply. Suggestions require independently accepted correction evidence,
an exact matching head range and valid diff anchor; source inspection is not test execution.
Uncertain, overlapping, deletion-only or multifile corrections remain explanatory findings.
Nothing applies patches or commits automatically.

Inline publication uses COMMENT reviews, retains existing threads and deduplicates matching
findings. It does not approve, request changes, resolve threads or treat a human resolution
as proof of a fix. Incomplete duplicate lookup stops new inline writes. Unanchorable findings,
rejected batches and items beyond the bounded inline batch remain in the main report.
A superseded comparison is attributed to its reviewed commit, not claimed as current.

Reusable CLI adapters are `contextrail-review github prepare` and `github publish`;
see `--help` for required paths/options. `github publish --dry-run` creates inspectable
payloads without network writes. Provider credentials do not reach these adapter commands,
and GitHub write tools are never exposed to models.

The full criteria table and change inventory are collapsed in the PR comment; run details and prior reviews are footnotes.

## Review history and conversational context

The bot comment keeps a versioned, bounded state record in an HTML comment and a visible
history table in collapsed run details at the bottom. It retains ten reported runs with GitHub run/attempt links, unique CLI run IDs, exact work
revisions, requested model, package/reviewer versions, execution/completion, finding/unresolved
counts, duration and reported cost. Rerunning the same attempt replaces its row; later attempts
add rows. A failed provider run does not erase the last finished assessment. That snapshot
retains up to 30 criterion identities/publication versions and short findings/unresolved reasons.
Older rows, skipped/comment-write failures and runs before adoption may be absent; the table
links to GitHub's full workflow history. This is a convenience cache, not an exhaustive ledger.

Hidden comments are readable, mutable PR content, not private storage, a signature or proof
that a review passed. The Action reads only the matching bot-owned record, validates its
version/repository/PR/reviewer and bounds its contents. Unsupported or corrupt state is treated
as unavailable rather than trusted. PR comments persist independently of artifact retention.

With `pr-context: 'true'`, a trusted read-only step collects recent 20 issue comments, 10 submitted
reviews (including dismissed states), 10 dismissal events with reasons, and 10 native review threads with five replies each,
including resolution/outdated state and authorship. At most 80 excerpts are supplied, with bodies capped at 1000 characters.
The matching CLI's `--pr-context PATH` reads a schema-validated file capped at 200 KiB, bound to
the current base/head/reviewer and reported GitHub repository. Prior assessment/head identities,
criterion versions and up to 100 changed paths since that head are included when available.
Missing history, pagination/truncation, inaccessible revisions and non-forward/force-push
comparisons are explicit. There is no whole-repository snapshot mode or automatic new review trigger.

Context is passed as a separate untrusted data field, never as caller purpose or governing
instructions. Native approval, dismissal or thread resolution does not waive a Standard or
prove a fix. The reviewer still accounts for every current criterion using current pinned
source/publications; historical outcomes never pre-populate current results or change exit policy.
Developer feedback can focus inspection and explain an addressed finding only with fresh evidence.
Work, guidance and model revisions remain distinct; changed judgment alone does not establish drift.
No tools for changing code, resolving threads or approving a PR are added.

Opting in sends these PR excerpts and historical judgments to the selected model. GitHub tokens
stay in trusted Action steps; known credentials are redacted before the model handoff. The raw
collector file is not uploaded. A validated/redacted context snapshot and hash accompany the
local run/audit; conversation bodies are excluded from the minimal ContextRail report projection.
The health summary identifies supplied discussion/history coverage. Adopt both the new Action
SHA and a CLI release supporting the input; an old package must not silently ignore the feature.

For timing, cost, logs and evidence files, see [operations](operations.md).
