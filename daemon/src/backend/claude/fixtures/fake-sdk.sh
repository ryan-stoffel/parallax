#!/bin/sh
# A stand-in for the Claude Agent SDK sidecar in tests (sdk.rs, sidecar/claude), one query at a
# time. It records each query's `open` line, a copy of its $CLAUDE_ENV_FILE, and what plxd sends
# its CLI's stdin under $FAKE_CLAUDE_DIR, then replays $FAKE_CLAUDE_FIXTURE as that CLI's stdout,
# each line after the query's id, and reports how the CLI exited. It exits once stdin closes.
#
# Fixture lines starting with # are comments and blank lines are skipped. These directives act:
#   @read          wait for one stdin line, or exit 0 if the prompt has ended
#   @eof           wait for the prompt to end
#   @sleep <s>     sleep
#   @stderr <text> add a line to the CLI's stderr
#   @exit <code>   exit
#   @trap-int      an interrupt exits 130 and records SIGINT; prints @trap-armed
#   @ignore-int    an interrupt does nothing, as an interrupt the CLI never answers
#   @hang          wait until the query is killed or exits on an interrupt
# Every other line is the CLI's stdout. An interrupt otherwise exits as SIGINT did, by signal 2,
# and a kill by signal 9.

dir=$FAKE_CLAUDE_DIR

# Reports the query's exit: code $1, signal $2, each a number or null.
finish() {
  printf '%s exit {"code":%s,"signal":%s,"stderr":"%s"}\n' "$id" "$1" "$2" "$stderr"
  done=1
}

# Takes one line from plxd: 0 for a stdin line (recorded), 1 for the end of the prompt, 2 once
# the query has exited, 3 for an interrupt it ignored.
frame() {
  IFS= read -r line || { finish null 9; return 2; }
  case $line in
    *'"stdin":'*)
      printf '%s\n' "$line" | sed 's/^{"id":"[^"]*","stdin":\(.*\)}$/\1/' >> "$dir/stdin"
      return 0 ;;
    *'"type":"end"'*) ended=1; return 1 ;;
    *'"type":"kill"'*) finish null 9; return 2 ;;
    *'"type":"interrupt"'*)
      if [ -n "$trap_int" ]; then
        echo SIGINT >> "$dir/signals"
        finish 130 null
        return 2
      fi
      [ -n "$ignore_int" ] && return 3
      finish null 2
      return 2 ;;
  esac
  return 3
}

: > "$dir/stdin"
while IFS= read -r open; do
  case $open in *'"type":"open"'*) ;; *) continue ;; esac
  printf '%s\n' "$open" > "$dir/open"
  env_file=$(printf '%s' "$open" | sed -n 's/.*"CLAUDE_ENV_FILE":"\([^"]*\)".*/\1/p')
  if [ -n "$env_file" ]; then cp "$env_file" "$dir/env-file"; fi
  id=$(printf '%s' "$open" | sed -n 's/^{"id":"\([^"]*\)".*/\1/p')
  stderr= trap_int= ignore_int= done= ended=
  exec 3< "$FAKE_CLAUDE_FIXTURE"
  while [ -z "$done" ] && IFS= read -r line <&3; do
    case $line in
      '#'* | '') ;;
      '@read')
        while :; do
          if [ -n "$ended" ]; then finish 0 null; break; fi
          frame
          case $? in 0 | 2) break ;; esac
        done ;;
      '@eof') while [ -z "$ended" ] && [ -z "$done" ]; do frame; done ;;
      '@hang') while [ -z "$done" ]; do frame; done ;;
      '@sleep '*) sleep "${line#@sleep }" ;;
      '@stderr '*) stderr="$stderr${stderr:+\\n}${line#@stderr }" ;;
      '@exit '*) finish "${line#@exit }" null ;;
      '@trap-int') trap_int=1; printf '%s %s\n' "$id" @trap-armed ;;
      '@ignore-int') ignore_int=1 ;;
      *) printf '%s %s\n' "$id" "$line" ;;
    esac
  done
  exec 3<&-
  [ -n "$done" ] || finish 0 null
done
