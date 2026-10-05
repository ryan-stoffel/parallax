#!/bin/sh
# A synthetic stand-in for the codex CLI in detection tests (#114). Its output is invented, not
# captured from the real CLI; see #124 for recorded transcripts.
#
# `codex app-server` answers "Not initialized" unless its first NDJSON line is `initialize`, as the
# real one does; otherwise it reads `initialized` and one request, replies with
# $FAKE_CLI_APP_SERVER_RESPONSE (if set), then hangs like a real long-lived server until its group
# is killed. `codex --version`
# prints the real CLI's banner. Anything else behaves like `codex login status`: sleep, then
# stderr/stdout/exit from the FAKE_CLI_* variables.
if [ "$1" = "--version" ]; then
  echo "codex-cli 0.157.1"
  exit 0
fi
if [ "$1" = "app-server" ]; then
  IFS= read -r first
  case "$first" in
    *'"initialize"'*) IFS= read -r _initialized; IFS= read -r _request ;;
    *) printf '%s\n' '{"error":{"code":-32600,"message":"Not initialized"},"id":1}' ;;
  esac
  if [ -n "${FAKE_CLI_APP_SERVER_SLEEP:-}" ]; then sleep "$FAKE_CLI_APP_SERVER_SLEEP"; fi
  if [ -n "${FAKE_CLI_APP_SERVER_RESPONSE:-}" ]; then printf '%s\n' "$FAKE_CLI_APP_SERVER_RESPONSE"; fi
  while :; do sleep 60 & wait $!; done
fi
if [ -n "${FAKE_CLI_SLEEP:-}" ]; then sleep "$FAKE_CLI_SLEEP"; fi
if [ -n "${FAKE_CLI_STDERR:-}" ]; then printf '%s' "$FAKE_CLI_STDERR" >&2; fi
printf '%s' "${FAKE_CLI_STDOUT:-}"
exit "${FAKE_CLI_EXIT:-0}"
