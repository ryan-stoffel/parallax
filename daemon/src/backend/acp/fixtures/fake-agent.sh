#!/bin/sh
# A stand-in for Cursor's `agent` CLI in tests. It records its arguments, its environment, and
# every line plxd writes on stdin under $FAKE_AGENT_DIR, then replays $FAKE_AGENT_FIXTURE.
#
# Fixture lines starting with # are comments and blank lines are skipped. These directives act:
#   @read   read one line of stdin, or exit 0 if stdin has ended
#   @eof    read stdin until it ends
# Every other line goes to stdout as it is.

dir=$FAKE_AGENT_DIR
printf '%s\n' "$@" > "$dir/argv"
env > "$dir/env"
: > "$dir/stdin"
exec 3< "$FAKE_AGENT_FIXTURE"
while IFS= read -r line <&3; do
  case $line in
    '#'* | '') ;;
    '@read') IFS= read -r input || exit 0; printf '%s\n' "$input" >> "$dir/stdin" ;;
    '@eof') while IFS= read -r input; do printf '%s\n' "$input" >> "$dir/stdin"; done ;;
    *) printf '%s\n' "$line" ;;
  esac
done
exit 0
