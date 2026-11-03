# Install and run

[Documentation index](README.md) · [Reviewer overview](../README.md)

Use this guide for a first local review. For pull requests in CI, use [GitHub Actions](github-actions.md).

## Requirements

- Node >=22.18.0 and Git >=2.45.
- A Git repository containing both commits and their supporting objects.
- An authorized ContextRail MCP endpoint, organization ID, token, and published `skill://` reviewer ID.
- An OpenAI or OpenRouter account with a tool-capable model and API key.

The reviewer must select published contexts. An instruction-only skill has no criteria for this CLI to assess.

## Install an exact version

Inspect the available channels, then replace `EXACT_VERSION` with your chosen published version:

```sh
npm view @contextrail/code-review-agent dist-tags
npm install --ignore-scripts @contextrail/code-review-agent@EXACT_VERSION
./node_modules/.bin/contextrail-review --help
```

A source checkout's manifest version can be a development placeholder. For a public export,
`release.json` records its selected version and upstream source commit.

## Run a review

Export credentials through your secret manager or process environment. The CLI does not load
`.env` files. Replace the endpoint, organization, reviewer, repository, commit and model values:

```sh
export CONTEXTRAIL_MCP_URL='https://YOUR_CONTEXTRAIL_HOST/mcp'
export CONTEXTRAIL_MCP_ORG_ID='YOUR_ORGANIZATION_ID'
# Supply CONTEXTRAIL_MCP_AUTH_TOKEN and OPENAI_API_KEY securely.
./node_modules/.bin/contextrail-review review \
  --reviewer skill://your-domain/your-reviewer \
  --repo /path/to/repository --base BASE_COMMIT_SHA --head HEAD_COMMIT_SHA \
  --provider openai --model YOUR_OPENAI_MODEL_ID
```

For OpenRouter, supply `OPENROUTER_API_KEY` and use `--provider openrouter --model YOUR_MODEL_ID`.
The comparison is exactly base → head; the CLI does not choose a merge base or include uncommitted edits.
See [comparison and source scope](architecture.md#choose-the-reviewer-and-comparison).

The final console JSON gives the run directory and decision. Open
`.contextrail/reviewer/<run-id>/report.md` in the reviewed repository.
Check both the findings and completeness: a blocking result can still have unresolved criteria.
[Results and exit codes](review-results.md) explains the outcomes.

To check retrieval without a model call, replace `review` with `prepare` and omit provider/model.
Preparation success means the scope is ready, not that the code passed review.

Before sharing artifacts, read [data handling](operations.md#data-handling-and-feedback).
Use [configuration](configuration.md) for model overrides and budgets, or
[troubleshooting](operations.md#troubleshooting) if the run fails.

## Upgrading from 0.1.x

The package name is unchanged, but this is a replacement rather than a drop-in upgrade.
Use `contextrail-review`, not the old `code-review-agent` executable. Existing configuration and
reports are not automatically migrated; current report/state schema is version 2.
Update both the Action SHA and exact package version for CI. Prior bot history remains readable.
