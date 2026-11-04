# Set up GitHub Actions

[Documentation index](README.md) · [Reviewer overview](../README.md)

For repository maintainers connecting the reviewer to CI. Start with the pinned Action below; use the [Action reference](action-reference.md) for all inputs and outputs.

The [composite Action](https://github.com/contextrail/reviewer/blob/main/action/action.yml) runs an existing published
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
      package-version: 'EXACT_PACKAGE_VERSION'
      pr-number: ${{ github.event.pull_request.number }}
      base-branch: alpha
      reviewer: skill://your-domain/your-reviewer
      mcp-url: ${{ vars.CONTEXTRAIL_MCP_URL }}
      mcp-org-id: ${{ vars.CONTEXTRAIL_MCP_ORG_ID }}
      provider: openai
      model: ${{ vars.REVIEW_MODEL }}
      effort: ${{ vars.REVIEW_EFFORT || 'medium' }}
      enforcement: ${{ vars.REVIEW_ENFORCEMENT || 'advisory' }}
      phase-models: >-
          {"verify":{"provider":"openai","model":${{ toJSON(vars.VERIFY_MODEL || vars.REVIEW_MODEL) }},"effort":${{ toJSON(vars.VERIFY_EFFORT || vars.REVIEW_EFFORT || 'medium') }}}}
      max-time-ms: '600000'
      post-comment: 'true'
      pr-context: 'true'
      mcp-auth-token: ${{ secrets.CONTEXTRAIL_MCP_AUTH_TOKEN }}
      openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

Replace both placeholders before use. [The retained inline example](../examples/review-pull-request.yml)
shows the established direct CLI workflow; it also installs an explicit published npm version.
Composite callers own their event policy and require no contribution checkout.
The Action requires a Linux runner, Node 22.18.0 (installed by
pinned setup-node), Git >=2.45 and access to the public npm registry and GitHub.com.
GitHub Enterprise Server and authenticated npm registries are outside this interface.

## Choose models with repository variables

The reviewer uses two model sessions:

- **Review:** reads the code and governing standards, then produces the assessment.
- **Verification:** checks that assessment and corrects unsupported or missed findings.

In **Settings → Secrets and variables → Actions → Variables**, set these repository variables.
They are configuration, not secrets:

| Variable        | What it controls                  | If unset                                                                               |
| --------------- | --------------------------------- | -------------------------------------------------------------------------------------- |
| `REVIEW_MODEL`  | Model that performs the review    | Set this for the example above; ContextRail's monorepo defaults to `openai/gpt-6-luna` |
| `REVIEW_EFFORT` | Reasoning effort for the review   | `medium`                                                                               |
| `VERIFY_MODEL`  | Model that checks the review      | Uses the review model                                                                  |
| `VERIFY_EFFORT` | Reasoning effort for verification | Uses the review effort                                                                 |

**Start by setting only `REVIEW_MODEL`.** Both steps will use that model with medium effort.
To try a different verifier, set `VERIFY_MODEL`; its effort still inherits `REVIEW_EFFORT`
unless you also set `VERIFY_EFFORT`. Clear a verification override to return to inheritance.
Each setting inherits independently. Supported effort values are `none`, `minimal`, `low`,
`medium`, `high` and `xhigh`; choose one supported by the selected model.

The workflow builds the internal phase configuration from these variables. You do not need
to edit JSON when changing models. Model IDs must match the configured provider: the example
uses OpenAI, while ContextRail's monorepo uses OpenRouter. Provider selection and credentials
remain explicit workflow settings and secrets. Preparation and reporting do not use models.

The monorepo job summary shows the effective Review and Verification settings, with each
verification setting marked inherited or overridden, even if review setup subsequently fails.
Changing a variable affects subsequent jobs, not an in-flight review. Push the updated workflow
before using these names; the earlier `CONTEXTRAIL_REVIEW_MODEL` and
`CONTEXTRAIL_REVIEW_EFFORT` repository variables are no longer read by this caller.

These four names are the consuming workflow's interface. The standalone CLI retains its
[CLI flags and environment aliases](configuration.md), including `CONTEXTRAIL_REVIEW_MODEL`;
setting `REVIEW_MODEL` alone in a local shell does not configure the CLI.

## Triggers, permissions and trust

The consumer decides when a review runs and who may request it: events, labels, branches,
PR state, bots, fork policy, approvals, spending limits and credential access belong in its
workflow. The Action does not authorize a run from the PR author's association or account type.
An authorized maintainer can request a review of a contributor's or bot's work.

Supply a PR number in the workflow repository. The Action accepts any triggering event;
`pull_request` and `pull_request_target` runs bind to the matching event's base/head SHAs.
Other events (including manual or scheduled runs) resolve the supplied PR through GitHub's
API and fix its current SHAs. This is still PR comparison, not whole-repository reassessment.
`base-branch` is an optional caller-requested target check. Open/closed state and head-repository
identity do not decide admission. Fork heads are fetched through the base repository's PR ref,
not a contributor-supplied remote. Missing or inaccessible refs fail visibly.

The Action validates PR/repository identity, checks fetched commit identity, and rechecks the
comparison before introducing provider credentials. Stale event comparisons reject. It never
checks out contribution files, initializes submodules, installs contribution dependencies or
executes contribution scripts/hooks. These execution protections are independent of caller policy.

**Shared-runner trust boundary:** a composite Action shares the caller's job and
runner. Do not execute untrusted contribution code anywhere in this credentialed job,
before or after the Action; earlier processes can survive into later steps. Use an
isolated, trusted runner with no untrusted service, workspace or cache restoration.
Only a trusted Action revision and independently qualified npm artifact may receive
review credentials. Disabled lifecycle scripts do not make runtime package code
trusted. Pin every executable Action to an independently reviewed full commit SHA.

Without comments, use `contents: read` and `pull-requests: read`. Grant `checks: read` and
`statuses: read` to include observed GitHub check/status receipts. These bounded receipts describe
the exact PR head, not merge-commit validation or proof of full standards compliance. Unavailable
API access is recorded as unavailable, never as failing tests. Check logs and output are not collected.
To post the summary,
set `post-comment: 'true'` and grant the review job `pull-requests: write`. The default is
false so read-only consumers retain their existing permission boundary. Use the default
GitHub Actions token; reruns update the matching `github-actions[bot]` comment for that
reviewer. Other users' comments are never edited. Superseded comparisons and older runs
cannot replace a newer comment. No labels or Slack messages are written.
Choose `enforcement: advisory|required|strict` explicitly or use the default `advisory`.
Advisory preserves findings and evidence questions without failing for them; execution failures
still return 2. Required fails for supported violations/defects; strict also fails for evidence gaps.
Use branch protection to make a required/strict check a merge requirement. Leave advisory optional
if you want no required check. Avoid `continue-on-error`, which would hide execution failures too.
See the [outcome table](review-results.md#interpret-judgments-and-exit-codes).

The monorepo's `REVIEW_ENFORCEMENT` repository variable selects the mode, defaulting to advisory.
This input requires both the new published Action SHA and the matching CLI release; the retained
alpha.15 Action pin does not support it. After publishing, update both pins before testing the mode.
Deploy the updated API report contract before sending feedback with the new policy shape.

## Qualify and operate a consumer

1. Verify the exact public npm package version and provenance, CLI startup and reporting contract.
2. Pin `contextrail/reviewer/action` at an independently reviewed full public commit SHA and an
   exact npm package version in your composite caller. These are independent pins.
3. Confirm the chosen published reviewer and its selected contexts are readable from your MCP organization.
4. Configure your authorized expiring MCP and provider credentials through the consumer repository's secret facilities.
5. Under your organization's authorization, dispatch one small caller-authorized PR or apply `contextrail-review`.
   Verify fixed SHAs, installed package identity, unique runId, findings, retained evidence and reporting receipt.
   A local fixture pass does not establish hosted/provider/reporting qualification.

Rerun deliberately: use a fresh manual dispatch for current SHAs. For label-triggered callers,
re-running an old event rejects superseded comparisons; leaving its label attached is inert.
Removing/readding the label is another explicit paid request, and repeated requests
are not deduplicated. Review artifact and feedback status before spending again.

Disable via GitHub Actions' Disable workflow control (or remove subscriptions).
Clearing the npm version variable also makes setup fail before review. Rotate a
compromised/expired credential through the issuing service and GitHub secret under
owner authority; revoke the old token/key, update the named secret, then explicitly
check a new small run. Do not log credential values. Optional merge policy, workflow
name/concurrency and reusable reviewer ID are separate identities.

GitHub semantics: [composite metadata](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax),
[workflow contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts),
[event subscriptions](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
and [artifact retention](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-what-your-workflow-does/storing-and-sharing-data-from-a-workflow).

Read [PR feedback](review-results.md#pr-comments-and-inline-corrections) before enabling inline suggestions and [data handling](operations.md#data-handling-and-feedback) before enabling PR history.
