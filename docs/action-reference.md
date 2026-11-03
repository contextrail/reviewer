# Action inputs, outputs and delivery

[Documentation index](README.md) · [Reviewer overview](../README.md)

Look up a specific setting here. For a first integration, use [GitHub Actions setup](github-actions.md).

## Inputs and credentials

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

Additional optional inputs: `phase-models` (JSON, default `{}`), `max-parallel` (1–50, default 3),
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

## Outputs and artifacts

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
timeout with headroom beyond the model-session limit (for example, use 20 minutes for
600000 ms). Evidence preservation is attempted with `always()` after ordinary errors.

## Comment delivery and reruns

Comment creation/update is attempted after ordinary review failures with `always()`. A
permission/API failure is visible in the Action summary and fails that step independently of
`review-exit`; there is no automatic comment-write retry. Comments are scoped to the configured
PR/reviewer and current comparison, with workflow/run-attempt links for traceability. Cancellation
or job timeout can still prevent summary/comment execution. The caller must serialize publications per repository/PR/reviewer for rerun deduplication.
GitHub creation has no atomic compare-and-set; concurrent runs can race after absence checks.
The npm package owns presentation and GitHub adapter behavior; the Action invokes it.

After publishing this Action update, adopt its full public commit SHA as well as the intended
exact npm version. Re-running an old workflow retains its old Action code and inputs.
