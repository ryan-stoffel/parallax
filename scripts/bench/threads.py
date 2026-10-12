#!/usr/bin/env python3
"""Starts N threads at once on a fresh plxd and times each one.

    scripts/bench/threads.py <plxd binary> <repo path> [threads] [model]

Runs `plxd serve` in a temporary data folder, adds a fresh clone of the repo, sends N `thread/start` requests at
the same moment, and reports per-thread start latency (request to response), time to the CLI's
session start, time to first text, and time to the first turn's end, plus plxd's CPU time. Needs a
signed-in `claude` CLI.

Session start is the Claude sidecar and the CLI starting up after `thread/start` answers, with no
model time in it; the time from there to first text is the model's. The bench first starts N
`claude` CLIs at once in the same clone, with only the stream-json flags and the model, and fails
when plxd's median time from `thread/start`'s response to `sessionStarted` is more than
`OVERHEAD_BUDGET_S` over theirs from spawn to `system/init` (PLX-711). Timing both in one run takes
out some of a busy machine's noise, not all of it: at 20 threads the overhead varied by about 1 s
between runs. It deletes the `~/.claude/projects` folders its CLIs create.
"""

import asyncio
import glob
import json
import os
import re
import secrets
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import uuid

PROMPT = "Reply with the numbers 1 to 40, one per line, and nothing else. Do not use any tools."


# The most plxd's median session start, from `thread/start`'s response, may trail a bare CLI's
# (PLX-711). Measured at 0.02-0.07 s for 1 to 5 threads, and below zero at 20, where plxd's
# `thread/start` responses spread its CLIs' starts out.
OVERHEAD_BUDGET_S = 0.5


async def bare_sessions(count, model, cwd):
    """Starts `count` bare `claude` CLIs at once in `cwd`, each sent the prompt, and returns each
    one's time to its `system/init`, killing it there."""

    async def one():
        cli = await asyncio.create_subprocess_exec(
            "claude", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json",
            "--model", model, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, limit=64 << 20,
        )
        message = {"type": "user", "message": {"role": "user", "content": PROMPT}}
        cli.stdin.write(json.dumps(message).encode() + b"\n")
        try:
            while line := await cli.stdout.readline():
                if json.loads(line).get("subtype") == "init":
                    return time.monotonic() - t0
        finally:
            cli.kill()
            await cli.wait()
        raise RuntimeError("a bare claude exited before its session started")

    t0 = time.monotonic()
    return await asyncio.gather(*(one() for _ in range(count)))


def uuid7() -> str:
    ms = time.time_ns() // 1_000_000
    raw = bytearray(ms.to_bytes(6, "big") + secrets.token_bytes(10))
    raw[6] = (raw[6] & 0x0F) | 0x70
    raw[8] = (raw[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(raw)))


