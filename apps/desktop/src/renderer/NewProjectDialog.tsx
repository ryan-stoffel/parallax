import { X } from "lucide-react";
import { useRef, useState, type Ref } from "react";

import type { Project, ProjectCreateParams, Repo } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import { localId, type Host } from "./hosts";
import { ProjectIcon } from "./Sidebar";
import type { ThreadsView } from "./threads";
import { IconButton } from "./ui";
import { uuidv7 } from "./uuidv7";
import { WorkspaceMenu, type Workspace } from "./WorkspaceMenu";

/**
 * The Create Project dialog, a native modal <dialog> (focus trap and Escape come free), laid out
 * like Cursor's: the Project's icon and name, then its Workspace, a repository on any host. Open
 * it with `ref.current.showModal()`. Creating closes it and calls `onCreated` with the host it
 * was made on, and wispd's error stays in the dialog.
 */
export function NewProjectDialog({
  ref,
  hosts,
  hostId,
  repos,
  create,
  onCreated,
}: {
  ref: Ref<HTMLDialogElement>;
  hosts: Host[];
  /** The open host, whose first repository is the default. */
  hostId: string;
  /** The open host's repo entries. The scratch one isn't offered. */
  repos: Repo[];
  /** Creates it on the open host, whose list then has it at once. */
  create: ThreadsView["createProject"];
  onCreated: (hostId: string, project: Project) => void;
}) {
  const [chosen, setChosen] = useState<Workspace>();
  const first = repos.find((r) => !r.scratch);
  // The open host's first repository until another is chosen, or if its host was removed.
  const workspace =
    chosen && hosts.some((h) => h.id === chosen.hostId) ? chosen : first && { hostId, repo: first };
  // The repository's folder name until one is typed.
  const [typed, setTyped] = useState<string>();
  const name = (typed ?? workspace?.repo.name ?? "").trim();
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  // The last try's params, whose id a retry with the same host, name, and path sends again (0007).
  const attempt = useRef<ProjectCreateParams & { hostId: string }>(undefined);

  const chooseFolder = async () => {
    setError(undefined);
    const path = await window.wisp.pickFolder();
    if (!path) return;
    // A fresh id is safe to retry with: wispd returns the entry a path already has.
    const added = await window.wisp.request(localId, "repo/add", { id: uuidv7(), path });
    if ("error" in added) setError(describeError(added.error));
    else setChosen({ hostId: localId, repo: added.result.repo });
  };

  const submit = async (dialog: HTMLDialogElement) => {
    if (!workspace || !name) return;
    const last = attempt.current;
    const params =
      last?.hostId === workspace.hostId &&
      last.name === name &&
      last.repoPath === workspace.repo.path
        ? last
        : { hostId: workspace.hostId, id: uuidv7(), name, repoPath: workspace.repo.path };
    attempt.current = params;
    setCreating(true);
    setError(undefined);
    const project =
      params.hostId === hostId
        ? await create(params.id, params.name, params.repoPath)
        : await createOn(params.hostId, params);
    setCreating(false);
    // Closed while it was creating, as with Escape: drop the late answer.
    if (!dialog.open) return;
    if (typeof project === "string") return setError(project);
    dialog.close();
    onCreated(params.hostId, project);
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby="new-project-title"
      onClose={() => {
        setChosen(undefined);
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
        <div className="flex flex-col items-center gap-3 px-5 pt-3 pb-5">
          {/* The default icon, for now: RYA-230 makes it a button that picks one. */}
          <span className="grid size-16 place-items-center rounded-2xl border border-border bg-background">
            <ProjectIcon className="size-8" />
          </span>
          <input
            aria-label="Name"
            placeholder="New Project"
            value={typed ?? workspace?.repo.name ?? ""}
            onChange={(e) => setTyped(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-transparent text-center text-[22px] font-semibold placeholder:text-faint-foreground focus-visible:outline-none"
          />
        </div>
        <div className="mx-5 mb-5 flex items-center justify-between gap-4 rounded-lg border border-border py-1.5 pr-1.5 pl-3">
          <span aria-hidden className="shrink-0 text-[13px]">
            Workspace
          </span>
          <WorkspaceMenu
            hosts={hosts}
            value={workspace}
            onChange={(next) => {
              setError(undefined);
              setChosen(next);
            }}
            onChooseFolder={() => void chooseFolder()}
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
            disabled={!workspace || !name || creating}
            className="ml-auto shrink-0 whitespace-nowrap rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create Project"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** `project/create` on a host that isn't open. Its list has the Project once it's opened. */
async function createOn(
  hostId: string,
  { id, name, repoPath }: ProjectCreateParams,
): Promise<Project | string> {
  const answer = await window.wisp.request(hostId, "project/create", { id, name, repoPath });
  return "error" in answer ? describeError(answer.error) : answer.result.project;
}
