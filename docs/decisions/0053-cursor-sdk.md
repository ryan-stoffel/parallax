# 0053: Cursor runs through the official SDK

- Status: accepted; supersedes the Cursor parts of [0036](0036-cursor-threads.md) and [0040](0040-provider-instances.md)
- Date: 2026-10-04

## Context

0036 ran Cursor threads through `agent acp`, the Cursor CLI's Agent Client Protocol. That CLI is the old integration. Cursor's current one is `@cursor/sdk`: a Node library, local agents, and a browser login that mints a user API key. 0040 left the CLI in place because the SDK needed a sidecar, had no approval callback, and had no Windows arm64 build. Ryan asked to switch to the SDK and to sign in with a Cursor account, the way T3 Code does.

## Decision

- **Backend `cursor`** runs `@cursor/sdk` local agents in a Node sidecar, `sidecar/cursor`, which plxd starts. The sidecar is what a remote `plxd attach` host runs, so the Electron app is not the runtime. It needs Node.js 22.13 or newer. The script and `node_modules` ship beside `plxd`. `PLXD_CURSOR_SDK` overrides the program in tests.
- **Sign-in** follows T3 Code's `CursorAuth`. `Cursor.auth.login()` runs with the browser left to the app (`cursor/signIn` returns the URL; `cursor/signInCancel` and `cursor/signOut` stop or forget it), names the key `Parallax - <instance>`, and writes into an in-memory store. The key is then saved to plxd's data folder, `cursor-sdk/<instance>/auth.json`, checked with `Cursor.me`, and cleared if Cursor rejects it. A stored key past its expiry counts as signed out. Status is `Cursor.me` too.
- **API key.** A `CURSOR_API_KEY` set on the provider instance wins over the browser login, and plxd refuses sign-in and sign-out for that instance, as T3 does. An ambient `CURSOR_API_KEY` is still not a fallback (0004): inherited `CURSOR_*` variables are dropped, and the sidecar deletes every `CURSOR_*` after reading the instance's key. A key kept as a secret is not read by `providers/list`, which reports the instance signed in without models rather than wait on the keychain.
- **Agent options** are T3's `makeCursorAgentOptions`: setting sources `project`, `user`, `team`, `mdm`, and `plugins`; `enableAgentRetries`; `autoReview` on while the mode still asks, which is Plan and Auto; the sandbox off only for Bypass, with a bare sandboxed workspace warmed first because the SDK caches "sandbox unsupported" after an unsandboxed run. Mode, model, and MCP servers go on every send.
- **Permissions.** Edit, Plan, and Auto run sandboxed, Plan in plan mode. Auto's classifier denies instead of asking, so an Auto Project can use Cursor. There is no Manual, and there is no interactive approval for shell or file tools.
- **Plans.** A plan arrives as the SDK's `createPlan`, which the app shows as a proposed plan, and the turn ends there, as in T3. Building it is the next message, after the user switches the thread out of Plan.
- **Sessions.** The sidecar keeps a JSONL agent store next to the auth file. A follow-up during a turn cancels that turn and starts another, as 0048 described for Cursor. Fork stays unsupported, and there is no worker sandbox.
- **Models** come from `Cursor.models.list` when the account is signed in. Omitting a model uses `auto`.
- **Usage** in Settings still reads Cursor's desktop database. This record does not change that.

## Consequences

- A host without Node.js 22.13 or newer can list Cursor and is told what it needs; it cannot sign in or run a thread until Node is there.
- Windows arm64 may still lack the SDK's native package. The sidecar reports that as a failed start rather than pretending the CLI is there.
- ACP stays the driver for OpenCode, Pi, Hermes, Grok Build, Antigravity, and other ACP agents. Only Cursor leaves it.
