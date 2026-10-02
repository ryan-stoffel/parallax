#!/bin/sh
# A synthetic stand-in for the GitHub CLI in detection tests (PLX-336). Its output is invented, not
# captured from the real CLI.
#
# `gh --version` prints a version banner. Anything else behaves like `gh auth status`: stdout and
# exit from the FAKE_CLI_* variables.
if [ "$1" = "--version" ]; then
  printf 'gh version 2.100.0 (2026-09-01)\nhttps://github.com/cli/cli/releases/tag/v2.100.0\n'
  exit 0
fi
printf '%s' "${FAKE_CLI_STDOUT:-}"
exit "${FAKE_CLI_EXIT:-0}"
