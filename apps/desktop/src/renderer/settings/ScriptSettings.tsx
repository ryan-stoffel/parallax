import { t } from "i18next";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RepoScript } from "../../protocol/generated/protocol";
import { useConnectedNow, useShownConnection } from "../ConnectionStatus";
import { describeError } from "../errors";
import { notify } from "../notifications";
import { field, primaryButton, quietButton, Section, settingRow, Switch } from "./parts";
import { scriptRoles } from "./shared";

const blank: RepoScript = { id: "", name: "", command: "", runOnWorktreeCreate: true };

/**
 * One repository's setup and settle scripts (PLX-650), which plxd runs in a thread's worktree, in a
 * terminal under the thread, and its parallax.json's, which run only once imported, as T3 Code's
 * t3.json. Settings > Projects shows them.
 */
export function RepoScripts({
  hostId,
  repo,
}: {
  hostId: string;
  repo: { id: string; name: string };
}) {
  const connection = useShownConnection(hostId);
  const connected = connection?.status === "connected";
  const supported = connected && "setupScripts" in connection.capabilities;
  const connectedNow = useConnectedNow(hostId);
  const [saved, setSaved] = useState<RepoScript[]>();
  const [scripts, setScripts] = useState<RepoScript[]>([]);
  const [file, setFile] = useState<{ scripts: RepoScript[]; error?: string }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const edited = useRef(false);

  const load = useCallback(async () => {
    const answer = await window.parallax.request(hostId, "repo/scripts", { repo: repo.id });
    if ("error" in answer) return setError(describeError(answer.error));
    setSaved(answer.result.scripts);
    // Edits waiting for Save stay, as a reconnect reads these again.
    if (!edited.current) setScripts(answer.result.scripts);
    setFile({ scripts: answer.result.fileScripts ?? [], error: answer.result.fileError });
    setError(undefined);
  }, [hostId, repo.id]);
  useEffect(() => {
    setSaved(undefined);
    setFile(undefined);
    setError(undefined);
  }, [supported, hostId, repo.id]);
  useEffect(() => {
    if (supported && connectedNow) void load();
  }, [supported, connectedNow, load]);

  const save = async () => {
    setBusy(true);
    const answer = await window.parallax.request(hostId, "repo/saveScripts", {
      repo: repo.id,
      scripts,
    });
    setBusy(false);
    if ("error" in answer)
      return notify({
        tone: "error",
        title: t("Couldn't save {{name}}'s scripts", { name: repo.name }),
        body: describeError(answer.error),
      });
    setSaved(answer.result.scripts);
    setScripts(answer.result.scripts);
  };
  const edit = (i: number, change: Partial<RepoScript>) =>
    setScripts(scripts.map((s, j) => (j === i ? { ...s, ...change } : s)));
  const dirty = JSON.stringify(scripts) !== JSON.stringify(saved);
  edited.current = saved !== undefined && dirty;

  const empty = !connected
    ? t("Not connected")
    : !supported
      ? t("This host's plxd can't run setup scripts.")
      : saved === undefined
        ? (error ?? t("Loading…"))
        : undefined;
  return (
    <>
      <Section
        title={t("Scripts")}
        action={
          !empty && (
            <button
              type="button"
              className={quietButton}
              onClick={() => setScripts([...scripts, blank])}
            >
              {t("Add script")}
            </button>
          )
        }
      >
        {empty ? (
          <p className="px-4 py-3 text-body text-muted-foreground">{empty}</p>
        ) : scripts.length === 0 ? (
          <p className="px-4 py-3 text-body text-muted-foreground">
            {t("No scripts. Add one, or import one from parallax.json.")}
          </p>
        ) : (
          scripts.map((script, i) => (
            <div key={i} className="border-border px-4 py-3 not-last:border-b">
              <div className="flex items-center gap-2">
                <input
                  aria-label={t("Name")}
                  placeholder={t("Name")}
                  value={script.name}
                  onChange={(e) => edit(i, { name: e.target.value })}
                  className={`${field} mt-0 font-medium`}
                />
                <button
                  type="button"
                  className={quietButton}
                  onClick={() => setScripts(scripts.filter((_, j) => j !== i))}
                >
                  {t("Remove")}
                </button>
              </div>
              <textarea
                aria-label={t("Command")}
                placeholder="pnpm install"
                rows={2}
                value={script.command}
                onChange={(e) => edit(i, { command: e.target.value })}
                className={`${field} font-mono`}
              />
              <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-body text-muted-foreground">
                <span className="flex items-center gap-2">
                  <Switch
                    label={
                      script.name
                        ? t("Run {{name}} on a new worktree", { name: script.name })
                        : t("Run it on a new worktree")
                    }
                    checked={script.runOnWorktreeCreate ?? false}
                    onChange={(on) => edit(i, { runOnWorktreeCreate: on })}
                  />
                  {t("On a new worktree")}
                </span>
                {script.runOnWorktreeCreate && (
                  <span className="flex items-center gap-2">
                    <Switch
                      label={
                        script.name
                          ? t("Hold the agent until {{name}} finishes", { name: script.name })
                          : t("Hold the agent until it finishes")
                      }
                      checked={script.async === false}
                      onChange={(on) => edit(i, { async: on ? false : undefined })}
                    />
                    {t("Agent waits for it")}
                  </span>
                )}
                <span className="flex items-center gap-2">
                  <Switch
                    label={
                      script.name
                        ? t("Run {{name}} when a thread settles", { name: script.name })
                        : t("Run it when a thread settles")
                    }
                    checked={script.runOnSettle ?? false}
                    onChange={(on) => edit(i, { runOnSettle: on })}
                  />
                  {t("When a thread settles")}
                </span>
              </div>
            </div>
          ))
        )}
        {!empty && (
          <div className="flex items-center justify-end gap-3 border-t border-border px-4 py-2.5">
            <button
              type="button"
              className={quietButton}
              disabled={!dirty || busy}
              onClick={() => setScripts(saved ?? [])}
            >
              {t("Discard")}
            </button>
            <button
              type="button"
              className={primaryButton}
              disabled={!dirty || busy}
              onClick={() => void save()}
            >
              {t("Save")}
            </button>
          </div>
        )}
      </Section>
      {!empty && (file?.error || (file?.scripts.length ?? 0) > 0) && (
        <Section title={t("From parallax.json")}>
          <p className="border-b border-border px-4 py-3 text-body text-muted-foreground">
            {t(
              "The repository's parallax.json declares these. They run only once you import and save them.",
            )}
          </p>
          {file?.error && (
            <p role="alert" className="px-4 py-3 text-body text-danger">
              {file.error}
            </p>
          )}
          {file?.scripts.map((script) => (
            <div key={script.id} className={settingRow}>
              <div className="min-w-0">
                <span className="block text-body font-medium">
                  {script.name}
                  {scriptRoles(script) && (
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      · {scriptRoles(script)}
                    </span>
                  )}
                </span>
                <code className="block truncate font-mono text-meta text-muted-foreground">
                  {script.command}
                </code>
              </div>
              <button
                type="button"
                className={quietButton}
                onClick={() => setScripts([...scripts, script])}
              >
                {t("Import")}
              </button>
            </div>
          ))}
        </Section>
      )}
    </>
  );
}
