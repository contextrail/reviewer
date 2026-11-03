# ContextRail reviewer

Review Git changes against your team's published organizational guidance. Use the
reviewer before merging a change when you want to see which local requirements it
meets, where it departs from guidance, and which judgments need more evidence.

You choose a published reviewer, explicit model configuration, and two commits. The npm
package fixes the reviewer's selected contexts and prerequisites at their published versions,
prepares changed hunks deterministically, and runs assessment and independent
verification before deterministic policy and reporting. Models can differ by phase.
It writes findings, separate adherence and confidence judgments, and cited evidence
into local reports. Open `report.md` to read the result and inspect its evidence.
These are bounded model judgments; a completed review does not certify compliance
or establish that every defect was found.

## Moving to governed phases

This implementation continues the `@contextrail/code-review-agent` package name. The
published `0.1.x` versions are the earlier reviewer and remain available by exact version.
This is a replacement, not a drop-in upgrade: use the `contextrail-review` executable
and the configuration below, rather than the old `code-review-agent` command. It requires
Node >=22.18.0 and current ContextRail MCP credentials. Existing reports and configuration
are not automatically migrated. The phased workflow writes local report/state schema version 2.
Update paired Action/package pins after publication; prior bot history remains readable.
Original published reviewer instructions remain authoritative. Optional linked specialist skills
are not fetched or invoked; internal model phases apply the same selected reviewer and pinned
contexts. Capability descriptions are not interpreted by English phrase-matching policy.

## Install and run

Requires **Node >=22.18.0**, **Git >=2.45**, a Git repository with both commits and
supporting objects available, authorized access to ContextRail MCP, and a provider
API key. Your ContextRail administrator supplies the endpoint, organization ID,
bearer token and published reviewer ID. The reviewer must select published contexts;
an instruction-only reviewer cannot supply this CLI's assessment scope.

