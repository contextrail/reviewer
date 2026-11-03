# Reviewer documentation

[Documentation index](README.md) · [Reviewer overview](../README.md)

Start with the task you need to perform. These pages are shared by the source checkout and public reviewer distribution.

| Task                             | Page                                         | Contents                                               |
| -------------------------------- | -------------------------------------------- | ------------------------------------------------------ |
| Run the CLI for the first time   | [Getting started](getting-started.md)        | Requirements, installation, first review, migration    |
| Configure a run                  | [Configuration](configuration.md)            | Credentials, model selection, phase overrides, limits  |
| Connect a repository             | [GitHub Actions](github-actions.md)          | Setup, event policy, permissions, version pins         |
| Look up an Action setting        | [Action reference](action-reference.md)      | Inputs, outputs, credential boundaries, publication    |
| Act on a review                  | [Results and PR feedback](review-results.md) | Findings, scores, exit codes, inline comments, history |
| Diagnose or resume a run         | [Operations](operations.md)                  | Artifacts, logs, cost, recovery, data handling         |
| Understand or change the harness | [Architecture](architecture.md)              | Governing scope, preparation, model phases, validation |
| Develop or publish the package   | [Contributing](contributing.md)              | Verification, export, npm contents, ownership          |

## Reading guidance for agents

Load the page for the current task first; follow its cross-links when a specific setting or
contract matters. Do not ingest every page as a default prompt. The CLI's `--help` and
[Action metadata](https://github.com/contextrail/reviewer/blob/main/action/action.yml) define the
executable interface. These docs explain its use; the selected published reviewer and contexts
define the criteria for a review. Documentation and PR discussion do not override those criteria.
