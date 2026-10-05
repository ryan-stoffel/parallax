# 0055: OpenCode runs through its HTTP server

- Status: accepted; supersedes the OpenCode row of [0040](0040-provider-instances.md)
- Date: 2026-10-05
- Issue: PLX-559

## Context

0040 ran OpenCode as `opencode acp`, which always starts a server of its own and can't use one the user already runs. T3 Code talks to OpenCode's HTTP server, the API `opencode serve` exposes, so a user can point it at a server URL with a password. Ryan asked for the same.

Runs against `opencode serve` 1.18.34 on 2026-10-05 found:

- The server asks for HTTP basic auth when `OPENCODE_SERVER_PASSWORD` is set: the user is `OPENCODE_SERVER_USERNAME` or `opencode`. Every route answers 401 without it. `OpenCode` passes its environment to the tools it runs, so the agent's shell can read the password.
- A session's `permission` rules come after its agent's, and the last match wins. The `build` and `plan` agents allow `*` by default, so `OpenCode` never asks unless rules say so. `PATCH /session/<id>` appends rules and never replaces them.
- A turn is a `POST /session/<id>/prompt_async`. `/event` streams every session of a folder as server-sent events, and a turn ends with `session.idle`, or with a `session.error` alone when the request is refused, such as for an unknown agent. An abort sends `MessageAbortedError` and then idles twice.
- OpenCode 2.0.22's `serve` is another API, an "experimental HttpApi surface" under `/api`, and answers 1.x's routes with its web app.

## Decision

- **The server.** An instance with `OPENCODE_SERVER_URL` uses that server. Without it, each run starts `opencode serve --hostname 127.0.0.1 --port 0` with the instance's program, arguments, home, and variables, reads the URL it prints, and stops it with the run. A started server gets the instance's `OPENCODE_SERVER_PASSWORD`, or a random one, so it is never open to the host's other users. The URL, password, and username variables go to nothing else.
- **The client is `curl`**, as a model service's model list already is (0040): each call is one run with the credentials and the JSON body as a curl config on stdin, which `ps` never shows, and the event stream is one `curl -N`. plxd needs no HTTP crate, and an https URL works.
- **Turns** go as in 0040's ACP driver: a follow-up waits for the turn, a steer aborts it and goes next, a finished run resumes its session in a new run, and a turn's error fails the run. The model is `providerID/modelID`, and Plan uses the `plan` agent.
- **Access levels (0054).** Each run appends rules for `bash` and `edit` to its session, so the latest level wins: Supervised asks for both, Auto-accept edits allows `edit`, Plan denies `edit`, and Full access allows both. plxd answers any other request by level, as it does for ACP agents. A question for the user is rejected.
- **Parallax's tools** (0041) go through `POST /mcp` under a name of the run, since a server's MCP servers are shared by its folder's sessions, and are disconnected when the run ends.
- **Probing** reads `/global/health` and `/config/providers` from the URL, or from a server started in the user's home and stopped after. A password kept as a secret isn't read (0040), so such a server's models aren't listed, and its threads run on the model the user adds or on the server's default. The probe says whether the server was reachable.
- **OpenCode 2 isn't run.** Its API is experimental and differs from 1.x's, so a server that doesn't answer as 1.x does fails the run and the probe with that reason (PLX-566).

## Consequences

- A user's own server can run Parallax's threads, on this host or another.
- Every HTTP call starts a `curl` process, a few per turn.
- OpenCode's own slash commands aren't in the `/` menu, since over HTTP they need `POST /session/<id>/command` (PLX-565).
- On a shared server, a thread's Parallax tools are visible to other sessions in the same folder while it runs.
