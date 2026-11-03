# ContextRail reviewer

[![npm latest version](https://img.shields.io/npm/v/@contextrail/code-review-agent/latest?label=npm%20latest)](https://www.npmjs.com/package/@contextrail/code-review-agent)
[![npm alpha version](https://img.shields.io/npm/v/@contextrail/code-review-agent/alpha?label=npm%20alpha)](https://www.npmjs.com/package/@contextrail/code-review-agent?activeTab=versions)

Check a pull request against your team's published engineering standards—with findings
that explain the rule, the affected code, and what to change.

You choose a reviewer skill in ContextRail and the model that performs the review.
The package retrieves that reviewer's published standards, inspects a fixed Git comparison,
and returns an outcome for every criterion. A final verification pass checks the assessment
before the package reports the result.

## What you get

- **A result for every criterion:** assessed, not applicable, or unresolved—with evidence.
- **Actionable findings:** code locations, consequences, and suggested corrections.
- **PR feedback:** a readable summary and optional inline comments and verified code suggestions.
- **Run visibility:** completion, timing, model usage, reported cost, and downloadable evidence.

A clean result applies to the examined scope. The reviewer inspects source; it does not run
your tests or certify compliance. Missing evidence stays visible instead of becoming a pass.

## Get started

You need Node 22.18.0+, Git 2.45+, a published ContextRail reviewer that selects standards,
ContextRail MCP access, and an OpenAI or OpenRouter API key.

| I want to…                             | Start here                                              |
| -------------------------------------- | ------------------------------------------------------- |
| Try a review locally                   | [Install and run](docs/getting-started.md)           |
| Review pull requests in CI             | [GitHub Actions setup](docs/github-actions.md)       |
| Understand a review result             | [Results and PR feedback](docs/review-results.md)    |
| Choose models, logging, or limits      | [Configuration](docs/configuration.md)               |
| Investigate a failed or incomplete run | [Operations and troubleshooting](docs/operations.md) |

Source and selected guidance are sent to your chosen model provider.
[Data handling and feedback](docs/operations.md#data-handling-and-feedback) explains what is stored and sent.

## Documentation

The [documentation index](docs/README.md) routes to the CLI and Action references,
review lifecycle, evidence contracts, and contributor instructions. Each page covers one task;
people and agents can follow the relevant links without loading the whole manual.

The `0.1.x` releases use the earlier reviewer. If you are upgrading, read the
[migration notes](docs/getting-started.md#upgrading-from-01x) and select a version deliberately.
The badges show the current `latest` and `alpha` npm channels.

## Development and license

ContextRail maintains this package. The public [reviewer repository](https://github.com/contextrail/reviewer)
is a distribution mirror; changes and version selection happen upstream.
See [contributing and releases](docs/contributing.md).

[Apache-2.0](LICENSE). The license covers this reviewer, its documentation and Action;
ContextRail services and guidance retrieved through MCP have separate terms.
