# 0106: The user saves secrets every agent can use until they expire

- Status: accepted; extends [0098](0098-secret-files-for-commands.md)
- Date: 2026-11-14
- Issue: PLX-1558

## Context

A secret given through the card (0098, 0099) lasts 24 hours and belongs to the thread that asked. An agent that needs the same sudo password or API key in another thread, or the next day, asks again.

## Decision

- **Settings › Secrets saves a secret on a computer, by name,** with an expiry: never, 1, 7, 30, or 90 days, or the end of a picked day. Saving a name again replaces it. The app lists names and expiries, never values.
- **The value goes to the keystore under the secret's id,** as a ref's does. The store's `saved_secrets` table holds the id, name, and times. `secret/list`, `secret/save`, and `secret/delete` are the app's, behind the `savedSecrets` capability, and refused for a read-only device.
- **An agent uses one with `use_secret { name }`,** which copies the value to a new file in its thread's secrets folder, as `delivery: file` does, and returns the path with no card. The thread's sandbox reads that folder, and the copy goes after 24 hours. The agent can call again.
- **Each thread's instructions name the saved secrets,** after 0098's text, as they are when its CLI starts. They say to use one instead of `request_secret`, and to run sudo with it right away, without trying `sudo -n` first.
- **The expiry timer that removes refs also removes expired saved secrets** and their keystore values. `use_secret` refuses one past its expiry before the timer runs.
- **Text values only.** A binary file, such as a `.p12`, still goes through the card's file input.

## Consequences

- Any thread on the computer can read a saved secret, including one the user didn't expect to need it. The page says so.
- A thread whose CLI started before a secret was saved doesn't know its name until its CLI restarts. It can still call `use_secret` if told the name.
- Windows refuses, as `request_secret` does until PLX-23.
- The phone app has no Secrets page yet.
