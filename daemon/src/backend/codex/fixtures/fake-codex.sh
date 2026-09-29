#!/bin/sh
# A stand-in for the codex CLI in tests. It records its arguments, its environment (whose PWD is
# its working directory), and stdin, which it reads to the end first as `codex exec -` does, under
# $FAKE_CODEX_DIR. Then it replays $FAKE_CODEX_FIXTURE line by line, or $FAKE_CODEX_KEY_FIXTURE
# when it has an API key, as an account fallback's second attempt does.
#
# Fixture lines starting with # are comments and blank lines are skipped. These directives act:
#   @stderr <text>  write a line to stderr
#   @exit <code>    exit
#   @trap-int       on SIGINT, record it and exit 1 as exec does; prints @trap-armed once
#                   installed, a deterministic handshake so a test never cancels before the trap
#   @hang           wait forever, in foreground one-second sleeps: bash 3.2 leaves a trap pending
#                   through `wait` if the signal lands just before it, but runs it as soon as a
#                   foreground command ends (RYA-120)
# Every other line goes to stdout as it is.

dir=$FAKE_CODEX_DIR
fixture=$FAKE_CODEX_FIXTURE
if [ -n "${CODEX_API_KEY-}" ] && [ -n "${FAKE_CODEX_KEY_FIXTURE-}" ]; then
  fixture=$FAKE_CODEX_KEY_FIXTURE
fi
printf '%s\n' "$@" > "$dir/argv"
env > "$dir/env"
cat > "$dir/stdin"
exec 3< "$fixture"
while IFS= read -r line <&3; do
  case $line in
    '#'* | '') ;;
    '@stderr '*) printf '%s\n' "${line#@stderr }" >&2 ;;
    '@exit '*) exit "${line#@exit }" ;;
    '@trap-int') trap 'echo SIGINT >> "$dir/signals"; exit 1' INT; printf '%s\n' @trap-armed ;;
    '@hang') while :; do sleep 1; done ;;
    *) printf '%s\n' "$line" ;;
  esac
done
exit 0