Install an exact published version from public npm (alpha versions use npm's `alpha` channel).
The package is Apache-2.0 licensed. This source checkout's selected version is
`1.0.0-alpha.6`; its immutable export attribution is in `release.json`.

```sh
npm install --ignore-scripts @contextrail/code-review-agent@1.0.0-alpha.6
./node_modules/.bin/contextrail-review --help
```

To validate this public checkout without publishing, use `pnpm install --frozen-lockfile`,
then `pnpm run typecheck`, `pnpm run lint`, `pnpm test`, `pnpm run build` and `npm pack`.

Run from that consumer. Replace the nonsecret example values below. Supply actual
credentials through your secret manager or exported process environment; avoid
putting them in shell history. The CLI **does not load `.env` files**.

```sh
export CONTEXTRAIL_MCP_URL='https://YOUR_CONTEXTRAIL_HOST/mcp'
export CONTEXTRAIL_MCP_ORG_ID='YOUR_ORGANIZATION_ID'
# Export CONTEXTRAIL_MCP_AUTH_TOKEN and OPENAI_API_KEY securely before running.
./node_modules/.bin/contextrail-review review \
  --reviewer skill://your-domain/your-reviewer \
  --repo /path/to/your/repository --base BASE_COMMIT_SHA --head HEAD_COMMIT_SHA \
  --provider openai --model YOUR_OPENAI_MODEL_ID
```

The final console JSON gives the run directory, report path, completion and decision.
Read `.contextrail/reviewer/<run-id>/report.md` in the reviewed repository. Check
scope, unresolved entries, citations, confidence reasons and the effective policy
before acting. The CLI exits with the result described below.

The executable is **`contextrail-review`**. Package stewardship belongs to ContextRail;
public source is [contextrail/reviewer](https://github.com/contextrail/reviewer).
Development and version selection happen upstream; this repository is a one-way distribution
mirror. Submit contribution proposals for upstream incorporation; direct mirror edits block export.

## Configure the connection and model

| Environment variable         | Purpose                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CONTEXTRAIL_MCP_URL`        | Authorized HTTP(S) MCP endpoint, including its configured path. Use HTTPS for remote credentials. URL credentials, queries and fragments are rejected. |
| `CONTEXTRAIL_MCP_AUTH_TOKEN` | Bearer token authorized to read the reviewer and selected contexts, and to submit feedback when enabled.                                               |
| `CONTEXTRAIL_MCP_ORG_ID`     | Organization scope, sent as `x-v2-org-id`.                                                                                                             |
| `CONTEXTRAIL_MCP_TIMEOUT_MS` | Per connection/read timeout; default 30000 ms. `--mcp-timeout-ms N` overrides it.                                                                      |
| `OPENAI_API_KEY`             | Credential for `--provider openai`.                                                                                                                    |
| `OPENROUTER_API_KEY`         | Credential for `--provider openrouter`.                                                                                                                |

The MCP endpoint must support protocol **2026-07-28**. The process inherits exported
variables from its shell or the workflow step's `env`. Provider/model selection is
explicit, with no fallback. `--provider` and `--model` override
`CONTEXTRAIL_REVIEW_PROVIDER` and `CONTEXTRAIL_REVIEW_MODEL`.

OpenAI uses its Responses API. OpenRouter uses the OpenAI-compatible chat adapter at its own
endpoint. Submission tools request strict schema output; local validation remains mandatory because
provider enforcement can vary. Source tools retain their optional navigation arguments. Use a model ID
available to your provider account and capable of tool calling. For OpenRouter,
export `OPENROUTER_API_KEY` securely and replace the provider/model portion of the
quickstart with:

```sh
--provider openrouter --model YOUR_OPENROUTER_MODEL_ID
```

`--effort none|minimal|low|medium|high|xhigh` requests provider-specific reasoning
effort only when that model supports it. A valid CLI setting does not ensure that
a provider accepts it. Source excerpts and published guidance are sent to your
selected model provider; use an account and data-handling arrangement appropriate
for that material.

## Phase configuration and execution

The selected reviewer skill and its pinned contexts define the assessment authority.
The package accounts for every expected context; interpreted checks cite original passages.
One coherent assessment investigates both revisions and supporting source, interprets the
published requirements and submits a result for every original criterion. A separate verification
invocation checks findings, adherence and nonapplicability, including missing obligations and
permitted alternatives. There is no separate model planning session or automatic whole-review
semantic repair cycle. Code validates records and decides completion and exit; a model declaring
itself done cannot make missing judgments complete.

`--provider`, `--model` and `--effort` supply the explicit shared default. Optional
`--phase-models` JSON overrides `assess` or `verify`; an override includes provider
and model together, plus optional effort. Omitted effort uses that provider's default.
The legacy `plan` key is accepted but no planning model is invoked.
Unknown keys and unsupported configuration fail without model substitution.

```sh
--phase-models '{"verify":{"provider":"openrouter","model":"YOUR_VERIFICATION_MODEL"}}' \
  --max-parallel 3 --log-level info
```

`--max-parallel` remains accepted (1–50, default 3) for caller compatibility; the selected reviewer
now uses one coherent assessment session, followed by one independent verification session.
`--log-level quiet|info|debug` defaults to info; stdout retains machine JSON while safe progress
goes to stderr. All levels retain required diagnostics. Execution limits cover the invocation,
including bounded continuation of unfinished submissions. No stronger-model fallback is implicit.
The observed token cutoff can overshoot by one call and is not a dollar ceiling.
Execution completion, assessment coverage, verification coverage and policy acceptance
are separate fields. Schema validity and exact citations do not prove a judgment correct.

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
| `--min-confidence 1\|2\|3` | Low or unavailable confidence makes an entry incomplete, including a not-applicable judgment. That entry cannot qualify as a blocker under this gate. Omitted: no confidence gate.  |
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

## Feedback and privacy

`--feedback send|off` defaults to **send**. After local finalization, `send` reports
only run/contract identity, origin and package/method version, exact reviewer/context
versions, expected scope, structured dispositions, adherence/confidence, finding
categories, policy/blocking decisions, completion/stop reason, and known duration,
provider/model/harness, call counts and provider-reported token usage with missingness.
A receipt confirms ingestion, not correctness.

Repository identity is withheld by default on both retrieval and review feedback.
`--repository-attribution` explicitly includes the Git-derived host, owner namespace
and repository name where available. It does not include the remote URL. `--feedback
off` disables review metadata submission; local reports are still written and ordinary
MCP retrieval still produces delivery events.

Review explanations, source/diffs, paths, quotations, prompts, responses, tool traces,
purpose, raw errors and audit files are not sent through review feedback. PR, CI and
artifact URLs are not reported. Detailed material stays in local artifacts and in
the requests to the model provider you selected; GitHub artifact storage is a
separate caller-controlled destination when you use the template.

## Inspect and retain evidence

Each new review creates `.contextrail/reviewer/<run-id>/` in the reviewed repository:

| File                                  | Use                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `diff.patch`                          | Ordinary unified Git diff for the fixed comparison; sensitive-path omissions are explicit.                          |
| `preparation.md`                      | Human entry point: compared commits, file statistics/list, governing scope and omissions.                           |
| `evidence.md` / `evidence-index.json` | Readable governing standards and their indexed read-tool references; supporting source remains available on demand. |
| `state.json`                          | Progressive scope, accepted results, gaps, effective settings and decision.                                         |
| `publications.json`                   | Original pinned contexts.                                                                                           |
| `prepared.json`                       | Preparation state before model execution.                                                                           |
| `evidence.json`                       | Retrieved evidence and provenance.                                                                                  |
| `diagnostics.jsonl`                   | Safe phase/call/tool metadata, validation failures, usage and stop reasons; no full conversation capture.           |
| `phases/`                             | Versioned phase handoffs with input/output identities, assessment and evidence references.                          |
| `report.json` / `report.md`           | Machine-readable and readable result with citations, scope, scores and reasons.                                     |
| `manifest.json`                       | SHA-256 file digests binding the available finalized bundle.                                                        |

Preparation produces state and publications; later files depend on reaching review
execution/finalization. Invalid startup settings may fail before any run directory
exists. SIGINT/SIGTERM and operational stops preserve accepted work where writable.
Resume a sealed incomplete run with the original comparison and settings:

```sh
contextrail-review review --reviewer skill://YOUR/REVIEWER --repo . --base BASE --head HEAD \
  --provider openrouter --model YOUR_MODEL --resume .contextrail/reviewer/RUN_ID
```

Resume a run from one process at a time. Resume validates the saved manifest, publications, source
identity and evidence before reusing work.
It uses the saved standards rather than fetching newer versions. Completed assessment work can
survive a failed independent check; unverified judgments never become a passing review. Limits
apply to the new invocation and cumulative usage remains in the run. Hard termination can leave
an unsealed run, which resume refuses. Start a new review for different source or standards.

Review artifacts contain assessment bodies and necessary cited source evidence. Routine diagnostics
exclude full prompts/responses and source excerpts. New local run directories
and files use owner-only permissions. Runtime credential values are redacted, but
that does not make cited source suitable for public sharing. You control
artifact access and retention; remove a run when its accountability purpose ends.
Provider error bodies, HTTP headers and hidden reasoning are omitted. Reported
reasoning-token counts describe usage, not access to hidden reasoning.

## Advanced operational settings

`--purpose TEXT` records your stated objective or stage for the reviewer.
Every option in this section, plus provider, model, effort, min-adherence,
min-confidence, advisory, feedback and repository-attribution, has the environment
form `CONTEXTRAIL_REVIEW_<UPPERCASE_FLAG_WITH_UNDERSCORES>`; CLI values override it.
For example, `--max-turns` maps to `CONTEXTRAIL_REVIEW_MAX_TURNS`. Advisory and
repository-attribution environment values must be `true` or `false`. Git arguments
and reviewer ID have no environment aliases. See `--help` for the current flag list.

| Flag                                                    | Default / unit                                                                                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--max-turns N`                                         | Unset; model calls/steps.                                                                                                                             |
| `--max-output-tokens N`                                 | Unset; per-call output allowance, including reasoning tokens where applicable.                                                                        |
| `--max-total-tokens N`                                  | Unset; observed provider total-token cutoff between calls. Can overshoot by one call; missing usage prevents honest enforcement and stops the review. |
| `--max-time-ms N`                                       | Unset; model-session deadline in ms, excluding preparation.                                                                                           |
| `--source-page-entries N`                               | 100 entries per list/change response.                                                                                                                 |
| `--source-search-matches N` / `--source-search-files N` | 100 each, per search page.                                                                                                                            |
| `--source-read-lines N` / `--source-read-bytes N`       | 200 lines / 65536 bytes per source response; bytes >=4.                                                                                               |
| `--source-timeout-ms N`                                 | 30000 ms per source operation.                                                                                                                        |

The per-call output allowance includes reasoning and structured tool arguments. A small cap can
truncate a submission even when individual source reads fit. Invalid governing citations
receive one batched correction identifying every affected criterion/check and its canonical pinned
references; the package still requires exact quotes and never accepts a different context as fallback.
Safe diagnostics retain these locations and reference hashes without raw rejected conversations.

Preparation supplies the complete permitted changed-file inventory with offsets for patch navigation.
The `changes` tool lists file metadata; `diff` returns ordinary unified patch pages. Metadata identifies
review surfaces, not evidence that code satisfies or violates a rule. Evaluated judgments still require
pinned source reads. An incomplete inventory prevents complete preparation.

The assessment session submits one complete context result at a time. The package retains each validated
result and reports the remaining context IDs; corrections cannot overwrite an accepted result. The
phase completes only when every assigned context is present. Retained partial progress is evidence
of an incomplete phase, never a verified assessment or a successful review.
Invalid submissions in one model response share a correction round; the session stops after three
invalid rounds. Every attempt consumes the global execution budget. Use one exact committed file
for scoped literal search, or omit the path for bounded whole-tree navigation.

Numeric limits are positive safe integers; timers use 1..2147483647 ms. Defaults
are operational choices, not universal review capacity. Unset execution limits
leave provider output/context constraints in place. The workflow has its own job
timeout; runner termination cannot guarantee finalization or upload.

## GitHub Actions

The [composite Action](action/action.yml) runs an existing published
`@contextrail/code-review-agent` package. The CLI owns assessment, evidence, unique
`runId`, exit codes and ContextRail feedback. The Action owns installation, fixed
comparison preparation, CLI invocation, GitHub health summaries, optional PR comments and evidence upload.
The caller owns events, branch policy, permissions, runner, timeout, concurrency and
configuration/secret references. There is no repository-source build or package-transfer fallback.

The public source, package and Action revisions are separate identities. Pin the composite at
`contextrail/reviewer/action@ACTION_COMMIT_SHA`, replacing the placeholder with an independently
reviewed full public commit SHA. Pass the exact published npm package version; never pass `alpha`
or `latest` as the Action package-version input.

Select an independently reviewed public Action SHA and an exact qualified npm version:

```yaml
- uses: contextrail/reviewer/action@ACTION_COMMIT_SHA
  with:
      package-version: '1.0.0-alpha.6'
      pr-number: ${{ github.event.pull_request.number }}
      base-branch: alpha
      reviewer: skill://your-domain/your-reviewer
      mcp-url: ${{ vars.CONTEXTRAIL_MCP_URL }}
      mcp-org-id: ${{ vars.CONTEXTRAIL_MCP_ORG_ID }}
      provider: openai
      model: REPLACE_WITH_PROVIDER_MODEL_ID
      max-time-ms: '600000'
      post-comment: 'true'
      pr-context: 'true'
      mcp-auth-token: ${{ secrets.CONTEXTRAIL_MCP_AUTH_TOKEN }}
      openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

Replace both placeholders before use. [The retained inline example](examples/review-pull-request.yml)
shows the established direct CLI workflow; it also installs an explicit published npm version.
Composite callers own their event policy and require no contribution checkout.
The Action requires a Linux runner, Node 22.18.0 (installed by
pinned setup-node), Git >=2.45 and access to the public npm registry and GitHub.com.
GitHub Enterprise Server and authenticated npm registries are outside this interface.

### Consumer workflow

The composite caller can subscribe to `workflow_dispatch` with a PR number and to
`pull_request_target` with **only `labeled`**. The caller accepts the explicit addition
of `contextrail-review`; other labels do nothing. Leaving the label in place does not
review subsequent pushes. Opened, reopened and synchronize events incur no review.
Manual requests use the trusted default-branch workflow and validate the selected PR
against the same eligibility rules. A rerun can spend provider credit again.

Eligible PRs are open, target the caller's `base-branch`, originate in the same
repository and have a human (`User`) author whose GitHub author association is
`OWNER`, `MEMBER` or `COLLABORATOR`. Both event filtering and fresh API validation are
used; manual dispatch does not bypass eligibility. Label runs bind to the event's
base/head SHAs and reject a stale event. Manual runs resolve the current PR's exact
SHAs. The Action fetches complete objects, checks commit identity, and rechecks before
introducing provider credentials. It never checks out contribution files, initializes
submodules, installs contribution dependencies or executes contribution scripts/hooks.

**Shared-runner trust boundary:** a composite Action shares the caller's job and
runner. Do not execute untrusted contribution code anywhere in this credentialed job,
before or after the Action; earlier processes can survive into later steps. Use an
isolated, trusted runner with no untrusted service, workspace or cache restoration.
Only a trusted Action revision and independently qualified npm artifact may receive
review credentials. Disabled lifecycle scripts do not make runtime package code
trusted. Pin every executable Action to an independently reviewed full commit SHA.

Without comments, use `contents: read` and `pull-requests: read`. To post the summary,
set `post-comment: 'true'` and grant the review job `pull-requests: write`. The default is
false so read-only consumers retain their existing permission boundary. Use the default
GitHub Actions token; reruns update the matching `github-actions[bot]` comment for that
reviewer. Other users' comments are never edited. Superseded comparisons and older runs
cannot replace a newer comment. No labels or Slack messages are written.
Keep this check optional by omitting it from branch protection/ruleset required checks.
The `review-exit` output preserves CLI exit 0/1/2: do not add `continue-on-error` or advisory
mode to make it green. If enforcement is wanted later, require the check through
branch policy; failure semantics remain unchanged.

### Inputs, outputs and credentials

| Input                                  | Contract                                                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package-version`                      | Required exact published npm SemVer. No tags, ranges, URLs, local builds or unavailable-version fallback.                                                 |
| `pr-number`, `base-branch`             | Required PR number; optional expected target branch.                                                                                                      |
| `reviewer`                             | Required reusable published `skill://` ID; never an execution or repository ID.                                                                           |
| `mcp-url`, `mcp-org-id`                | Required HTTPS endpoint and organization scope, using CLI connection vocabulary.                                                                          |
| `provider`, `model`                    | Required `openai` or `openrouter` and explicit provider-native model. No fallback.                                                                        |
| `effort`                               | Optional CLI effort; empty delegates to provider default.                                                                                                 |
| `max-time-ms`                          | Required positive workflow model deadline, at most 2147483647 ms. Does not bound total job time.                                                          |
| `feedback`                             | `send` (default) or `off`; CLI owns report submission and its status.                                                                                     |
| `repository-attribution`               | `true` or `false` (default); explicitly includes repository identity in CLI retrieval/reporting.                                                          |
| `artifact-retention-days`              | 1–90, default 7, within repository/organization retention policy.                                                                                         |
| `post-comment`                         | `false` by default; `true` creates/updates the bot PR summary. Requires `pull-requests: write`.                                                           |
| `pr-context`                           | `false` by default; collect bounded PR discussion/history for a matching CLI release supporting `--pr-context`. Sends that context to the selected model. |
| `github-token`                         | Defaults to `github.token`; Git/API reads, plus PR comment writes when enabled.                                                                           |
| `mcp-auth-token`                       | Required bearer credential; map from `secrets.CONTEXTRAIL_MCP_AUTH_TOKEN`.                                                                                |
| `openai-api-key`, `openrouter-api-key` | Supply the selected provider's credential from its named secret.                                                                                          |

New optional inputs: `phase-models` (JSON, default `{}`), `max-parallel` (1–50, default 3),
`log-level` (`quiet|info|debug`, default `info`) and `inline-comments` (default `false`,
requires `post-comment: 'true'`). The model deadline covers the complete model workflow,
not a separate allowance for each phase or continuation. PR title/body are prepared as intent; `pr-context`
controls the additional bounded discussions/history. Supply both existing provider secret
inputs only when explicitly configured phases use both providers.

Credentials are explicit Action inputs, never CLI arguments. Installation gets no
GitHub, MCP or provider credentials. Git/API read credentials reach only comparison
preparation, the final freshness read and the opt-in comment step; they are not written into Git configuration
or passed to model-execution commands. Trusted npm GitHub adapter commands receive only their
required GitHub credential. MCP and the explicitly configured phase providers' keys reach only the review subprocess;
ambient CLI policy/provider settings are excluded. Prefer secret inputs over caller
`env`: environment values on the calling step are inherited by every composite step.
Consumer steps can still access their job's GitHub token; composite steps are not a
security boundary against malicious trusted Action code.

| Output              | Meaning                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `review-exit`       | Actual CLI 0/1/2, empty if not invoked or interrupted. Action/setup/upload failure can fail the job separately. |
| `run-id`            | Unique CLI `runId` from confirmed state; no substituted workflow/check/reviewer identity.                       |
| `feedback-status`   | `received`, `failed`, `pending`, `off` or `unavailable`. Feedback failure preserves CLI exit.                   |
| `comparison-status` | `current_at_finish`, `superseded` or `unknown`, when a comparison was prepared.                                 |
| `artifact-url`      | Evidence artifact URL when upload succeeds.                                                                     |
| `comment-status`    | `created`, `updated`, `skipped_superseded`, `skipped_newer` or `failed`; empty when disabled.                   |

Available state, reports, phase diagnostics, CLI diagnostics, comparison/setup status and npm lock
with resolved dependency integrity are preserved after failure. Installed dependencies
and fetched source objects are not uploaded. A separate post-publication artifact retains
validated write payloads and delivery outcomes, including unknown/partial writes;
`publication-artifact-url` exposes its URL. It uses the same retention setting. Review evidence includes cited source and generated assessments;
restrict artifact access and retention accordingly. Ordinary logs and summaries use
controlled statuses, identities, counts, bounded finding/correction text and unresolved reasons, not conversations, full source citations or raw upstream errors.
The summary confirms completion only from matching persisted comparison/reviewer
state. An ingestion receipt does not endorse a review.

The final API read labels a changed comparison (identity, selected target or base/head SHAs)
**SUPERSEDED; historical result only**. Closing a PR alone does not change its comparison. A failed freshness read means unknown. No result certifies future currency;
verify both SHAs when using it. A provider call may race a subsequent PR push, and
feedback can already have been sent for the accurately recorded fixed comparison.
Cancellation or job timeout can prevent later upload/summary steps; use a finite job
timeout with headroom beyond the model-session limit (this caller uses 20 minutes for
600000 ms). Evidence preservation is attempted with `always()` after ordinary errors.

The evidence pack focuses the review on all selected standards and prerequisites, with an ordinary
`diff.patch` and full permitted changed-file inventory. The reviewer can read any permitted file
in either pinned Git snapshot, including unchanged supporting code. Pack read tools expose governing
text with numbered citation segments; source read, list and search tools provide additional evidence.
The package keeps every original criterion as a result row without creating a session per criterion.
The independent final check evaluates the resulting set together. Missing results, unsupported
claims and failed verification remain explicit incomplete work.

Developer feedback groups verified accounts with overlapping ranges in the same pinned source into one
thread while retaining every distinct conclusion, correction and governing criterion. This does
not merge canonical findings or change policy counts. Conflicting or unverified replacements
suppress a combined suggestion; the individual textual corrections remain visible.

Model citations select `{ref, startSegment, endSegment}` from numbered evidence segments,
using inclusive indices relative to that evidence record. Code extracts the exact quotation,
character offsets and source location; models do not supply quotation text. An explicit range
also identifies an occurrence when text repeats. Canonical reports retain quotations and provenance.
Selection failures identify the precise field and safe evidence identity in correction feedback
and diagnostics. Source bodies stay out of routine diagnostics. Selection bounds, exact text,
governing authority and independent verification remain enforced without extra correction rounds.

### Operational summary and PR comment

The summary distinguishes execution stop reason, assessment completeness, CLI exit and
report ingestion. It includes bounded finding/correction text, unresolved assessments,
exact comparison SHAs, package/reviewer identity, requested/returned models, runtime/SDK
versions, review duration, elapsed time before summary, calls/steps, and reported cost/token
usage. Links lead to the workflow and evidence artifact; full source citations and assessment records
stay in the artifact; full model conversations are not routinely captured. Model text is escaped to prevent injected Markdown, HTML and mentions.

Cost uses provider wire usage when present, including HTTP-200 calls rejected by the SDK;
SDK and wire records are never added together. Missing or partial per-call coverage is explicit,
not zero cost. Output tokens already include reasoning. Provider-reported cost is not a verified
invoice or total infrastructure cost. `received` confirms ingestion, not review approval.

Comment creation/update is attempted after ordinary review failures with `always()`. A
permission/API failure is visible in the Action summary and fails that step independently of
`review-exit`; there is no automatic comment-write retry. Comments are scoped to the configured
PR/reviewer and current comparison, with workflow/run-attempt links for traceability. Cancellation
or job timeout can still prevent summary/comment execution. The caller must serialize publications per repository/PR/reviewer for rerun deduplication.
GitHub creation has no atomic compare-and-set; concurrent runs can race after absence checks.
The npm package owns presentation and GitHub adapter behavior; the Action invokes it.

After publishing this Action update, adopt its full public commit SHA as well as the intended
exact npm version. Re-running an old workflow retains its old Action code and inputs.

### Governed PR feedback and inline corrections

The PR comment leads with the governed assessment outcome, verified findings and context
coverage. A complete table retains one row per original governed criterion, separating its
outcome from independent verification and counting only verified findings. Pending and
unexamined results remain explicit. A factual change summary uses the prepared file inventory,
with exclusions or unavailable inventory stated. Each finding identifies the criterion, code
location, consequence and correction; unresolved evidence needs remain separate. Prior runs, cost and brief diagnostics appear
in collapsed run details at the bottom. The Action job summary emphasizes operational
health, per-phase model/timing/usage and delivery outcomes.

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

### Review history and conversational context

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

### Configure and qualify a consumer

1. Verify the exact public npm package version and provenance, CLI startup and reporting contract.
2. Pin `contextrail/reviewer/action` at an independently reviewed full public commit SHA and an
   exact npm package version in your composite caller. These are independent pins.
3. Confirm the chosen published reviewer and its selected contexts are readable from your MCP organization.
4. Configure your authorized expiring MCP and provider credentials through the consumer repository's secret facilities.
5. Under your organization's authorization, dispatch one small eligible PR or apply `contextrail-review`.
   Verify fixed SHAs, installed package identity, unique runId, findings, retained evidence and reporting receipt.
   A local fixture pass does not establish hosted/provider/reporting qualification.

Rerun deliberately: use a fresh manual dispatch for current SHAs. Re-running an old
label event rejects superseded comparisons; leaving its label attached is inert.
Removing/readding the label is another explicit paid request, and repeated requests
are not deduplicated. Review artifact and feedback status before spending again.

Disable via GitHub Actions' Disable workflow control (or remove subscriptions).
Clearing the npm version variable also makes setup fail before review. Rotate a
compromised/expired credential through the issuing service and GitHub secret under
owner authority; revoke the old token/key, update the named secret, then explicitly
qualify a new small run. Do not log credential values. Optional merge policy, workflow
name/concurrency and reusable reviewer ID are separate identities.

GitHub semantics: [composite metadata](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax),
[workflow contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts),
[event subscriptions](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
and [artifact retention](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-what-your-workflow-does/storing-and-sharing-data-from-a-workflow).

## Troubleshooting

- **Preparation fails:** run `prepare` with the same reviewer/repo/base/head.
  Inspect `state.json` gaps and controlled diagnostics. Confirm the reviewer is
  published, selects contexts, and its exact publications/prerequisites are readable
  in the organization. Check MCP protocol, endpoint path and timeout.
- **No run directory:** check `--help`, Node/Git versions, required flags, resolvable
  commits, MCP URL/token/org and write access. Configuration can fail before state
  is created. Do not print credentials while checking whether they are exported.
- **Missing credentials:** export the MCP token and the selected provider key into
  the actual CLI process. A `.env` file alone has no effect. Preparation needs no
  provider key; a review missing its provider key records a provider failure after
  successful preparation.
- **Provider errors:** inspect the controlled provider category/status, requested
  model and stop reason in state/audit. Confirm account access, quota, tool support
  and effort compatibility. Correct configuration before another paid attempt;
  the CLI does not choose a replacement provider or model.
- **Incomplete review:** inspect unresolved/not-evaluated entries, preparation gaps,
  confidence gates, operation limits and available source. Fetch missing Git objects
  or supply a better bounded comparison, then run again. Advisory mode does not
  resolve missing evidence. An exit-1 run can still be incomplete.
- **Feedback failed:** inspect `execution.reporting` or `reporting-status.json` when
  present. Local results and exit remain usable; check MCP access and the saved
  controlled code. A receipt is not a review endorsement.

The package also exports `prepareReview`, `runReview`, `FixedSnapshotSource`,
`McpPublishedReader`, provider constructors and policy helpers. The shipped type
declarations describe their arguments; these APIs use the same fixed publications,
source boundaries and result semantics as the CLI.

## License

Copyright (c) 2026 ContextRail. Licensed under the [Apache License, Version 2.0](LICENSE).
This covers the reviewer package, its bundled generated code, documentation and
GitHub composite Action and consumer template. It does not grant a license to the ContextRail server,
web application, other repository packages or guidance retrieved through MCP.
Those materials and third-party dependencies have separate terms.
