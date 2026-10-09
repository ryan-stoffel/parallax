import { useCallback, useEffect, useState } from "react";

import type { RepoScript } from "../../protocol/generated/protocol";
import { useConnection } from "../ConnectionStatus";
import { describeError } from "../errors";
import { localId, useHosts, type Host } from "../hosts";
import type { ThreadsView } from "../threads";
import { field, HostPicker, PageTitle, primaryButton, quietButton, Section, Switch } from "./parts";

/** A script's roles in a few words, as T3 Code's `projectScriptMenuLabel` names them. */
export function scriptRoles(script: RepoScript): string {
  const roles = [
    ...(script.runOnWorktreeCreate
      ? [script.async === false ? "setup, holds the agent" : "setup"]
      : []),
    ...(script.runOnSettle ? ["on settle"] : []),
  ];
  return roles.join(", ");
}

const blank: RepoScript = { id: "", name: "", command: "", runOnWorktreeCreate: true };

/**
 * Settings > Scripts (PLX-650): a repository's setup and settle scripts, which plxd runs in a
 * thread's worktree, and its parallax.json's, which run only once imported, as T3 Code's t3.json.
 */
export function ScriptSettings({ listed }: { listed: { host: Host; view: ThreadsView }[] }) {
  const hosts = useHosts();
  const [hostId, setHostId] = useState(localId);
  const connection = useConnection(hostId);
  const connected = connection?.status === "connected";
  const supported = connected && "setupScripts" in connection.capabilities;
  const repos =
    listed.find((l) => l.host.id === hostId)?.view.state.repos.filter((r) => !r.scratch) ?? [];
  const [repoId, setRepoId] = useState<string>();
  const repo = repos.find((r) => r.id === repoId) ?? repos[0];
  const [saved, setSaved] = useState<RepoScript[]>();
  const [scripts, setScripts] = useState<RepoScript[]>([]);
  const [file, setFile] = useState<{ scripts: RepoScript[]; error?: string }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!repo) return;
    const answer = await window.parallax.request(hostId, "repo/scripts", { repo: repo.id });
    if ("error" in answer) return setError(describeError(answer.error));
    setSaved(answer.result.scripts);
    setScripts(answer.result.scripts);
    setFile({ scripts: answer.result.fileScripts ?? [], error: answer.result.fileError });
    setError(undefined);
  }, [hostId, repo]);
  useEffect(() => {
    setSaved(undefined);
    setFile(undefined);
    setError(undefined);
    if (supported) void load();
  }, [supported, load]);

  const save = async () => {
    if (!repo) return;
    setBusy(true);
    const answer = await window.parallax.request(hostId, "repo/saveScripts", {
      repo: repo.id,
      scripts,
    });
    setBusy(false);
    if ("error" in answer) return setError(describeError(answer.error));
    setSaved(answer.result.scripts);
    setScripts(answer.result.scripts);
    setError(undefined);
  };
  const edit = (i: number, change: Partial<RepoScript>) =>
    setScripts(scripts.map((s, j) => (j === i ? { ...s, ...change } : s)));
  const dirty = JSON.stringify(scripts) !== JSON.stringify(saved);

  const empty = !connected
    ? "Not connected"
    : !supported
      ? "This host's plxd can't run setup scripts."
      : !repo
        ? "No repositories on this host yet."
        : saved === undefined
          ? (error ?? "Loading…")
          : undefined;
  return (
    <>
      <PageTitle title="Scripts">
        Commands that run in a thread&apos;s own worktree: a setup script once the worktree is
        created, and a settle script when the thread settles. Each runs in a terminal under the
        thread.
      </PageTitle>
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <HostPicker hosts={hosts} value={hostId} onChange={setHostId} />
        {repos.length > 0 && (
          <label className="flex items-center gap-1.5 text-[15px] text-muted-foreground">
            Repository
            <select
              aria-label="Repository"
              value={repo?.id}
              onChange={(e) => setRepoId(e.target.value)}
              className="rounded-md bg-transparent py-0.5 pr-1 font-medium text-foreground hover:bg-hover"
            >
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <Section
        title="Scripts"
        action={
          !empty && (
            <button
              type="button"
              className={quietButton}
              onClick={() => setScripts([...scripts, blank])}
            >
              Add script
            </button>
          )
        }
      >
        {empty ? (
          <p className="px-4 py-3 text-[12.5px] text-muted-foreground">{empty}</p>
        ) : scripts.length === 0 ? (
          <p className="px-4 py-3 text-[12.5px] text-muted-foreground">
            No scripts. Add one, or import one from parallax.json.
          </p>
        ) : (
          scripts.map((script, i) => (
            <div key={i} className="border-border px-4 py-3 not-last:border-b">
              <div className="flex items-center gap-2">
                <input
                  aria-label="Name"
                  placeholder="Name"
                  value={script.name}
                  onChange={(e) => edit(i, { name: e.target.value })}
                  className={`${field} mt-0 font-medium`}
                />
                <button
                  type="button"
                  className={quietButton}
                  onClick={() => setScripts(scripts.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </div>
              <textarea
                aria-label="Command"
                placeholder="pnpm install"
                rows={2}
                value={script.command}
                onChange={(e) => edit(i, { command: e.target.value })}
                className={`${field} font-mono`}
              />
              <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-muted-foreground">
                <span className="flex items-center gap-2">
                  <Switch
                    label={`Run ${script.name || "it"} on a new worktree`}
                    checked={script.runOnWorktreeCreate ?? false}
                    onChange={(on) => edit(i, { runOnWorktreeCreate: on })}
                  />
                  On a new worktree
                </span>
                {script.runOnWorktreeCreate && (
                  <span className="flex items-center gap-2">
                    <Switch
                      label={`Hold the agent until ${script.name || "it"} finishes`}
                      checked={script.async === false}
                      onChange={(on) => edit(i, { async: on ? false : undefined })}
                    />
                    Agent waits for it
                  </span>
                )}
                <span className="flex items-center gap-2">
                  <Switch
                    label={`Run ${script.name || "it"} when a thread settles`}
                    checked={script.runOnSettle ?? false}
                    onChange={(on) => edit(i, { runOnSettle: on })}
                  />
                  When a thread settles
                </span>
              </div>
            </div>
          ))
        )}
        {!empty && (
          <div className="flex items-center justify-end gap-3 border-t border-border px-4 py-2.5">
            {error && (
              <p role="alert" className="mr-auto text-[12.5px] text-danger">
                {error}
              </p>
            )}
            <button
              type="button"
              className={quietButton}
              disabled={!dirty || busy}
              onClick={() => setScripts(saved ?? [])}
            >
              Discard
            </button>
            <button
              type="button"
              className={primaryButton}
              disabled={!dirty || busy}
              onClick={() => void save()}
            >
              Save
            </button>
          </div>
        )}
      </Section>
      {!empty && (file?.error || (file?.scripts.length ?? 0) > 0) && (
        <Section title="From parallax.json">
          <p className="border-b border-border px-4 py-3 text-[12.5px] text-muted-foreground">
            The repository&apos;s parallax.json declares these. They run only once you import and
            save them.
          </p>
          {file?.error && (
            <p role="alert" className="px-4 py-3 text-[12.5px] text-danger">
              {file.error}
            </p>
          )}
          {file?.scripts.map((script) => (
            <div
              key={script.id}
              className="flex items-center justify-between gap-4 border-border px-4 py-3 not-last:border-b"
            >
              <div className="min-w-0">
                <span className="block text-[13px] font-medium">
                  {script.name}
                  {scriptRoles(script) && (
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      · {scriptRoles(script)}
                    </span>
                  )}
                </span>
                <code className="block truncate font-mono text-[12px] text-muted-foreground">
                  {script.command}
                </code>
              </div>
              <button
                type="button"
                className={quietButton}
                onClick={() => setScripts([...scripts, script])}
              >
                Import
              </button>
            </div>
          ))}
        </Section>
      )}
    </>
  );
}
