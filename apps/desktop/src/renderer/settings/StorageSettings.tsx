import { useCallback, useEffect, useRef, useState } from "react";

import type { StorageItem } from "../../preload/bridge";
import { useConnection } from "../ConnectionStatus";
import { describeError } from "../errors";
import { localId, useHosts } from "../hosts";
import {
  dangerButton,
  formatBytes,
  HostPicker,
  PageTitle,
  quietButton,
  Row,
  Section,
  Switch,
} from "./parts";

/**
 * Settings > Storage: what Parallax keeps on this computer and its size, each folder openable,
 * Clear for the cache, whether a host cleans up merged worktrees, and a host's archived threads,
 * which Delete removes with their worktrees.
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
        {!items && <p className="px-4 py-3 text-[12.5px] text-muted-foreground">Measuring…</p>}
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
                <span className="block truncate font-mono text-[11.5px]" title={item.folder}>
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
      <WorktreeCleanup />
      <ArchivedThreads />
    </>
  );
}

/**
 * Whether a host removes a settled thread's worktree once its pull request merges
 * (`host/settings`, `cleanWorktrees`, PLX-555).
 */
function WorktreeCleanup() {
  const hosts = useHosts();
  const [hostId, setHostId] = useState(localId);
  const connection = useConnection(hostId);
  const supported =
    connection?.status === "connected" && "worktreeCleanup" in connection.capabilities;
  const [on, setOn] = useState<boolean>();
  const [error, setError] = useState<string>();
  // The host on screen, so a reply for one the picker has left is dropped.
  const shown = useRef(hostId);
  useEffect(() => {
    shown.current = hostId;
    setOn(undefined);
    setError(undefined);
    if (!supported) return;
    let stale = false;
    void window.parallax.request(hostId, "host/settings/get", {}).then((answer) => {
      if (stale) return;
      if ("error" in answer) setError(describeError(answer.error));
      else setOn(answer.result.cleanWorktrees ?? true);
    });
    return () => {
      stale = true;
    };
  }, [hostId, supported]);
  const set = async (cleanWorktrees: boolean) => {
    setOn(cleanWorktrees);
    const host = hostId;
    const answer = await window.parallax.request(host, "host/settings/set", { cleanWorktrees });
    if (shown.current !== host) return;
    if ("error" in answer) {
      setOn(!cleanWorktrees);
      setError(describeError(answer.error));
    } else {
      setOn(answer.result.cleanWorktrees ?? cleanWorktrees);
      setError(undefined);
    }
  };

  return (
    <Section
      title="Worktrees"
      action={<HostPicker hosts={hosts} value={hostId} onChange={setHostId} />}
    >
      <Row
        title="Clean up merged worktrees"
        description={
          error ? (
            <span role="alert" className="text-danger">
              {error}
            </span>
          ) : connection?.status === "connected" && !supported ? (
            "This host's plxd can't clean up worktrees."
          ) : (
            "When a settled thread's pull request merges, Parallax deletes its worktree and branch. The thread stays."
          )
        }
      >
        <Switch
          label="Clean up merged worktrees"
          checked={on ?? false}
          disabled={on === undefined}
          onChange={(next) => void set(next)}
        />
      </Row>
    </Section>
  );
}

/** A host's archived threads: how many, and Delete all, which asks first, in place. */
function ArchivedThreads() {
  const hosts = useHosts();
  const [hostId, setHostId] = useState(localId);
  const host = hosts.find((h) => h.id === hostId) ?? hosts[0]!;
  const connected = useConnection(host.id)?.status === "connected";
  const [archived, setArchived] = useState<string[]>();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setArchived(undefined);
    const answer = await window.parallax.request(host.id, "thread/list", {});
    if ("error" in answer) setError(describeError(answer.error));
    else setArchived(answer.result.threads.filter((t) => t.archived).map((t) => t.id));
  }, [host.id]);
  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  const deleteAll = async () => {
    setDeleting(true);
    for (const id of archived ?? []) {
      const answer = await window.parallax.request(host.id, "thread/delete", { runId: id });
      if ("error" in answer) {
        setError(describeError(answer.error));
        break;
      }
    }
    setDeleting(false);
    setConfirming(false);
    void load();
  };

  const count = archived?.length ?? 0;
  return (
    <Section
      title="Archived threads"
      action={
        <HostPicker
          hosts={hosts}
          value={host.id}
          onChange={(id) => {
            setHostId(id);
            setConfirming(false);
            setError(undefined);
          }}
        />
      }
    >
      <Row
        title={
          !connected
            ? "Not connected"
            : archived === undefined
              ? "Counting…"
              : `${count} archived ${count === 1 ? "thread" : "threads"}`
        }
        description={
          error ? (
            <span role="alert" className="text-danger">
              {error}
            </span>
          ) : confirming ? (
            "Delete them? Their transcripts, worktrees, and branches go too. This can't be undone."
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
    </Section>
  );
}
