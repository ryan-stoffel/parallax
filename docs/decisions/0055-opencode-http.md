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
- A `task` subagent's session takes only its parent's `deny` and `external_directory` rules and runs on an agent that allows everything, so a parent's `ask` never reaches it: a Supervised session's subagent wrote a file with no request.
- Rejecting a permission without a message, or rejecting a question, ends the turn; with a message the agent goes on, unless `experimental.continue_loop_on_deny` is set. Rejecting one request rejects the session's other pending ones without a message, each with a `permission.replied`, so denying one of several parallel requests ends the turn. Tools other than `question` can ask questions too. The experimental `plan_exit` (behind `OPENCODE_EXPERIMENTAL_PLAN_MODE`) asks whether to switch to `build` and takes any answer but its "no" as approval: answered with a note, it switched a Plan thread to `build`.
- OpenCode 2.0.22's `serve` is another API, an "experimental HttpApi surface" under `/api`, and answers 1.x's routes with its web app.

## Decision

- **The server.** An instance with `OPENCODE_SERVER_URL` uses that server. Without it, each run starts `opencode serve --hostname 127.0.0.1 --port 0` with the instance's program, arguments, home, and variables, reads the URL it prints, and stops it with the run. A started server gets the instance's `OPENCODE_SERVER_PASSWORD`, or a random one, so it is never open to the host's other users. The URL, password, and username variables go to nothing else.
- **The client is `curl`**, as a model service's model list already is (0040): each call is one run with the credentials and the JSON body as a curl config on stdin, which `ps` never shows, and the event stream is one `curl -N` that fails after a minute without data (the server sends heartbeats). curl skips the proxy for loopback hosts and the hosts the environment's `NO_PROXY` names, so no proxy sees a local server's password, and uses it for any other server, where a proxy sees an `http://` server's password. The URL must be `http://` or `https://`. plxd needs no HTTP crate, and an https URL works.
- **Turns** go as in 0040's ACP driver: a follow-up waits for the turn, a steer aborts it and goes next, a finished run resumes its session in a new run, and a turn's error fails the run. The model is `providerID/modelID`, and Plan uses the `plan` agent.
- **Access levels (0054).** Each run appends rules to its session, so the latest level wins: Supervised asks for `bash` and `edit`, Auto-accept edits allows `edit`, Plan denies `edit`, and Full access allows both. Below Full access `task` is denied, so no subagent runs outside the level. `question` is always denied, as the app has no card for it, and so is `plan_exit`, so the agent never leaves Plan on its own. plxd answers any other request by level, as it does for ACP agents. A rejection carries the user's message or a default one, so denying a single request lets the agent go on, and only an interrupt ends the turn. A `permission.replied` withdraws a request answered elsewhere or rejected with a sibling. A server plxd starts gets `OPENCODE_CONFIG_CONTENT` with `continue_loop_on_deny`, unless the instance or plxd's environment sets that variable, so denying one of several parallel requests doesn't end its turn either; on a URL server it does. Any question that still reaches plxd is answered with a note to ask in the reply instead.
- **Parallax's tools** (0041) go through `POST /mcp` under a name of the run, since a server's MCP servers are shared by its folder's sessions, and are disconnected when the run ends.
- **Probing** reads `/global/health` and `/config/providers` from the URL, or from a server started in the user's home and stopped after. A password kept as a secret isn't read (0040), so such a server's models aren't listed, and its threads run on the model the user adds or on the server's default (PLX-567). The probe says whether the server was reachable.
- **OpenCode 2 stays on ACP.** Its API is experimental and differs from 1.x's, so an instance whose program is `opencode2` runs `opencode2 acp` as 0040 had it, until PLX-566. Any other server that doesn't answer as 1.x does fails the run and the probe with that reason.

## Consequences

- A user's own server can run Parallax's threads, on this host or another.
- Every HTTP call starts a `curl` process, a few per turn.
- OpenCode's own slash commands aren't in the `/` menu, since over HTTP they need `POST /session/<id>/command` (PLX-565).
- On a shared server, a thread's Parallax tools are visible to other sessions in the same folder while it runs.
- Below Full access an OpenCode thread has no subagents. A `deny` an earlier run appended stays in the session for later subagents, which keep only denials.
- A server plxd started outlives a plxd that crashes (PLX-568).
- A URL server whose password is a keychain secret lists no models until PLX-567.
- Supervised asks only for `bash` and `edit`: `webfetch` and the user's own MCP tools run without a card (PLX-570).
