# 0070: Ollama Cloud runs on its API key without Claude Code

- Status: accepted
- Date: 2026-10-12
- Issue: PLX-761

## Context

Ollama Cloud ran as Claude Code pointed at `https://ollama.com` with an API key ([0040](0040-provider-instances.md)). Ryan wanted it without Claude Code, looking like an official Ollama provider: Ollama's logo in the composer, readable model names, and no other agent's name in the app. He chose Ollama Cloud as the only Ollama option, over also signing in through a local Ollama server.

Ollama has no OAuth for other apps and ships no coding agent of its own. Hermes Agent has an `ollama-cloud` provider built in, which calls Ollama Cloud's OpenAI-compatible API with `OLLAMA_API_KEY`, and plxd already runs Hermes Agent over ACP.

## Decision

- **`ollamaCloud` runs Hermes Agent**, `hermes acp`, with `HERMES_INFERENCE_PROVIDER=ollama-cloud` and the key in `OLLAMA_API_KEY`. Its home has no Hermes config, so that variable picks the provider and model ids are Ollama's own (`glm-5.3`). plxd lists the models from `https://ollama.com/v1/models` and never starts Hermes to probe.
- **Hermes stays out of sight.** On save, plxd gives the instance its own `HERMES_HOME` at `ollama-cloud/<id>` in its data folder, so Hermes shares none of the user's config, sessions, or memory. That home gets a `SOUL.md` presenting the agent as Ollama Cloud's, which Hermes keeps because it didn't write it. The app shows no Hermes version, path, or runtime settings for the kind. Install runs Hermes Agent's installer.
- **An `ollamaCloud` instance that sets `ANTHROPIC_BASE_URL`** was added before this record and keeps running Claude Code against ollama.com.
- **Model names** are written from the id: `glm-5.3` is `GLM 5.3`, `kimi-k2.7-code` is `Kimi K2.7 Code`, `gpt-oss:120b` is `gpt-oss 120B`.

## Rejected

| Option | Why not |
| --- | --- |
| A second, signed-in Ollama kind (Claude Code on the host's server after `ollama signin`) | Two Ollama providers confused people. Ryan chose Ollama Cloud alone. |
| OAuth | Ollama offers none to other apps. |
| A Parallax agent loop that calls Ollama Cloud | It would rebuild the tool loop, edits, shell, sandbox, approvals, and compaction that Hermes already has for Ollama Cloud. |
| Codex with an Ollama `model_providers` entry | ollama.com's support for the Responses API isn't confirmed. |

## Consequences

- Ollama Cloud needs Hermes Agent on the host, which Install puts there. The not-installed note names it, since the user has to know what to install.
- Hermes's system prompt still says it runs on Hermes Agent. The persona tells the model to describe itself as Ollama Cloud's agent, but a model may still mention Hermes.
- A bad key surfaces Hermes's own error text, which mentions `hermes setup`.
- Like Hermes Agent, Ollama Cloud runs a Project's agents only in Bypass.
