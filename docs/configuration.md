# CLI configuration

[Documentation index](README.md) · [Reviewer overview](../README.md)

Use this reference for the standalone CLI. CLI flags override their environment aliases.
For GitHub Actions, use the four [repository variables](github-actions.md#choose-models-with-repository-variables); the workflow handles phase configuration for you.

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

## Models by phase and logging

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

## Limits and environment aliases

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

The per-call output allowance includes reasoning and structured tool arguments; a small cap can
truncate a submission even when source reads fit. Numeric limits are positive safe integers;
timers use 1..2147483647 ms. Unset execution limits still leave provider constraints in place.
The observed token limit can overshoot by one call and is not a dollar ceiling.
Workflow timeouts are separate; leave time for finalization and upload.

See [review policy](review-results.md#interpret-judgments-and-exit-codes) for adherence, confidence and advisory settings, and [recovery](architecture.md#recovery-and-validation) for retry semantics.
