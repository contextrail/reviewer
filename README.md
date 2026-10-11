# ContextRail reviewer

Review Git changes against your team's published organizational guidance. Use the
reviewer before merging a change when you want to see which local requirements it
meets, where it departs from guidance, and which judgments need more evidence.

You choose a published reviewer, a model, and two commits. The CLI retrieves the
reviewer's selected contexts (individual Standards or Guidance), fixes their
published versions, and asks the model to inspect the changes and supporting source.
It writes findings, separate adherence and confidence judgments, and cited evidence
into local reports. Open `report.md` to read the result and inspect its evidence.
These are bounded model judgments; a completed review does not certify compliance
or establish that every defect was found.

## Moving from the earlier reviewer

This implementation continues the `@contextrail/code-review-agent` package name. The
published `0.1.x` versions are the earlier reviewer and remain available by exact version.
This is a replacement, not a drop-in upgrade: use the `contextrail-review` executable
and the configuration below, rather than the old `code-review-agent` command. It requires
Node >=22.18.0 and current ContextRail MCP credentials. Existing reports and configuration
are not automatically migrated.

## Install and run

Requires **Node >=22.18.0**, **Git >=2.45**, a Git repository with both commits and
supporting objects available, authorized access to ContextRail MCP, and a provider
API key. Your ContextRail administrator supplies the endpoint, organization ID,
bearer token and published reviewer ID. The reviewer must select published contexts;
an instruction-only reviewer cannot supply this CLI's assessment scope.

Install an exact published version from public npm (alpha versions use npm's `alpha` channel).
The package is Apache-2.0 licensed. This source checkout's selected version is
`1.0.0-alpha.1`; its immutable export attribution is in `release.json`.

```sh
npm install --ignore-scripts @contextrail/code-review-agent@1.0.0-alpha.1
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

OpenAI uses its Responses API. OpenRouter uses its chat adapter. Use a model ID
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

Each invocation creates `.contextrail/reviewer/<run-id>/` in the reviewed repository:

| File                        | Use                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `state.json`                | Progressive scope, accepted results, gaps, effective settings and decision.            |
| `publications.json`         | Original pinned contexts.                                                              |
| `prepared.json`             | Preparation state before model execution.                                              |
| `evidence.json`             | Retrieved evidence and provenance.                                                     |
| `audit.jsonl`               | Observable model requests/responses, tool activity, corrections and controlled errors. |
| `report.json` / `report.md` | Machine-readable and readable result with citations, scope, scores and reasons.        |
| `manifest.json`             | SHA-256 file digests binding the available finalized bundle.                           |

Preparation produces state and publications; later files depend on reaching review
execution/finalization. Invalid startup settings may fail before any run directory
exists. SIGINT/SIGTERM and operational stops preserve accepted work where writable.
Hard termination may leave checkpoints without final reports. There is no resume
command; inspect the saved run and start a new invocation when ready.

Artifacts can contain source and model conversations. New local run directories
and files use owner-only permissions. Runtime credential values are redacted, but
that does not make source/conversations suitable for public sharing. You control
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

Numeric limits are positive safe integers; timers use 1..2147483647 ms. Defaults
are operational choices, not universal review capacity. Unset execution limits
leave provider output/context constraints in place. The workflow has its own job
timeout; runner termination cannot guarantee finalization or upload.

## GitHub Actions

The [composite Action](action/action.yml) runs an existing published
`@contextrail/code-review-agent` package. The CLI owns assessment, evidence, unique
`runId`, exit codes and ContextRail feedback. The Action owns installation, fixed
comparison preparation, CLI invocation, a concise GitHub summary and evidence upload.
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
      package-version: '1.0.0-alpha.1'
      pr-number: ${{ github.event.pull_request.number }}
      base-branch: alpha
      reviewer: skill://your-domain/your-reviewer
      mcp-url: ${{ vars.CONTEXTRAIL_MCP_URL }}
      mcp-org-id: ${{ vars.CONTEXTRAIL_MCP_ORG_ID }}
      provider: openai
      model: REPLACE_WITH_PROVIDER_MODEL_ID
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

Use only `contents: read` and `pull-requests: read` for Git/API access. Artifact upload
uses GitHub's artifact service; it does not require PR/issue/status write permissions.
There are no PR comments, labels written by the Action or Slack integration.
Keep this check optional by omitting it from branch protection/ruleset required checks.
The Action always preserves CLI exit 0/1/2: do not add `continue-on-error` or advisory
mode to make it green. If enforcement is wanted later, require the check through
branch policy; failure semantics remain unchanged.

### Inputs, outputs and credentials

| Input                                  | Contract                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `package-version`                      | Required exact published npm SemVer. No tags, ranges, URLs, local builds or unavailable-version fallback. |
| `pr-number`, `base-branch`             | Required PR number and target branch policy.                                                              |
| `reviewer`                             | Required reusable published `skill://` ID; never an execution or repository ID.                           |
| `mcp-url`, `mcp-org-id`                | Required HTTPS endpoint and organization scope, using CLI connection vocabulary.                          |
| `provider`, `model`                    | Required `openai` or `openrouter` and explicit provider-native model. No fallback.                        |
| `effort`                               | Optional CLI effort; empty delegates to provider default.                                                 |
| `max-time-ms`                          | Required positive model-session time limit, at most 2147483647 ms. Does not bound total job time.         |
| `feedback`                             | `send` (default) or `off`; CLI owns report submission and its status.                                     |
| `repository-attribution`               | `true` or `false` (default); explicitly includes repository identity in CLI retrieval/reporting.          |
| `artifact-retention-days`              | 1–90, default 7, within repository/organization retention policy.                                         |
| `github-token`                         | Defaults to `github.token`; GitHub Git/API read authority only.                                           |
| `mcp-auth-token`                       | Required bearer credential; map from `secrets.CONTEXTRAIL_MCP_AUTH_TOKEN`.                                |
| `openai-api-key`, `openrouter-api-key` | Supply the selected provider's credential from its named secret.                                          |

Credentials are explicit Action inputs, never CLI arguments. Installation gets no
GitHub, MCP or provider credentials. Git/API read credentials reach only comparison
preparation and the final freshness read; they are not written into Git configuration
or passed to the CLI. MCP and the selected provider key reach only the CLI subprocess;
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

Available state, reports, audit, CLI diagnostics, comparison/setup status and npm lock
with resolved dependency integrity are preserved after failure. Installed dependencies
and fetched source objects are not uploaded. Evidence includes source/model material;
restrict artifact access and retention accordingly. Ordinary logs and summaries use
controlled statuses, identities and counts, not conversations or raw upstream errors.
The summary confirms completion only from matching persisted comparison/reviewer
state. An ingestion receipt does not endorse a review.

The final API read labels a changed/closed/ineligible PR **SUPERSEDED; historical result
only**. A failed freshness read means unknown. No result certifies future currency;
verify both SHAs when using it. A provider call may race a subsequent PR push, and
feedback can already have been sent for the accurately recorded fixed comparison.
Cancellation or job timeout can prevent later upload/summary steps; use a finite job
timeout with headroom beyond the model-session limit (this caller uses 20 minutes for
600000 ms). Evidence preservation is attempted with `always()` after ordinary errors.

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
