# 0096: The app can keep every computer on one list of providers

- Status: accepted; extends [0040](0040-provider-instances.md)
- Date: 2026-11-01
- Issue: PLX-1225

## Context

Each plxd keeps its own `providers.json` (0040), and the model picker lists the providers of the computer a thread runs on. Someone using the app across computers sees a different set on each, and it looks like the picker is wrong (PLX-1221). They asked for a setting that keeps the list the same everywhere.

## Decision

- **The app keeps the list.** Settings > Providers has "Link providers across computers" when there's more than one computer. Turning it on takes the computer on show as the list, in this app's `localStorage`. plxd doesn't change, so a computer on an older nightly with `providers` can follow it too.
- **A computer follows the list through its own `providers/*`.** Each connected computer adds what it lacks and updates what differs, as does one that connects later.
- **A provider outside the list is turned off, not removed.** `providers/remove` deletes an instance's secrets, so linking can't lose anything, and unlinking leaves each computer as it is.
- **Changes spread while linked.** A save or remove in Settings or Add provider updates the list and every other connected computer. A remove is the one that deletes elsewhere, since someone asked for it, and its confirmation says so.
- **What's copied, and what isn't.** Name, on or off, arguments, plain variables, and models are copied. A secret's value never is, since plxd never lists one, and a save strips it from the list first, so the app stores none. A computer keeps its own secrets, CLI path, and existing home. A new second account gets its home as `~/...`, which each computer reads as its own. Ollama Cloud's home is the one plxd makes in its data folder.
- **Hubs stay per computer.** Their keys can't leave a keychain, and 0089's Add hub already adds one to several computers at once.
- **An id of another kind is reported, not overwritten,** since a saved instance's kind can't change.

## Consequences

- A provider can be listed on a computer but missing from its model picker until that computer has its CLI, sign-in, or API key, as the picker lists only what can run.
- A provider turned off by linking still shows as Off in that computer's list.
- The list belongs to one app install. Two installs linked with different lists each put a computer back on their own list when they connect to it. Moving the list to the account would fix that, and nothing needs it yet.
