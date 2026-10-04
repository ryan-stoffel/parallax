#!/usr/bin/env python3
"""Streams N fake-backend threads at once through plxd and measures what delivering them costs.

    cargo build --profile bench -p plxd --features fake-backend
    scripts/bench/load.py target/release/plxd [--threads 30] [--out load.json] [--replay EVENTS]
    uv run --with matplotlib scripts/bench/load.py --compare before.json after.json --png out.png

Runs `plxd serve` in a temporary data folder with every worker on the fake backend, playing a
script of about 400 text, tool call, and tool result emits with sleeps. It adds one fresh repo,
subscribes the way the app does (one connection: a host-level subscription, one per repo scope for
the sidebar, and one more on the first run's scope for an open transcript; with `--filtered`, the
scope one is `shell` and the open one is `run`, as PLX-454 makes the app subscribe), starts N
threads at the same moment, and waits for every turn to end. It writes JSON with delivery latency (receive
time minus the event's `time`, which plxd sets at flush), bytes and events per connection and per
subscription, `host/health.queues` samples when plxd reports them, plxd's CPU and peak RSS, and
whether plxd made a subscriber resync. `--compare` charts any number of those files side by side.
`--replay` plays a recorded session's events instead, from a backend's replay snapshot such as
`daemon/src/backend/claude/fixtures/recorded.events.jsonl` (PLX-493), as fast as plxd takes them.
"""

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

from threads import Client, connect, pct, uuid7

EMITS = 400
SLEEP_MS = 100  # After every group of four emits, so a run streams for about 10 s.
# The fake backend passes its whole compiled script as one `sh -c` argument, and Linux caps one
# argument at 128 KiB (MAX_ARG_STRLEN), so these sizes keep the script at about 85 KB.
TEXT = "The fake agent is reading the code and explaining what it found, line by line. "
OUTPUT = "fn main() {\n    println!(\"hello from a file the fake agent read\");\n}\n" * 5


