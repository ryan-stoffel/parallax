import { Folder, Plus, X } from "lucide-react";
import { useId, useRef, useState, type Ref } from "react";

import type { Project, Repo } from "../protocol/generated/protocol";
import type { ThreadsView } from "./threads";
import { IconButton, Picker } from "./ui";
import { uuidv7 } from "./uuidv7";

const addRepository = "add-repository";

/**
 * The Create Project dialog, a native modal <dialog> (focus trap and Escape come free). Open it
 * with `ref.current.showModal()`. A Project is a name on one of the host's repositories; on this
 * computer, "Add repository…" adds another first. Creating closes it and calls `onCreated`, and
 * wispd's error stays in the dialog.
 */
export function NewProjectDialog({
  ref,
  repos,
  local,
  addRepo,
  create,
  onCreated,
}: {
  ref: Ref<HTMLDialogElement>;
  /** The host's repo entries. The scratch one isn't offered. */
  repos: Repo[];
  /** Whether the host is this computer, so its folders can be browsed. */
  local: boolean;
  addRepo: ThreadsView["addRepo"];
  create: ThreadsView["createProject"];
  onCreated: (project: Project) => void;
}) {
  const row = "flex items-center justify-between gap-4 px-5 py-3";
  const nameId = useId();
  const choices = repos.filter((r) => !r.scratch);
  const [repoId, setRepoId] = useState<string>();
  const repo = choices.find((r) => r.id === repoId) ?? choices[0];
  // The repository's folder name until one is typed.
  const [typed, setTyped] = useState<string>();
  const name = (typed ?? repo?.name ?? "").trim();
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  // The last try's params, whose id a retry with the same name and path sends again (0007).
  const attempt = useRef<{ id: string; name: string; repoPath: string }>(undefined);

  const pickRepository = async () => {
    setError(undefined);
    const path = await window.wisp.pickFolder();
    if (!path) return;
    const added = await addRepo(path);
    if (typeof added === "string") setError(added);
    else setRepoId(added.id);
  };

  const submit = async (dialog: HTMLDialogElement) => {
    if (!repo || !name) return;
    const last = attempt.current;
    const params =
      last?.name === name && last.repoPath === repo.path
        ? last
        : { id: uuidv7(), name, repoPath: repo.path };
    attempt.current = params;
    setCreating(true);
    setError(undefined);
    const project = await create(params.id, params.name, params.repoPath);
    setCreating(false);
    // Closed while it was creating, as with Escape: drop the late answer.
    if (!dialog.open) return;
    if (typeof project === "string") return setError(project);
    dialog.close();
    onCreated(project);
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby="new-project-title"
      onClose={() => {
        setRepoId(undefined);
        setTyped(undefined);
        setError(undefined);
        attempt.current = undefined;
      }}
      className="m-auto w-[26rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(e.currentTarget.closest("dialog")!);
        }}
      >
        <div className="flex items-start gap-3 px-5 pt-4 pb-3">
          <div className="flex-1">
            <h2 id="new-project-title" className="text-[15px] font-semibold">
              Create Project
            </h2>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              A focused chat where agents coordinate work.
            </p>
          </div>
          {/* A plain button, so Enter in the name creates rather than closes. */}
          <IconButton label="Close" onClick={(e) => e.currentTarget.closest("dialog")!.close()}>
            <X />
          </IconButton>
        </div>
        <div className={`${row} border-b border-border`}>
          <span aria-hidden className="text-[13px]">
            Repository
          </span>
          <Picker
            label="Repository"
            align="end"
            icon={<Folder />}
            value={repo?.id ?? ""}
            onChange={(value) => {
              if (value === addRepository) return void pickRepository();
              setError(undefined);
              setRepoId(value);
            }}
            options={[
              ...choices.map((r) => ({ value: r.id, label: r.name, icon: <Folder /> })),
              ...(local
                ? [
                    {
                      value: addRepository,
                      label: "Add repository…",
                      icon: <Plus />,
                      divider: true,
                    },
                  ]
                : []),
            ]}
          />
        </div>
        <div className={row}>
          <label htmlFor={nameId} className="text-[13px]">
            Name
          </label>
          <input
            id={nameId}
            value={typed ?? repo?.name ?? ""}
            onChange={(e) => setTyped(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="w-52 rounded-md border border-border bg-background px-2.5 py-1 text-[13px]"
          />
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          {error && (
            <p role="alert" className="min-w-0 text-[12px] text-danger">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={!repo || !name || creating}
            className="ml-auto shrink-0 whitespace-nowrap rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create Project"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
