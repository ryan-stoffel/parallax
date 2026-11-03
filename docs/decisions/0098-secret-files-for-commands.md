# 0098: An agent's commands can use a secret the user enters privately

- Status: accepted; extends [0063](0063-schedules-pr-watches-and-delegation.md)
- Date: 2026-11-03
- Issue: PLX-1282

## Context

`request_secret` (0063) returns a `secretRef` that only `schedule_task` takes, so an agent has no private way to give a shell command a password, a token, or a `.env` file. It asks in chat or tells the user to run the command. T3 Code, which 0063 follows, has since added `delivery: "file"`.

## Decision

- **`request_secret` takes `delivery: "file"`,** as T3's. The default stays `secretRef`, with the same behavior as before.
- **The answer goes straight to a file,** `<data>/secrets/<run>/<id>`, with the file at 0600 and its folder at 0700, and the agent gets the path. It skips the keystore, since the file holds the value anyway. Unlike T3's, the file has no ref behind it.
- **A sandboxed thread reads only its own folder.** `worker_setup` adds it to the sandbox's read-only paths, and the rest of the data folder stays denied. A thread in no sandbox, such as one with approvals or in Bypass, runs as the user and can read any of the user's files, as it can today.
- **A file lasts 24 hours,** as a ref does. The expiry timer deletes it by the file's own age, so no record or migration is needed and a restart loses none. The timer runs only while a file or ref is outstanding.
- **The card says what's true.** With `file` it reads "Kept out of chat, in a private file this agent's commands can read for 24 hours", because "never the value" would be false. The desktop field keeps the newlines of a pasted `.env`, which a password field drops, and stays masked. iOS doesn't mask a multi-line field, so mobile keeps its single-line secure field. It shows a pasted env file's variable names and masks the rest, but only when the whole value reads as one, with two or more assignments, so a password or token containing `=` stays fully masked.
- **Agents are told,** in MCP's `instructions`, because Claude Code defers the tool behind its tool search. T3 Code measured 0 of 5 runs calling it for sudo without this. The instructions carry T3's sudo steps.

## Consequences

- The agent can read the value, and could print it into the transcript. The card says the first, and the instructions forbid the second, but nothing enforces that. Use the default `secretRef` wherever a tool takes one.
- A root command run with `sudo` can read the file too.
- Windows refuses both deliveries, as `request_secret` does until PLX-23.
- An app older than this one shows the keystore note for a file request, because it ignores `delivery`.
