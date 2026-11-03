# Review lifecycle and contracts

[Documentation index](README.md) · [Reviewer overview](../README.md)

For maintainers and agents changing the harness. Setup and usage are covered in [getting started](getting-started.md).

## Lifecycle

1. **Prepare:** resolve fixed commits, retrieve the published reviewer and governing contexts, and write an evidence pack.
2. **Assess:** inspect code and submit passage-backed checks and a result for each criterion.
3. **Verify:** independently check the assessment, retaining or correcting supported conclusions.
4. **Report:** apply deterministic policy, persist artifacts, and deliver configured feedback.

The selected reviewer skill and its pinned contexts define the assessment authority.
The package accounts for every expected context; interpreted checks cite original passages.
One coherent assessment investigates both revisions and supporting source, interprets the
published requirements and submits a result for every original criterion. A separate verification
invocation checks findings, adherence and nonapplicability, including missing obligations and
permitted alternatives. There is no separate model planning session or automatic whole-review
semantic repair cycle. Code validates records and decides completion and exit; a model declaring
itself done cannot make missing judgments complete.

## Choose the reviewer and comparison

`--reviewer` takes a published `skill://...` ID, not a display name. Its instructions
provide the review lens; explicit context and domain selections plus required
context prerequisites determine the expected scope. The CLI retrieves exact
publication versions and reports missing, inaccessible or unsupported prerequisites.
Changing publications affects future runs, not the versions already recorded.

The reviewer contract consists of skill identity/metadata, review instructions,
`content.reviewer.selections` (explicit context IDs and domain selections with
`includeDescendants`), and optional supporting resources. Instruction-only reviewers
use the same contract with no assessment selections. Retired reviewer metadata is rejected. All maintained corpus reviewers use this
contract with intentional published criteria; empty scope stays instruction-only.

`--repo DIR` defaults to the current directory. `--base REF` and `--head REF` are
required and resolve once to fixed commit and tree IDs. The comparison is base
commit → head commit; it does not automatically choose a merge base. Use exact
commit SHAs for automation. Fetch both histories and their blobs before running;
partial clones can leave supporting source unavailable. Later branch movement,
working-tree edits and index changes do not alter the review. The source tools read
both snapshots and unchanged supporting files, with bounded responses and
continuations. They do not execute repository scripts, tests, hooks or model shell
commands. Binary files, submodule contents and conventional credential files have
explicit source-access limits; this is a text/source review, not runtime testing.

To check retrieval and scope without calling a model, replace `review` with
`prepare` and omit provider/model arguments. Inspect `state.json` and its gaps.
Preparation exit 0 means the scope was prepared; entries remain **not evaluated**.
Preparation exits 2 for invalid configuration or incomplete retrieval and never 1.

## Evidence and final corrections

The evidence pack focuses the review on all selected standards and prerequisites, with an ordinary
`diff.patch` and full permitted changed-file inventory. The reviewer can read any permitted file
in either pinned Git snapshot, including unchanged supporting code. Pack read tools expose governing
text with numbered citation segments; source read, list and search tools provide additional evidence.
The package keeps every original criterion as a result row without creating a session per criterion.
The independent final check evaluates the resulting set together. It can supply an evidence-backed
corrected criterion result in the same pass; the original proposal and correction remain in their
separate immutable phase records. Rejecting a finding alone never establishes a clean result.
Supported findings are accepted individually even when another obligation in that criterion remains
unresolved; rejected findings stay in the audit handoff rather than the published finding list.
Missing decisive checks remain unresolved. Their current explanation, correction and citations come
from verification, without retaining contradictory proposal text. A supported blocking finding still
blocks while completeness is reported separately. No additional assessor/verifier loop is introduced.
For missed defects or incorrect classifications, the verifier can submit a complete amended criterion
assessment with governing checks, source evidence and the final finding list. The amendment supersedes
the original criterion's findings, so it must retain all still-supported findings. Both versions remain
in their immutable phase records. The existing assessment validator checks its scope, citations,
check links and aggregate judgment. Amended findings can produce inline comments, but cannot carry
one-click code replacements because they have not had a separate patch verification.

Model citations select `{ref, startSegment, endSegment}` from numbered evidence segments,
using inclusive indices relative to that evidence record. Code extracts the exact quotation,
character offsets and source location; models do not supply quotation text. An explicit range
also identifies an occurrence when text repeats. Canonical reports retain quotations and provenance.
Selection failures identify the precise field and safe evidence identity in correction feedback
and diagnostics. Source bodies stay out of routine diagnostics. Selection bounds, exact text,
governing authority and independent verification remain enforced without extra correction rounds.

## Recovery and validation

The assessment session submits one complete context result at a time. The package retains each validated
result and reports the remaining context IDs; corrections cannot overwrite an accepted result. The
phase completes only when every assigned context is present. Retained partial progress is evidence
of an incomplete phase, never a verified assessment or a successful review.
Invalid submissions in one model response share a correction round; the session stops after three
invalid rounds. Every attempt consumes the global execution budget. Use one exact committed file
for scoped literal search, or omit the path for bounded whole-tree navigation.

Provider recovery allows at most two additional attempts per failed request, with 250ms then 500ms
backoff, for transport failures marked retryable by the SDK, HTTP 408/429/5xx and response
parsing/validation failures. It repeats only the failed model request with the existing conversation;
completed tools and accepted assessments are not replayed. A successful response resets the retry
allowance for the next request. Each request consumes the original
call/time/token budget, and cancellation interrupts the backoff. Authentication, credit-limit and
configuration failures stop immediately. Recovery is separate from submission correction and
unfinished-assessment continuation. `provider_retry`, `provider_recovered` and
`provider_retry_exhausted` events appear at info/debug verbosity. See [diagnostics](operations.md#health-logging-and-cost).
The observed token cutoff can overshoot by one call and is not a dollar ceiling.
Execution completion, assessment coverage, verification coverage and policy acceptance
are separate fields. Schema validity and exact citations do not prove a judgment correct.

Each phase persists input/output identities and evidence references. [Artifacts and resume](operations.md#inspect-evidence-and-resume) describes how these records support recovery.

The package exports `prepareReview`, `runReview`, `FixedSnapshotSource`, `McpPublishedReader`, provider constructors and policy helpers. Shipped type declarations describe their arguments; these APIs use the CLI's fixed-publication and source boundaries.
