# Operate and troubleshoot reviews

[Documentation index](README.md) · [Reviewer overview](../README.md)

Use this page when a review is slow, incomplete, failed, or needs to be audited. For finding semantics, use [results](review-results.md).

## Inspect evidence and resume

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

## Health, logging and cost

Use `--log-level debug` locally or `log-level: debug` in the Action for additional progress telemetry.
Stdout remains machine JSON; progress goes to stderr. Required diagnostic artifacts are retained at every level.

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

Provider recovery records identify the phase, call number, retry count for that request,
and backoff in milliseconds. `provider_recovered` confirms a successful SDK response;
`provider_retry_exhausted` means all three attempts for that request failed. Recovery does not
mean the assessment itself passed. All requests consume the existing execution budget.
Each non-streaming provider attempt has a 180-second deadline. On expiry, the transport is
aborted and its rejection is awaited before the existing retry policy starts another attempt;
completed tools and accepted criteria are not replayed. Safe recovery diagnostics identify
`ProviderRequestTimeout`. There are still at most two retries per request, and each attempt
consumes the original call/time/token budget. Caller cancellation and the phase deadline take
precedence and do not trigger retries. A timeout may lack provider usage and must not be counted
as zero cost. This deadline is fixed; it does not extend the consuming workflow's overall limit.

Parser failures include a fixed `parse.code` such as `prototype_property_rejected`,
`unexpected_end`, `unterminated_string`, `invalid_control_character`, `unexpected_token`,
or the fallback `syntax_error`. `parse.bytes` records rejected JSON size when the SDK exposes
it, otherwise null. These categories distinguish observed parser failures without retaining
exception messages, response bodies, prompts, source or arbitrary provider fields. Unknown
syntax details remain unknown rather than being inferred from a generic exception name.

### Diagnose a failed run

Start with the Action summary's terminal failure, then open `diagnostics.jsonl` in the
artifact. Correlate events by run ID, phase, attempt and call. The summary links the stop
reason to the last failing provider request in that phase; a recovered earlier error is
not the final cause. Updated summary behavior requires the new Action SHA as well as the
new npm package; changing `REVIEWER_VERSION` alone does not update Action scripts.

At `info`, phase boundaries, provider request start/completion, assessment progress,
recovery, reporting and final outcome appear on stderr. `debug` also shows tool activity,
submission diagnostics and SDK steps. `quiet` retains artifacts and prints fatal failures.
All levels write the same bounded diagnostic artifact; stdout remains machine JSON.

Provider start/completion/failure events include request bytes, message and tool counts,
tool-schema bytes and the explicit output-token limit when available. These are wire
measurements, not token estimates. Request structure is inspected only up to 4 MiB;
above that size the byte count remains available but structural counts are unknown.
HTTP completion describes receipt and usage capture, not successful SDK parsing or a
valid review. Tool and phase terminal events record duration too.

| Failure category                                          | What to check next                                        | Automatic recovery                                   |
| --------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| Context limit or oversized request                        | Request size and growth, evidence volume, provider limits | No identical retry for HTTP 400/413                  |
| Invalid schema or unsupported parameter                   | Tool schema, provider/model support, configured effort    | No identical retry for HTTP 400                      |
| Credentials, permissions, credit limit, unavailable model | Selected account, access, quota and model ID              | No retry for HTTP 401/402/403/404                    |
| Rate limit, HTTP timeout or server failure                | Provider health and retry events                          | Existing bounded retry for 408/429/5xx               |
| Transport failure                                         | Fixed DNS, connection, timeout or cancellation category   | SDK-marked retryable transport failures only         |
| Response parse/schema failure                             | Parser category and safe validation paths                 | Existing bounded retry; validation is never bypassed |
| Unknown request rejection                                 | Status, call and safe classification evidence             | Do not infer a cause from a generic HTTP 400         |

HTTP errors retain a fixed `details.code`/`reason`, an allowlisted parameter when supplied,
and whether classification came from an HTTP status, structured provider code or recognized
message pattern. Error-body inspection is capped at 64 KiB. `bodyFormat` marks missing,
oversized, non-JSON or unreadable bodies. Unrecognized details remain unknown; no arbitrary
provider message, body, header, source excerpt or prompt is written to routine diagnostics.
Nested OpenRouter upstream errors are inspected within the same bounds.

`finalization_failed` records the failed save/report/seal stage and original stop reason.
A secondary write failure does not replace the primary execution failure. Failure to persist
required diagnostic evidence prevents a clean completion. No automatic retry is added for
feedback or GitHub writes, which may already have taken effect.

## Data handling and feedback

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

Provider retries and submission correction have separate bounds; see [recovery and validation](architecture.md#recovery-and-validation).
