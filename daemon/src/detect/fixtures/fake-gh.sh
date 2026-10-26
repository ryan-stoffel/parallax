#!/bin/sh
# A synthetic stand-in for the GitHub CLI in setup tests (PLX-336, PLX-423). Its output is
# invented. `gh --version` prints a version banner. Anything else behaves like `gh auth status`:
# stdout and exit from the FAKE_CLI_* variables.
version=2.100.0
if [ "$1" = "--version" ]; then
  printf 'gh version %s (2026-09-01)\nhttps://github.com/cli/cli/releases/tag/v%s\n' "$version" "$version"
  exit 0
fi
printf '%s' "${FAKE_CLI_STDOUT:-}"
exit "${FAKE_CLI_EXIT:-0}"
