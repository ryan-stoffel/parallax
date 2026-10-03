# 0040: Providers are instances a host keeps, and any ACP agent can run a thread

- Status: accepted; extends [0004](0004-subscription-providers.md) (which agents run threads) and [0012](0012-account-routing.md) (a subscription `AccountChoice` names an instance), and generalizes [0036](0036-cursor-threads.md)'s ACP driver
- Date: 2026-10-03
- Issue: PLX-366

## Context

Threads ran on three fixed backends: Claude Code, Codex, and Cursor Agent over `agent acp`. Ryan asked for many more: Antigravity, OpenCode 1.x and 2.x, Pi 1.0 and older Pi, Oh My Pi, Grok, Hermes Agent on Nous Portal, Ollama Cloud, OpenRouter, local models, and the agents in the ACP registry (Amp, goose, Kiro, Cline, Devin, and the rest). He wanted them managed the way T3 Code manages them: a provider is added with a + button, named, and configured with its binary, home folder, launch arguments, environment, and models.

Desk research and local runs on 2026-10-03 found:

- Most of these agents speak the Agent Client Protocol: `opencode acp` (1.18.34 and 2.0.22), `omp acp` (18.5.0), `hermes acp` (0.21.5), `grok agent stdio` (Grok Build), `goose acp`, `kiro-cli acp`, `devin acp`, `npx cline --acp`, and the 41 entries of the ACP registry (`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`).
- Pi 1.0 has no ACP; the `pi-acp` adapter runs `pi --mode rpc`. `pi-acp@0.0.34` needs Pi 0.81 or later; `pi-acp@0.0.27` runs Pi 0.73.
- The `agy` CLI has no ACP, and Antigravity's FAQ bars third-party software from a personal account. Google's own ACP server, `antigravity-acp` in the registry, is the path it publishes for other apps.
- Ollama Cloud, OpenRouter, llama.cpp's `llama-server`, LM Studio, and local Ollama all serve Anthropic's Messages API. Claude Code 2.1.288 ran a tool loop against `llama-server` with `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`, and reported `apiKeySource` `none`, as for a login.
- Grok Build is not part of Cursor: Cursor's staff said on 2026-09-10 that they are separate products, though Grok models also run in Cursor.
- Agents differ in how they take a model (`session/set_config_option` for a `model` config option, `session/set_model`, or a flag), a mode (a `mode` config option or `session/set_mode`), and sign-in (a `terminal` auth method, an `agent` method the client calls `authenticate` for, or neither).

## Decision

### Instances

- A host keeps its provider instances in `providers.json` in plxd's data folder: an id, a kind, a name, whether it's enabled, a program, a home folder, arguments, environment variables, and models the user added. A variable marked secret, such as an API key, is kept in the host's keychain as one JSON object per instance, never in the file, and never sent back.
- `claude`, `codex`, and `cursor` always exist and can only be turned off. Any number of other instances may be added, including a second instance of a built-in kind, such as a Codex with its own `CODEX_HOME`.
- `providers/list`, `providers/save`, and `providers/remove`, behind the `providers` capability, manage them. `providers/list` reports each instance's install, version, sign-in, models, the permissions and efforts it maps, and the command that signs it in, from a 30 s cache.
- Every enabled instance is a backend in the routing registry under its id, so `AccountChoice::Subscription { backend: <id> }` starts a thread on it. A built-in instance with no settings keeps the backend plxd registers at startup.

### Kinds

| Kind | Runs | Model | Plan | Bypass | Sign-in |
| --- | --- | --- | --- | --- | --- |
| Claude Code, Ollama Cloud, OpenRouter, local model | Claude Code (0034), with the instance's variables | `--model` | Claude Code's | Claude Code's | `claude auth login`, or the service's API key |
| Codex | `codex app-server` (0035), with the instance's `CODEX_HOME`, arguments after `app-server`, and variables | Codex's | none | Codex's | `codex login` |
| Cursor | `agent [--model] [--force] acp` (0036) | `--model` | `plan` mode | `--force` | `agent login` |
| OpenCode (1.x as `opencode`, 2.x as `opencode2`) | `opencode acp` | `model` config option | `plan` mode option, back to `build` | none | `opencode auth login` |
| Pi, Pi 0.x | `npx -y pi-acp@0.0.34`, or `@0.0.27` for Pi 0.73 | `model` config option or `session/set_model` | none | none | `pi`, then `/login` |
| Oh My Pi | `omp acp` | `model` config option | `plan` mode, back to `default` | none | `omp login` |
| Grok Build | `grok [--model] [--always-approve] agent stdio` | `--model` | none | `--always-approve` | `grok login` |
| Hermes Agent | `hermes acp`; Manual is its `default` mode, Edit `accept_edits`, Bypass `dont_ask` | `session/set_model` | none | `dont_ask` | `hermes setup --portal` |
| Antigravity | Google's `agy_acp_server.par`, with `ANTIGRAVITY_HARNESS_PATH` beside it and `GEMINI_HOME` as its home | ACP | none | none | its `authenticate` |
| ACP | the program and arguments the user or the registry gives | ACP | none | none | its `authMethods` |