def script() -> list:
    """The fake CLI's script: init, EMITS emits in groups of text, call, result, text, then exit."""
    steps: list = [{"init": {"sessionId": "load", "model": "fake-model"}}]
    for i in range(EMITS // 4):
        call = f"call-{i}"
        steps += [
            {"emit": {"kind": "text", "text": TEXT}},
            {"emit": {"kind": "toolCall", "callId": call, "name": "Read",
                      "input": {"file_path": f"src/file_{i}.rs"}}},
            {"emit": {"kind": "toolResult", "callId": call, "status": "ok", "output": OUTPUT}},
            {"emit": {"kind": "text", "text": TEXT}},
            {"sleepMs": SLEEP_MS},
        ]
    return steps + [{"endTurn": {"result": "done"}}]


def replay(path: str) -> list:
    """The fake CLI's script for a replay snapshot: its session, its events, and its turn's end.
    The fake backend reports the turn's start and the run's end itself, and a load run answers no
    permission requests."""
    steps: list = []
    for line in Path(path).read_text().splitlines():
        event = json.loads(line)
        kind = event["kind"]
        if kind == "sessionStarted":
            steps.append({"init": {"sessionId": "replay", "model": event.get("model")}})
        elif kind == "turnFinished":
            steps.append({"endTurn": {"result": event.get("result")}})
        elif kind not in ("turnStarted", "finished", "approvalRequested", "approvalWithdrawn"):
            steps.append({"emit": event})
    return steps


class LoadClient(Client):
    """A `Client` whose events carry their wall-clock receive time and frame size, and that queues
    `None` when plxd closes the connection, which is how plxd makes a subscriber that fell behind
    its retention resync."""

    def __init__(self, reader, writer):
        self.bytes = 0
        super().__init__(reader, writer)

    async def read(self):
        while line := await self.reader.readline():
            at = time.time()
            self.bytes += len(line)
            message = json.loads(line)
            if "id" in message and message["id"] in self.pending:
                self.pending.pop(message["id"]).set_result(message)
            elif message.get("method") == "events/event":
                self.events.put_nowait((at, len(line), message["params"]))
        self.events.put_nowait(None)


def ps(pid: int) -> tuple[int, float]:
    """plxd's RSS in KiB and its CPU time in seconds, from `ps`."""
    rss, cpu = subprocess.run(
        ["ps", "-o", "rss=,time=", "-p", str(pid)], capture_output=True, text=True
    ).stdout.split()
    seconds = 0.0
    for part in cpu.replace("-", ":").split(":"):  # [[dd-]hh:]mm:ss[.ss]
        seconds = seconds * 60 + float(part)
    return int(rss), seconds


def stats(values: list[float]) -> dict:
    if not values:
        return {"n": 0}
    return {"n": len(values), "p50": pct(values, 50), "p95": pct(values, 95),
            "p99": pct(values, 99), "max": max(values)}


async def run(plxd: str, count: int, steps: list, filtered: bool) -> dict:
    data = tempfile.mkdtemp(prefix="plxl-", dir="/tmp")
    repo = data + "-repo"
    subprocess.run(["git", "init", "-q", repo], check=True)
    subprocess.run(["git", "-C", repo, "-c", "user.name=load", "-c", "user.email=load@example.com",
                    "commit", "-q", "--allow-empty", "-m", "init"], check=True)
    fake = data + "-fake.json"
    Path(fake).write_text(json.dumps(steps))
    env = {**os.environ, "PLXD_DATA_DIR": data, "PLXD_FAKE_BACKEND": fake}
    daemon = subprocess.Popen([plxd, "serve"], env=env, stderr=open(f"{data}.log", "w"))
    try:
        client = await connect(os.path.join(data, "plxd.sock"), LoadClient)
        scope = (await client.call("repo/add", {"id": uuid7(), "path": repo}))["repo"]["id"]
        after = (await client.call("thread/list", {}))["seq"]
        runs = [uuid7() for _ in range(count)]
        names, resync = {}, None
        subscriptions = (
            ("host", {}),
            ("scope", {"project": scope, **({"shell": True} if filtered else {})}),
            ("open", {"project": scope, **({"run": runs[0]} if filtered else {})}),
        )
        for name, params in subscriptions:
            try:
                result = await client.call("events/subscribe", {"after": after, **params})
            except RuntimeError as error:
                return {"resync": f"{name}: {error}"}
            names[result["subscription"]] = name
        subs = {name: {"events": 0, "bytes": 0, "latency": []} for name in names.values()}

        samples: list[dict] = []
        t0 = time.monotonic()

        async def sample():
            while True:
                # Off the loop, so running `ps` never delays reading events.
                rss, cpu = await asyncio.to_thread(ps, daemon.pid)
                health = await client.call("host/health", {})
                row = {"t": round(time.monotonic() - t0, 2), "rssKiB": rss, "cpuS": cpu}
                if "queues" in health:
                    row["queues"] = health["queues"]
                samples.append(row)
                await asyncio.sleep(0.5)

        sampler = asyncio.create_task(sample())
        while not samples:
            await asyncio.sleep(0.01)
        _, cpu0 = ps(daemon.pid)
        account = {"kind": "subscription", "backend": "fake"}
        await asyncio.gather(*(client.call(
            "thread/start", {"runId": r, "repo": scope, "prompt": "load", "account": account}
        ) for r in runs))

        # Each run's turn ends once on the scope subscription and, for the open run, once more.
        waiting = {("scope", r) for r in runs} | {("open", runs[0])}
        while True:
            try:
                item = await asyncio.wait_for(client.events.get(), timeout=300 if waiting else 1)
            except TimeoutError:
                if waiting:
                    raise RuntimeError(f"{len(waiting)} turns never ended") from None
                break  # Everything after the last turn has arrived.
            if item is None:
                resync = "plxd closed the connection"
                break
            at, size, params = item
            name = names[params["subscription"]]
            sub = subs[name]
            sub["events"] += 1
            sub["bytes"] += size
            sub["latency"].append((at - datetime.fromisoformat(params["time"]).timestamp()) * 1000)
            event = params["event"]
            ended = event["kind"] == "agent.finished" or (
                event["kind"] == "agent.output"
                and any(i["kind"] == "turnFinished" for i in event["items"])
            )
            if ended:
                waiting.discard((name, event.get("runId")))
        wall = time.monotonic() - t0
        sampler.cancel()
        _, cpu1 = ps(daemon.pid)

        latency = [ms for sub in subs.values() for ms in sub["latency"]]
        queues = [s["queues"] for s in samples if "queues" in s]
        return {
            "threads": count,
            "filtered": filtered,
            "emitsPerThread": sum("emit" in step for step in steps),
            "wallS": round(wall, 2),
            # A busy host stretches the latency tail; compare runs taken at similar load.
            "loadAvg1m": round(os.getloadavg()[0], 1),
            "latencyMs": stats(latency),
            "connection": {"events": len(latency), "bytes": client.bytes},
            "subscriptions": {name: {"events": s["events"], "bytes": s["bytes"],
                                     "latencyMs": stats(s["latency"])} for name, s in subs.items()},
            "plxd": {"cpuS": round(cpu1 - cpu0, 2), "cpuPct": round(100 * (cpu1 - cpu0) / wall, 1),
                     "rssPeakMiB": round(max(s["rssKiB"] for s in samples) / 1024, 1)},
            "queues": queues or None,
            "resync": resync,
            "samples": samples,
        }
    finally:
        daemon.terminate()
        daemon.wait()
        shutil.rmtree(data, ignore_errors=True)
        shutil.rmtree(repo, ignore_errors=True)
        os.remove(fake)


def compare(paths: list[str], png: str) -> None:
    """Charts each file's latency, plxd CPU and RSS, and bytes delivered in all and per
    subscription, one bar per file."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    runs = [json.loads(Path(p).read_text()) for p in paths]
    labels = [Path(p).stem for p in paths]
    colors = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"]
    panels = [
        ("Delivery latency p50 (ms)", lambda r: r["latencyMs"]["p50"]),
        ("Delivery latency p99 (ms)", lambda r: r["latencyMs"]["p99"]),
        ("plxd CPU (% of one core)", lambda r: r["plxd"]["cpuPct"]),
        ("plxd peak RSS (MiB)", lambda r: r["plxd"]["rssPeakMiB"]),
        ("Delivered to the app (MiB)", lambda r: r["connection"]["bytes"] / 2**20),
        ("Events delivered", lambda r: r["connection"]["events"]),
    ] + [
        (f"Delivered on {name} subscription (MiB)",
         lambda r, name=name: r["subscriptions"][name]["bytes"] / 2**20)
        for name in ("host", "scope", "open")
    ]
    fig, axes = plt.subplots(3, 3, figsize=(12, 9.5))
    for ax, (title, value) in zip(axes.flat, panels):
        values = [value(r) for r in runs]
        bars = ax.bar(labels, values, color=colors[: len(runs)], width=0.6)
        ax.bar_label(bars, labels=[f"{v:,}" if isinstance(v, int) else f"{v:.3g}" for v in values],
                     color="#52514e", fontsize=9, padding=2)
        ax.set_title(title, fontsize=10, color="#0b0b0b", loc="left")
        ax.spines[["top", "right"]].set_visible(False)
        ax.tick_params(colors="#52514e", labelsize=8)
        ax.margins(y=0.15)
    fig.suptitle("plxd load: fake-backend threads streaming at once", x=0.01, ha="left")
    fig.tight_layout()
    fig.savefig(png, dpi=150)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("plxd", nargs="?", help="a plxd built with the fake-backend feature")
    parser.add_argument("--threads", type=int, default=30)
    parser.add_argument("--out", default="load.json")
    parser.add_argument("--filtered", action="store_true",
                        help="subscribe with `shell` and `run` (needs the eventFilters capability)")
    parser.add_argument("--compare", nargs="+", metavar="JSON", help="chart these results")
    parser.add_argument("--png", default="load.png")
    parser.add_argument("--replay", metavar="EVENTS", help="play this replay snapshot's events")
    args = parser.parse_args()
    if args.compare:
        return compare(args.compare, args.png)
    if not args.plxd:
        parser.error("give a plxd binary, or --compare")
    steps = replay(args.replay) if args.replay else script()
    result = asyncio.run(run(args.plxd, args.threads, steps, args.filtered))
    Path(args.out).write_text(json.dumps(result, indent=2) + "\n")
    keys = ("threads", "wallS", "loadAvg1m", "latencyMs", "connection", "plxd", "resync")
    summary = {k: result.get(k) for k in keys}
    print(json.dumps(summary))
    if result.get("resync"):
        sys.exit(1)


if __name__ == "__main__":
    main()
