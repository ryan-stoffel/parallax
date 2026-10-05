import { ArrowLeft, LockOpen } from "lucide-react";
import { useId, useRef, useState } from "react";

import type {
  Project,
  ProjectAutonomy,
  ProjectCreateParams,
  ProjectIcon as ProjectIconValue,
  ProjectPermission,
  Repo,
} from "../protocol/generated/protocol";
import { useConnection } from "./ConnectionStatus";
import { describeError } from "./errors";
import { type Host } from "./hosts";
import { IconPicker } from "./IconPicker";
import { iconImageBytes } from "./images";
import { autonomyLevels } from "./ProjectPermission";
import { ProjectIcon } from "./Sidebar";
import type { ThreadsView } from "./threads";
import { IconButton, Segmented } from "./ui";
import { uuidv7 } from "./uuidv7";
import { WorkspaceMenu, type Workspace, type WorkspaceSource } from "./WorkspaceMenu";

/**
 * Create Project, the add palette's last step (AddDialog), laid out like Cursor's: the Project's
 * icon and name, then its Workspace, a repository on any host, then its autonomy and full access.
 * Creating closes the dialog and calls `onCreated` with the host it was made on, and plxd's error
 * stays in the form. The icon is a button that opens the icon picker where the Workspace's host
 * can keep one (`projectEdit`, 0032). Autonomy (0043) and full access (Bypass, 0042) show only
 * where that host keeps them, full access on by default. The Workspace menu's ways to add a
 * repository call `onAdd`, and the palette comes back with it as `chosen`.
 */