- **ACP agents** share one backend, the Cursor driver of 0036 made generic: what differs is described per kind (program, arguments, a model flag, a bypass flag, a mode per permission, the mode a built plan returns to, and inherited variables to drop). A model goes as a `model` config option when the session lists one, else `session/set_model`; a mode as a `mode` config option, else `session/set_mode`. A tool call an agent leaves open when its turn ends is closed as failed, since Hermes Agent leaves a denied edit's call open. ACP threads keep 0036's rules: threads only, the agent's own sign-in only, and never a plxd key account. A turn's tokens are the `usage` on its `session/prompt` answer, which OpenCode sends and Cursor doesn't.
- **Model services run through Claude Code.** An Ollama Cloud, OpenRouter, or local model instance is Claude Code with `ANTHROPIC_BASE_URL` and the service's key as `ANTHROPIC_AUTH_TOKEN`, which Ollama Cloud requires as a bearer token. Its runs also get the thread's model behind every alias, for background tasks, and for subagents (`ANTHROPIC_DEFAULT_*_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`), unless the instance sets them, and `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`, so the user's settings can't send them elsewhere. Models are listed from the service's `/v1/models` with `curl`, so plxd needs no HTTP client.
- **Sign-in.** A kind with a login command runs it in the app's sign-in terminal. Another ACP agent's comes from its `initialize` answer: a `terminal` method's arguments after the agent's own command, or else `plxd acp-login --method <id> -- <command>`, which sends `initialize` and `authenticate` and waits for the agent's own browser flow. plxd's `initialize` says it can run terminal sign-ins (`auth.terminal`).
- **Probing.** An ACP agent is probed by starting it with a browser that opens nothing, sending `initialize` and `session/new` in the user's home folder, and reading its sign-in methods, whether the session opened, and its models; it is killed once it answers, or after 20 s.

### Cursor and Grok

- **Cursor stays on `agent acp`.** `@cursor/sdk` 1.0.35 needs a Cursor API key or its own browser login that mints one, runs tools with no approval callback, is a Node library that would need a sidecar beside plxd, and has no Windows arm64 build. Whether to add it as a second Cursor kind is Ryan's call (PLX-366).
- **Grok** runs two ways: Grok models through Cursor, and Grok Build as its own provider for a SuperGrok or X Premium+ login.

### The app

Settings > Providers lists a host's instances with an enable switch, and its + opens an Add provider dialog: a provider (a built-in kind, or an agent from the ACP registry, fetched by the app's main process, or one entered by hand), then a name and id, then the program, home, arguments, and environment. An instance's page edits the same settings and lists its models: favorites, visibility, and order are kept on the device, and models the user adds are kept on the host. The model picker offers every enabled instance's visible models, and a thread starts on the instance its model belongs to. A plxd without `providers` keeps the three fixed providers.

## Consequences

- An instance can run anything its agent can on the host as the user, as 0034, 0035, and 0036 record for their agents.
- Every agent's terms are the user's to accept. Parallax runs each vendor's own agent with the user's own sign-in, as 0004 decided; Antigravity runs only on Google's server for third-party clients.
- A model service's quality depends on the model: Anthropic doesn't support Claude Code with other models, and OpenRouter guarantees only Anthropic's own.
- Probing an ACP agent opens a session in some agents' history.
- ACP agents that put no `usage` on a turn's answer, such as Cursor, show no tokens on the Usage page.
- Registry agents distributed as binaries must be installed on the host by the user; the app doesn't download them yet.
