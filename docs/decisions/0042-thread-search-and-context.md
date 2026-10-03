# 0042: Threads are searched by their messages and attached to a prompt as a capped summary

- Status: accepted
- Date: 2026-10-03
- Issue: PLX-372 (part of PLX-368)

## Context

PLX-368 lets the user attach another thread to a prompt, with `@` in the composer or by dragging it from the sidebar (PLX-378), and gives every agent the MCP tools `thread_search` and `thread_read`. Both need plxd to find a host's threads by what was said in them, and to put an attached thread into a prompt. 0014 already renders a run's conversation for a new session that takes it over (`sendAccount`): the user's messages, Parallax's wake-ups, and the agent's replies, without tool calls, cut from the front to about 64 KiB.

## Decision

Behind a new `threadContext` capability, whose options are `maxThreads` (8) and `maxSummaryBytes` (32 KiB):

| Method | Params | Result |
| --- | --- | --- |
| `thread/search` | `{query, limit?}` | `{threads: Thread[]}`, the newest `lastPromptAt` first |

- **Search** matches the trimmed query, as SQLite's `LIKE` (case-insensitive for ASCII only, `%` and `_` literal), in a thread's prompt, its sent turns, and the `text` items of its `agent.output` events. Tool calls and their output don't count. `limit` is 20 by default and at most 100. An empty query, or one over 1 KiB, is `invalidParams`. Titles live only in the app until PLX-369 stores them; search matches them once it does.
- **Attaching.** `agent/start`, `thread/start`, and `agent/send` take `threads: [runId]`. plxd drops repeats, refuses more than 8 (`invalidParams`) and any id with no thread row (`threadNotFound`) before anything starts, and doesn't compare them on a retry, as with images (0026).
- **The summary** is 0014's renderer with a cap of 32 KiB per thread instead of 64 KiB. plxd reads the thread's events newest first, 100 at a time, and stops once the cap is full, so a long thread's older events and tool output are never loaded. Each thread is `<thread id="…">` around its conversation, under one line saying the user attached them, and the user's text follows as "The user's message". A worker's first prompt wraps all of it as before.
- **When.** plxd renders the summaries when the message reaches a CLI: at start, on a follow-up to a running CLI, on a resume, or when a waiting message is sent. So a waiting message carries only the ids, and an attached thread that kept working is summarized as it stands then.
- **The transcript.** The run's `prompt` and a follow-up's `turnStarted.text` stay the user's own words. That message's `turnStarted` lists the attached ids in `threads`. So a handoff (0014) of a run that had threads attached carries the user's words, not the summaries.

## Consequences

- PLX-378's `@` menu and drag, and the MCP's `thread_search` and `thread_read`, sit on these methods.
- A thread title match waits on PLX-369's `title` column.
- Search scans a thread's `agent.output` events with a JSON-escaped `LIKE` first, so only rows that can match get parsed. A host with very long histories may want an FTS index later.
