# 0089: A host keeps CLIProxyAPI hubs, and each runs Claude Code and Codex through it

- Status: accepted; carries out [0088](0088-hubs.md)'s hubs, and extends [0040](0040-provider-instances.md)
- Date: 2026-10-27
- Issue: PLX-1069

## Context

0088 makes a [CLIProxyAPI](https://help.router-for.me/) hub the supported way to use many Claude and Codex accounts. A hub holds the sign-ins on one always-on machine and serves `/v1` with one of its `api-keys`, and its management API (`/v0/management`, with a management key) lists the accounts and can call a service with one of their tokens. Theo's [setup guide](https://gist.github.com/t3dotgg/59a521d2ee8d70aaf90e280c175072af) points each client at it by hand: `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` in Claude Code's settings, and a `model_providers` entry in Codex's `config.toml`. T3 Code reads a hub's accounts and limits but leaves the routing to those files.

## Decision

- **A host keeps hubs.** `hubs/list`, `hubs/save`, and `hubs/remove`, behind the `hubs` capability, manage each hub's id, name, URL, whether it's enabled, its access key, and an optional management key. Hubs are kept in `hubs.json` in plxd's data folder and both keys in the keychain as one JSON object per hub, as 0040 keeps an instance's secrets. No key is ever listed: a hub says only whether it has a management key. `hubs/save` keeps a key it isn't sent, and an empty management key removes it.
- **A hub adds two instances.** Each enabled hub adds `<id>-claude` and `<id>-codex` to `providers/list` and the routing registry, named after the hub, with `hub` set on their `ProviderInfo`. They aren't in `providers.json`, and `providers/save` and `providers/remove` refuse their ids, so they change only with their hub. A hub id is at most 48 characters, so theirs stay within 64, and a hub can't take an id another instance has.
  - The Claude Code one runs with `ANTHROPIC_BASE_URL=<url>` and the access key as `ANTHROPIC_AUTH_TOKEN`, on the user's own Claude Code config otherwise, as 0040's model services do.
  - The Codex one runs `codex app-server` with `-c` overrides, passed as arguments and never through a shell: `model_provider="parallax-hub"` and `model_providers.parallax-hub` with the hub's name, `base_url=<url>/v1`, `wire_api="responses"`, `requires_openai_auth=false`, `supports_websockets=true`, and `env_key="PARALLAX_HUB_KEY"`, which carries the access key. `config.toml` isn't touched.
  - Their secrets are read when a run starts, as 0040's are. Neither probes the user's own sign-in.
- **Status and models.** `GET <url>/v1/models` with the access key says whether the hub answers. Its Claude models (`claude…`, or `owned_by: anthropic`) go to the Claude Code instance, and every other model to the Codex one, so only Claude models go through Claude Code. An instance is signed in while its hub answers.
- **Accounts and limits.** With a management key, `GET /v0/management/auth-files` lists the hub's accounts with their provider, email, plan, and whether they're disabled. Each enabled Claude and Codex account's limits come from `POST /v0/management/api-call`, which calls Anthropic's OAuth usage or ChatGPT's `wham/usage` with that account's token, as T3 Code does, mapped to `five_hour`, `seven_day`, and `seven_day_<model>` as `usage/limits` names them. At most four are read at once.
- **Requests.** Every request goes through `curl -q -K -`, with the URL, key, and body on stdin, a 15 s limit, and no `.curlrc`. A hub's answers can hold tokens, so no body is logged or returned: an error names only the kind of failure and the HTTP status. A hub's answers are kept 30 s, as 0040's probes are.
- **The app.** Settings > Providers lists hubs in their own group, out of the instance list, with Add hub, whose dialog takes the name, URL, access key, optional management key, and which connected computers with `hubs` to add it to, all at once. A hub's page shows whether it answers, its models, and its accounts with plan and limits, emails blurred (PLX-1067), and Remove. The model menu gives each hub its own rail entry, with a provider dropdown for its Claude Code and Codex runtimes, showing their SVG logos and only the hub's models. Raw model slugs get readable labels (such as `GPT 6.1 Terra`), while upstream human labels, custom names, and the exact model IDs used for routing remain intact. Underlying sign-in accounts remain routed by CLIProxyAPI. (PLX-1221 replaces the original shared provider rail.) The several-accounts warning (0088) opens Settings > Providers > Hubs.

## Consequences

- Listing hubs, and probing their instances, reads their keys from the keychain, since `/v1/models` needs the access key. 0040 never reads a secret in a list; macOS may ask the user to allow plxd once after it updates.
- The access key is in the environment of everything a hub's run starts, as a model service's key is.
- Signing accounts in to a hub, and turning them on and off, go through the same management API (PLX-1070).
