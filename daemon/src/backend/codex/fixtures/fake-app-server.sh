#!/bin/sh
# A stand-in for `codex app-server` in tests. It records its arguments and environment under
# $FAKE_CODEX_DIR, then plays $FAKE_CODEX_FIXTURE, a conversation, line by line:
#   <       read one line of stdin and append it to $FAKE_CODEX_DIR/stdin, waiting for it
#   #...    a comment; blank lines are skipped too
# Every other line goes to stdout as it is. At the end it records the rest of stdin, so it exits
# once plxd closes stdin, as app-server does.

dir=$FAKE_CODEX_DIR
printf '%s\n' "$@" > "$dir/argv"
env > "$dir/env"
exec 3< "$FAKE_CODEX_FIXTURE"
while IFS= read -r line <&3; do
  case $line in
    '#'* | '') ;;
    '<') IFS= read -r input && printf '%s\n' "$input" >> "$dir/stdin" ;;
    *) printf '%s\n' "$line" ;;
  esac
done
cat >> "$dir/stdin"
exit 0
