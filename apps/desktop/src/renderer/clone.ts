import type { Repo } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import { uuidv7 } from "./uuidv7";

/** How often a clone under way asks plxd for git's progress line. */
const PROGRESS_MS = 1000;

/**
 * Clones `url` into `path` on `hostId` with its plxd (`repo/clone`, PLX-905), which registers it.
 * While it runs, `onProgress` gets git's latest progress line each second. Resolves to the entry,
 * or why it failed, for people.
 */
export async function cloneOn(
  hostId: string,
  url: string,
  path: string,
  onProgress?: (line: string) => void,
): Promise<Repo | string> {
  const id = uuidv7();
  let done = false;
  const poll = async () => {
    while (!done) {
      await new Promise((resolve) => setTimeout(resolve, PROGRESS_MS));
      if (done) return;
      const answer = await window.parallax.request(hostId, "repo/cloneProgress", { id });
      if (!done && "result" in answer && answer.result.progress)
        onProgress?.(answer.result.progress);
    }
  };
  if (onProgress) void poll();
  try {
    const answer = await window.parallax.request(hostId, "repo/clone", { id, url, path });
    return "error" in answer ? describeError(answer.error) : answer.result.repo;
  } catch (error) {
    return String(error);
  } finally {
    done = true;
  }
}

/** Where to clone a repository that New Thread asked about, since its path won't do there. */
export type CloneAsk = { url: string; name: string; path: string };

/**
 * Puts `repo` from `from` onto `to`, which lacks it (PLX-905): clones its `origin` at the same
 * path when the folder that path goes in exists there and the path itself doesn't. Otherwise
 * resolves to what to ask, with the path from `~` on `from` as the suggestion. Resolves to an
 * error, for people, when `repo` has no `origin` to clone.
 */
export async function cloneOnto(
  from: string,
  repo: Repo,
  to: string,
  onProgress: (line: string) => void,
): Promise<Repo | CloneAsk | string> {
  const remote = await window.parallax.request(from, "repo/remote", { repo: repo.id });
  if ("error" in remote) return describeError(remote.error);
  const url = remote.result.url;
  if (!url) return `${repo.name} has no origin remote to clone it from`;
  const dir = repo.path.slice(0, Math.max(repo.path.lastIndexOf("/"), repo.path.lastIndexOf("\\")));
  const there = dir && (await window.parallax.request(to, "host/folders", { path: dir }));
  const free =
    there && "result" in there && !there.result.folders.some((f) => f.path === repo.path);
  if (free) {
    onProgress("");
    return cloneOn(to, url, repo.path, onProgress);
  }
  const home = await window.parallax.request(from, "host/folders", { path: "~" });
  const root = "result" in home ? home.result.path.replace(/[\\/]+$/, "") : undefined;
  const under =
    root !== undefined && /^[\\/]/.test(repo.path.slice(root.length)) && repo.path.startsWith(root)
      ? repo.path.slice(root.length + 1).replaceAll("\\", "/")
      : undefined;
  return { url, name: repo.name, path: `~/${under || repo.name}` };
}