class Client:
    def __init__(self, reader, writer):
        self.reader, self.writer = reader, writer
        self.next_id = 0
        self.pending: dict[int, asyncio.Future] = {}
        self.events: asyncio.Queue = asyncio.Queue()
        asyncio.create_task(self.read())

    async def read(self):
        while line := await self.reader.readline():
            message = json.loads(line)
            if "id" in message and message["id"] in self.pending:
                self.pending.pop(message["id"]).set_result(message)
            elif message.get("method") == "events/event":
                await self.events.put((time.monotonic(), message["params"]))

    async def call(self, method, params):
        self.next_id += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[self.next_id] = future
        frame = {"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params}
        self.writer.write(json.dumps(frame).encode() + b"\n")
        await self.writer.drain()
        message = await future
        if "error" in message:
            raise RuntimeError(f"{method}: {message['error']}")
        return message["result"]


async def connect(socket, client_class=Client):
    for _ in range(200):
        try:
            client = client_class(*await asyncio.open_unix_connection(socket, limit=64 << 20))
            await client.call(
                "initialize",
                {
                    "protocol": {"min": 1, "max": 1},
                    "client": {"name": "bench", "version": "0"},
                    "capabilities": {},
                },
            )
            return client
        except (FileNotFoundError, ConnectionRefusedError):
            await asyncio.sleep(0.05)
    raise RuntimeError("plxd never answered")


def pct(values, p):
    values = sorted(values)
    return values[min(len(values) - 1, round(p / 100 * (len(values) - 1)))]


async def main():
    over = False
    plxd, source = sys.argv[1], os.path.abspath(sys.argv[2])
    count = int(sys.argv[3]) if len(sys.argv) > 3 else 20
    model = sys.argv[4] if len(sys.argv) > 4 else "claude-haiku-4-5"
    data = tempfile.mkdtemp(prefix="plxb-", dir="/tmp")
    env = {**os.environ, "PLXD_DATA_DIR": data}
    # A fresh clone each run: git's worktree commands slow down as a repo collects worktrees.
    repo = data + "-repo"
    subprocess.run(["git", "clone", "-q", "--no-hardlinks", source, repo], check=True)
    daemon = subprocess.Popen([plxd, "serve"], env=env, stderr=open(f"{data}.log", "w"))
    try:
        socket = os.path.join(data, "plxd.sock")
        client = await connect(socket)
        # Install the Claude Agent SDK before timing, so no thread waits for npm.
        while any(p.get("installing") for p in (await client.call("providers/list", {}))["providers"]):
            await asyncio.sleep(0.5)
        bare = statistics.median(await bare_sessions(count, model, repo))
        added = await client.call("repo/add", {"id": uuid7(), "path": repo})
        scope = added["repo"]["id"]
        await client.call("events/subscribe", {"after": 0, "project": scope})

        runs = {uuid7(): {} for _ in range(count)}
        t0 = time.monotonic()

        async def start(run_id):
            await client.call(
                "thread/start", {"runId": run_id, "repo": scope, "prompt": PROMPT, "model": model,
                 "account": {"kind": "subscription", "backend": "claude"}}
            )
            runs[run_id]["start"] = time.monotonic() - t0

        starts = asyncio.gather(*(start(run_id) for run_id in runs))
        starts.add_done_callback(lambda f: f.exception() and os._exit(print(f.exception()) or 1))
        done = 0
        output_events = 0
        while done < count:
            at, params = await asyncio.wait_for(client.events.get(), timeout=300)
            event = params["event"]
            run = runs.get(event.get("runId"))
            if run is None:
                continue
            if event["kind"] == "agent.finished" and "done" not in run:
                run["done"] = at - t0
                run["failed"] = event.get("outcome", {})
                done += 1
            if event["kind"] != "agent.output":
                continue
            output_events += 1
            for item in event["items"]:
                if item["kind"] == "sessionStarted":
                    run.setdefault("session", at - t0)
                if item["kind"] in ("text", "textDelta"):
                    run.setdefault("first", at - t0)
                if item["kind"] == "turnFinished" and "done" not in run:
                    run["done"] = at - t0
                    done += 1
        await starts
        wall = time.monotonic() - t0
        cpu = subprocess.run(
            ["ps", "-o", "cputime=", "-p", str(daemon.pid)], capture_output=True, text=True
        ).stdout.strip()

        failed = [r["failed"] for r in runs.values() if r.get("failed")]
        print(f"threads={count} model={model} wall={wall:.2f}s plxd_cpu={cpu} output_events={output_events}")
        if failed:
            print(f"finished early: {failed[:3]}")
        rows = (("start", "thread/start"), ("session", "session start"), ("first", "first text"),
                ("done", "turn done"))
        for key, label in rows:
            values = [r[key] for r in runs.values() if key in r]
            if values:
                print(
                    f"{label:>13}: p50={statistics.median(values):6.2f}s "
                    f"p90={pct(values, 90):6.2f}s max={max(values):6.2f}s n={len(values)}"
                )
        sessions = [r["session"] - r["start"] for r in runs.values() if "session" in r and "start" in r]
        after_start = statistics.median(sessions) if sessions else float("inf")
        overhead = after_start - bare
        print(f"  bare claude: session start p50={bare:6.2f}s; plxd from thread/start's response "
              f"p50={after_start:6.2f}s; overhead {overhead:.2f}s")
        if overhead > OVERHEAD_BUDGET_S:
            print(f"FAIL: plxd's session start overhead is over its {OVERHEAD_BUDGET_S}s budget")
            over = True
    finally:
        daemon.terminate()
        daemon.wait()
        shutil.rmtree(data, ignore_errors=True)
        shutil.rmtree(repo, ignore_errors=True)
        # Claude Code keeps each cwd's transcripts in a folder named for its real path.
        config = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
        prefix = re.sub(r"[^A-Za-z0-9]", "-", os.path.realpath(data))
        for folder in glob.glob(os.path.join(config, "projects", glob.escape(prefix) + "*")):
            shutil.rmtree(folder, ignore_errors=True)
    if over:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
