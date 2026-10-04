#!/usr/bin/env python3
"""Scrubs a raw PLXD_RECORD_CLI recording into a fixture that is safe to commit (PLX-493).

    scripts/scrub-recording.py <raw.jsonl> <fixture.jsonl>

Replaces paths under a user's home and plxd's temp and worktree folders, and drops or blanks what
identifies the user or their account: thinking signatures (they encode the organization id),
request ids, plan, credit, overage, and usage figures, hook output, the user's own MCP servers,
skills, plugins, and commands, and the host's name. Lines it leaves alone keep their exact bytes.
Review the result anyway; `recorded_fixtures_hold_no_personal_data` in daemon/src/backend/record.rs
checks the committed fixtures for the classes it knows.
"""

import json
import re
import sys

# The MCP servers plxd or the CLI itself adds; any other is the user's own.
OWN_SERVERS = {"plxd", "codex_apps"}
# Keys whose values describe the user's account or plan, dropped wherever they appear.
DROPPED_KEYS = {"planType", "credits", "overageStatus", "overageDisabledReason", "isUsingOverage",
                "installationId", "memory_paths", "messaging_socket_path"}


def scrub_text(text: str) -> str:
    # A thread's worktree, `<data>/worktrees/<repo>-<hash>/<run id>`, is the repo.
    text = re.sub(r'[^"\s]*/worktrees/[^/"\s]+/[0-9a-f-]{36}', "/repo", text)
    # Claude Code's project folder name for it.
    text = re.sub(r'-[^"/\s]*-worktrees-[^"/\s]+-[0-9a-f-]{36}', "-repo", text)
    text = re.sub(r"(/private)?/tmp/parallax-[0-9a-f]+/[A-Za-z0-9]+", "/tmp/parallax", text)
    text = re.sub(r'(/private)?/(tmp|var/folders)/[^"\s]*', "/tmp/plxd", text)
    text = re.sub(r"/(Users|home)/[^/\"\s]+", "~", text)
    text = re.sub(r"req_[A-Za-z0-9]+", "request-redacted", text)
    return re.sub(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "user@example.com", text)


def scrub_value(value):
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if key in DROPPED_KEYS:
                continue
            if key == "signature" and isinstance(item, str):
                item = "redacted"
            elif key in ("utilization",) and isinstance(item, (int, float)):
                item = 0.1
            elif key == "usedPercent" and isinstance(item, (int, float)):
                item = 10
            out[key] = scrub_value(item)
        return out
    if isinstance(value, list):
        return [scrub_value(item) for item in value]
    return value


def scrub_line(d: dict):
    """The scrubbed message, or None to drop the line."""
    method = d.get("method")
    params = d.get("params", {})
    # Codex: the host's name, and the user's own MCP servers.
    if method == "remoteControl/status/changed":
        return None
    if method == "mcpServer/startupStatus/updated" and params.get("name") not in OWN_SERVERS:
        return None
    # Claude Code: hook output, and the user's own servers, skills, plugins, and commands.
    if d.get("type") == "system" and d.get("subtype") == "hook_response":
        d["output"] = d["stdout"] = d["stderr"] = ""
    if d.get("type") == "system" and d.get("subtype") == "init":
        d["tools"] = [t for t in d.get("tools", [])
                      if not t.startswith("mcp__") or t.split("__")[1] in OWN_SERVERS]
        d["mcp_servers"] = [s for s in d.get("mcp_servers", []) if s["name"] in OWN_SERVERS]
        d["slash_commands"] = d["skills"] = d["plugins"] = []
    # ACP (Cursor): the user's global and user commands.
    update = params.get("update", {}) if isinstance(params, dict) else {}
    if update.get("sessionUpdate") == "available_commands_update":
        update["availableCommands"] = [
            c for c in update["availableCommands"]
            if "(global)" not in c.get("description", "") and "(user" not in c.get("description", "")
        ]
    return scrub_value(d)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    out = []
    for line in open(src).read().splitlines():
        if not line.startswith("{"):
            out.append(line)
            continue
        line = scrub_text(line)
        before = json.loads(line)
        d = scrub_line(json.loads(line))
        if d is None:
            continue
        out.append(line if d == before else json.dumps(d, ensure_ascii=False, separators=(",", ":")))
    open(dst, "w").write("\n".join(out) + "\n")


if __name__ == "__main__":
    main()