export function NewProjectForm({
  hosts,
  hostId,
  repos,
  create,
  chosen,
  onChoose,
  onAdd,
  onBack,
  onCreated,
}: {
  hosts: Host[];
  /** The open host, whose first repository is the default. */
  hostId: string;
  /** The open host's repo entries. The scratch one isn't offered. */
  repos: Repo[];
  /** Creates it on the open host, whose list then has it at once. */
  create: ThreadsView["createProject"];
  chosen?: Workspace;
  onChoose: (workspace: Workspace) => void;
  onAdd: (source: WorkspaceSource) => void;
  onBack: () => void;
  onCreated: (hostId: string, project: Project) => void;
}) {
  const first = repos.find((r) => !r.scratch);
  // The open host's first repository until another is chosen, or if its host was removed.
  const workspace =
    chosen && hosts.some((h) => h.id === chosen.hostId) ? chosen : first && { hostId, repo: first };
  // The repository's folder name until one is typed.
  const [typed, setTyped] = useState<string>();
  const name = (typed ?? workspace?.repo.name ?? "").trim();
  const pickerId = useId();
  const [chosenIcon, setChosenIcon] = useState<ProjectIconValue>();
  const [fullAccess, setFullAccess] = useState(true);
  const [chosenAutonomy, setAutonomy] = useState<ProjectAutonomy>("routine");
  // The Workspace's host decides, since the Project is made there. Without `projectEdit` its plxd
  // would drop an icon, so none is shown or sent.
  const connection = useConnection(workspace?.hostId ?? hostId);
  const capabilities = connection?.status === "connected" ? connection.capabilities : {};
  const iconable = "projectEdit" in capabilities;
  const maxImageBytes = iconImageBytes(connection);
  let icon = iconable ? chosenIcon : undefined;
  // Nor an image where it would drop that (0038), after a Workspace on another host.
  if (icon?.image && maxImageBytes === undefined) icon = { ...icon, image: undefined };
  const permission: ProjectPermission | undefined =
    "projectPermission" in capabilities ? (fullAccess ? "bypass" : "auto") : undefined;
  const autonomy = "projectAutonomy" in capabilities ? chosenAutonomy : undefined;
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  // The last try's params, whose id a retry with the same host, name, path, icon, mode, and
  // autonomy sends again (0007).
  const attempt = useRef<ProjectCreateParams & { hostId: string }>(undefined);

  const submit = async (dialog: HTMLDialogElement) => {
    if (!workspace || !name) return;
    const last = attempt.current;
    const params =
      last?.hostId === workspace.hostId &&
      last.name === name &&
      last.repoPath === workspace.repo.path &&
      last.icon?.name === icon?.name &&
      last.icon?.color === icon?.color &&
      last.icon?.image === icon?.image &&
      last.permission === permission &&
      last.autonomy === autonomy
        ? last
        : {
            hostId: workspace.hostId,
            id: uuidv7(),
            name,
            repoPath: workspace.repo.path,
            ...(icon && { icon }),
            ...(permission && { permission }),
            ...(autonomy && { autonomy }),
          };
    attempt.current = params;
    setCreating(true);
    setError(undefined);
    const project =
      params.hostId === hostId
        ? await create(
            params.id,
            params.name,
            params.repoPath,
            params.icon,
            params.permission,
            params.autonomy,
          )
        : await createOn(params.hostId, params);
    setCreating(false);
    // Closed while it was creating, as with Escape: drop the late answer.
    if (!dialog.open) return;
    if (typeof project === "string") return setError(project);
    dialog.close();
    onCreated(params.hostId, project);
  };

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(e.currentTarget.closest("dialog")!);
        }}
      >
        <div className="flex items-center gap-3 px-4 py-3.5">
          {/* A plain button, so Enter in the name creates rather than goes back. */}
          <IconButton label="Back" onClick={onBack}>
            <ArrowLeft />
          </IconButton>
          <h2 id="new-project-title" className="text-[14px] font-medium">
            Create Project
          </h2>
          <p className="truncate text-[12.5px] text-muted-foreground">
            A focused chat where agents coordinate work.
          </p>
        </div>
        <div className="flex flex-col items-center gap-3 px-5 pt-2 pb-5">
          {iconable ? (
            <button
              type="button"
              popoverTarget={pickerId}
              aria-haspopup="dialog"
              aria-label="Choose icon"
              title="Choose icon"
              className={`${iconTile} hover:bg-hover`}
            >
              <ProjectIcon icon={icon} className="size-8" />
            </button>
          ) : (
            <span className={iconTile}>
              <ProjectIcon className="size-8" />
            </span>
          )}
          <input
            // The native attribute, so showModal focuses the name when the palette opens here.
            ref={(el) => el?.setAttribute("autofocus", "")}
            aria-label="Name"
            placeholder="New Project"
            value={typed ?? workspace?.repo.name ?? ""}
            onChange={(e) => setTyped(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-transparent text-center text-[22px] font-semibold placeholder:text-faint-foreground focus-visible:outline-none"
          />
        </div>
        <div className="mx-5 mb-3 flex items-center justify-between gap-4 rounded-lg border border-border py-1.5 pr-1.5 pl-3">
          <span aria-hidden className="shrink-0 text-[13px]">
            Workspace
          </span>
          <WorkspaceMenu
            hosts={hosts}
            value={workspace}
            onChange={(next) => {
              setError(undefined);
              onChoose(next);
            }}
            onAdd={onAdd}
          />
        </div>
        {autonomy && (
          <div className="mx-5 mb-3 rounded-lg border border-border px-3 py-2.5">
            <div className="flex items-center justify-between gap-4">
              <span aria-hidden className="text-[13px]">
                Autonomy
              </span>
              <Segmented
                label="Autonomy"
                options={autonomyLevels}
                value={autonomy}
                onChange={setAutonomy}
              />
            </div>
            <p className="mt-1.5 text-[12px] text-muted-foreground">
              {autonomyLevels.find((l) => l.value === autonomy)?.detail}
            </p>
          </div>
        )}
        {permission && (
          <label className="mx-5 mb-5 flex items-start gap-3 rounded-lg bg-selected px-3 py-2.5">
            <LockOpen aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">
              <span className="block text-[13px] font-medium">Full access</span>
              <span className="block text-[12px] text-muted-foreground">
                Agents in this Project run commands and edit files without asking.
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={fullAccess}
              onChange={(e) => setFullAccess(e.target.checked)}
              className="mt-0.5 size-4 accent-primary"
            />
          </label>
        )}
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
      {/* Outside the form, so Enter in the picker never creates the Project. */}
      {iconable && (
        <IconPicker
          id={pickerId}
          value={icon}
          onPick={setChosenIcon}
          align="center"
          maxImageBytes={maxImageBytes}
        />
      )}
    </>
  );
}

const iconTile = "grid size-16 place-items-center rounded-2xl border border-border bg-background";

/** `project/create` on a host that isn't open. Its list has the Project once it's opened. */
async function createOn(
  hostId: string,
  { id, name, repoPath, icon, permission, autonomy }: ProjectCreateParams,
): Promise<Project | string> {
  const answer = await window.parallax.request(hostId, "project/create", {
    id,
    name,
    repoPath,
    ...(icon && { icon }),
    ...(permission && { permission }),
    ...(autonomy && { autonomy }),
  });
  return "error" in answer ? describeError(answer.error) : answer.result.project;
}
