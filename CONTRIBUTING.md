# Contributing

Thanks for wanting to help. Review time is limited, so opening a PR does not guarantee a review or a merge. A PR that follows this guide is much more likely to get both.

To build and run Parallax, see [Build from source](README.md#build-from-source).

## Agree on the problem first

Report bugs in [issues](https://github.com/ryan-stoffel/parallax/issues), and search existing issues before you start.

A new feature or a change to how the product behaves needs an issue where Ryan has agreed to the direction and scope before you write it. Link that agreement in your PR. A larger bug fix should link an issue that describes the failure and the expected behavior.

A small, focused fix for an obvious bug can skip the issue. Explain the bug in the PR and why the fix is that small.

## Solve one problem per PR

Split independent fixes into separate PRs, even when each is useful. Include everything that one problem needs, such as tests and docs, but leave unrelated cleanup and refactors for their own PRs.

## Show that it works

Explain how you reproduced the problem, how you checked the fix, and what you saw. List the tests or manual checks you ran and their results, and say what you could not check. "Tests pass" alone is not evidence.

UI changes need before and after screenshots, plus a short recording when motion or interaction matters. Attach them to the PR and don't commit them.

## Open the PR

1. Fork the repo and create a branch from `develop`. Any branch name works.
2. Open the PR against `develop` and fill in [the template](.github/pull_request_template.md). The `Linear:` line is for maintainers, so delete it.
3. Write the PR title as a [Conventional Commit](https://www.conventionalcommits.org/) in plain language, such as `fix: new threads no longer spike CPU`. PRs are squash-merged, so the title becomes the commit message.
4. If an agent wrote the code, end the description with the model and harness, such as "Changes made by Claude Opus 5.5 in Claude Code."

CI waits for a maintainer's approval before it runs on your PR. Only a maintainer can merge, and a merged PR ships in the next nightly.

## Security

Don't report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## License

Contributions are licensed under [Apache-2.0](LICENSE), the same as the project.
