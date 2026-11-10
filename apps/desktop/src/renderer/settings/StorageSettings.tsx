import { useCallback, useEffect, useState } from "react";

import type { StorageItem } from "../../preload/bridge";
import { useConnectedNow, useShownConnection } from "../ConnectionStatus";
import { describeError } from "../errors";
import { useHosts, type Host } from "../hosts";
import { notify } from "../notifications";
import { keepsDeletedWorktrees } from "./hostSettings";
import {
  allHosts,
  dangerButton,
  formatBytes,
  HostPicker,
  hostsOf,
  PageTitle,
  quietButton,
  Row,
  Section,
} from "./parts";

/**
 * Settings > Storage: what Parallax keeps on this computer and its size, each folder openable,
 * Clear for the cache, whether a host cleans up merged worktrees, and a host's archived threads,
 * which Delete removes, with their worktrees unless the host keeps a deleted thread's.
 */
export function StorageSettings() {
  const platform = window.parallax.platform;
  const fileManager =
    platform === "darwin"
      ? "Show in Finder"
      : platform === "win32"
        ? "Show in Explorer"
        : "Open folder";
  const [items, setItems] = useState<StorageItem[]>();
  const [clearing, setClearing] = useState(false);
  const load = useCallback(() => void window.parallax.storage().then(setItems), []);
  useEffect(load, [load]);

  return (
    <>
      <PageTitle title="Storage">
        What Parallax keeps on this computer, and what it takes.
      </PageTitle>
      <Section title="On this computer">
        {!items && <p className="px-4 py-3 text-body text-muted-foreground">Measuring…</p>}
        {items?.map((item) => (
          <Row
            key={item.id}
            title={
              <>
                {item.name}
                <span className="ml-2 font-normal text-muted-foreground">
                  {formatBytes(item.bytes)}
                </span>
              </>
            }
            description={
              item.id === "cache" ? (
                "Web pages and code the app keeps to load faster. Nothing you made."
              ) : (
                <span className="block truncate font-mono text-meta" title={item.folder}>
                  {item.folder}
                </span>
              )
            }
          >
            {item.id === "cache" ? (
              <button
                type="button"
                disabled={clearing}
                className={quietButton}
                onClick={async () => {
                  setClearing(true);
                  await window.parallax.clearCache();
                  setClearing(false);
                  load();
                }}
              >
                {clearing ? "Clearing…" : "Clear"}
              </button>
            ) : (
              <button
                type="button"
                className={quietButton}
                onClick={() => void window.parallax.showFolder(item.id)}
              >
                {fileManager}
              </button>
            )}
          </Row>
        ))}
      </Section>
      <ArchivedThreads />
    </>
  );
}

/** Every computer's archived threads, or the one picked's. */
function ArchivedThreads() {
  const hosts = useHosts();
  const [scope, setScope] = useState(allHosts);
  const targets = hostsOf(hosts, scope);
  return (
    <Section
      title="Archived threads"
      action={<HostPicker hosts={hosts} value={scope} onChange={setScope} all />}
    >
      {targets.map((host) => (
        <HostArchived key={host.id} host={host} named={targets.length > 1} />
      ))}
    </Section>
  );
}

/** A computer's archived threads: how many, and Delete all, which asks first, in place. */
function HostArchived({ host, named }: { host: Host; named: boolean }) {
  const connected = useShownConnection(host.id)?.status === "connected";
  const connectedNow = useConnectedNow(host.id);
  const [archived, setArchived] = useState<string[]>();
  // Whether the host keeps a deleted thread's worktree and branch on disk.
  const [kept, setKept] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const answer = await window.parallax.request(host.id, "thread/list", {});
    if ("error" in answer) return setError(describeError(answer.error));
    setError(undefined);
    // An orchestrator's thread goes only with its orchestrator (0093).
    setArchived(
      answer.result.threads.filter((t) => t.archived && !t.orchestrator).map((t) => t.id),
    );
    setKept(await keepsDeletedWorktrees(host.id));
  }, [host.id]);
  useEffect(() => {
    if (connectedNow) void load();
  }, [connectedNow, load]);

  const deleteAll = async () => {
    setDeleting(true);
    for (const id of archived ?? []) {
      const answer = await window.parallax.request(host.id, "thread/delete", { runId: id });
      if ("error" in answer) {
        notify({
          tone: "error",
          title: "Couldn't delete the archived threads",
          body: describeError(answer.error),
        });
        break;
      }
    }
    setDeleting(false);
    setConfirming(false);
    void load();
  };

  const count = archived?.length ?? 0;
  return (
    <Row
      title={`${named ? `${host.name}: ` : ""}${
        !connected
          ? "Not connected"
          : archived === undefined
            ? "Counting…"
            : `${count} archived ${count === 1 ? "thread" : "threads"}`
      }`}
      description={
        error ? (
          <span role="alert" className="text-danger">
            {error}
          </span>
        ) : confirming ? (
          kept ? (
            "Delete them? Their transcripts go too. Their worktrees and branches stay on disk. This can't be undone."
          ) : (
            "Delete them? Their transcripts, worktrees, and branches go too. This can't be undone."
          )
        ) : kept ? (
          "Deleting removes each one's transcript from the host. Its worktree and branch stay on disk."
        ) : (
          "Deleting removes each one's transcript and worktree from the host."
        )
      }
    >
      {confirming ? (
        <>
          <button
            type="button"
            disabled={deleting}
            className={dangerButton}
            onClick={() => void deleteAll()}
          >
            {deleting ? "Deleting…" : "Delete all"}
          </button>
          <button
            type="button"
            autoFocus
            className={quietButton}
            disabled={deleting}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          className={quietButton}
          disabled={!count}
          onClick={() => setConfirming(true)}
        >
          Delete all
        </button>
      )}
    </Row>
  );
}
