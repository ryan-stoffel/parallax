import { useCallback, useEffect, useMemo, useState } from "react";

import type { RpcError } from "../../preload/bridge";
import type { PrFile, PrWrite } from "../../protocol/generated/protocol";

/** Files ticked here that GitHub's last read doesn't agree with yet: a path, and viewed or not. */
export type Ticks = ReadonlyMap<string, boolean>;

/** The paths viewed: what GitHub's read says, with `ticks` over it. */
export function viewedPaths(files: readonly PrFile[], ticks: Ticks): ReadonlySet<string> {
  const viewed = new Set(files.filter((f) => f.viewed === "viewed").map((f) => f.path));
  for (const [path, on] of ticks) {
    if (on) viewed.add(path);
    else viewed.delete(path);
  }
  return viewed;
}

/** The paths viewed once and changed since, unless ticked since. */
export function changedSinceViewed(files: readonly PrFile[], ticks: Ticks): ReadonlySet<string> {
  return new Set(
    files.filter((f) => f.viewed === "dismissed" && !ticks.has(f.path)).map((f) => f.path),
  );
}

/** `ticks` without the ones GitHub's read now agrees with, or `ticks` itself when none. */
export function settledTicks(files: readonly PrFile[], ticks: Ticks): Ticks {
  const next = new Map(ticks);
  for (const f of files) if (next.get(f.path) === (f.viewed === "viewed")) next.delete(f.path);
  // Unticked and not listed: no file for GitHub to disagree about.
  return next.size === ticks.size ? ticks : next;
}

const noFiles: readonly PrFile[] = [];

/**
 * A pull request's Viewed files, as GitHub keeps them per reviewer (PLX-1186). A tick shows at once
 * and goes to GitHub with `send`, with no re-read of the pull request. It stays over GitHub's read
 * until a read agrees, since a read can predate the write, or until `reread`. `send` absent, or a
 * pull request without a node id from an older plxd, keeps ticks here only. A failed write takes its
 * tick back and tells `onFailed`.
 */
export function useViewedFiles({
  url,
  files = noFiles,
  nodeId,
  send,
  onFailed,
}: {
  url: string;
  files?: readonly PrFile[];
  nodeId?: string;
  send?: (write: PrWrite) => Promise<RpcError | undefined>;
  onFailed: (path: string, viewed: boolean, error: RpcError) => void;
}) {
  const [ticks, setTicks] = useState<Ticks>(new Map());
  useEffect(() => setTicks(new Map()), [url]);
  useEffect(() => setTicks((now) => settledTicks(files, now)), [files]);
  const set = useCallback(
    async (path: string, viewed: boolean) => {
      setTicks((now) => new Map(now).set(path, viewed));
      if (!send || !nodeId) return;
      const failed = await send({ kind: "setFileViewed", pullRequestId: nodeId, path, viewed });
      if (!failed) return;
      setTicks((now) => {
        if (now.get(path) !== viewed) return now;
        const next = new Map(now);
        next.delete(path);
        return next;
      });
      onFailed(path, viewed, failed);
    },
    [send, nodeId, onFailed],
  );
  const reread = useCallback(() => setTicks(new Map()), []);
  return {
    viewed: useMemo(() => viewedPaths(files, ticks), [files, ticks]),
    changed: useMemo(() => changedSinceViewed(files, ticks), [files, ticks]),
    set,
    reread,
  };
}
