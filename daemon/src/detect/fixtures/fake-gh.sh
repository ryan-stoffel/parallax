#!/bin/sh
# A synthetic stand-in for the GitHub CLI in detection tests (PLX-336). Its output is invented, not
# captured from the real CLI.
#
# `gh --version` prints a version banner. Anything else behaves like `gh auth status`: stdout and
# exit from the FAKE_CLI_* variables.
# FAKE_GH_VERSION sets the version. At 2.45.0 it refuses `--active`, as gh before 2.57.0 does.
version="${FAKE_GH_VERSION:-2.100.0}"
if [ "$1" = "--version" ]; then
  printf 'gh version %s (2026-09-01)\nhttps://github.com/cli/cli/releases/tag/v%s\n' "$version" "$version"
  exit 0
fi
for arg in "$@"; do
  if [ "$arg" = "--active" ] && [ "$version" = "2.45.0" ]; then
    echo 'unknown flag: --active' >&2
    exit 1
  fi
done
printf '%s' "${FAKE_CLI_STDOUT:-}"
exit "${FAKE_CLI_EXIT:-0}"
