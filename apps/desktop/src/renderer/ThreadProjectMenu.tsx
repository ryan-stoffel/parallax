// Thread details' Project row (0090): the Project a thread is in, and a menu to add it to one, move
// it to another, or take it out. The sidebar row's Add to Project opens the same menu. It lists every
// computer's Projects, since same-named Projects count as one (0097).
import { ChevronDown, MessagesSquare, X } from "lucide-react";
import { type RefObject, useId, useRef } from "react";

import type { Repo, Thread } from "../protocol/generated/protocol";
import { notify } from "./notifications";
import { RepoIcon, type HostThreads } from "./Sidebar";
import { addToProject, joinableProjects, type ThreadsView } from "./threads";
import { Menu, menuItem, ToolbarMenuRow, toolbarMenuDivider } from "./ui";

/**
 * Where `thread` can be added to a Project: any computer's Projects (`joinableProjects`), and the
 * Project it was started in, which it stays in. Orchestrator threads can join Projects too (0093).
 * Undefined for an orchestrator's child, or where plxd can't add threads to Projects or none exist.
 */
export function projectChoices(
  thread: Thread,
  view: ThreadsView,
  computers: HostThreads[],
): { projects: Repo[]; startedIn?: Repo } | undefined {
  const home = view.state.repos.find((r) => r.id === thread.repo);
  const projects = joinableProjects(view, computers);
  const orchestrator = view.state.orchestrators.some((p) => p.run === thread.id);
  if ((!home && !orchestrator) || !("projectThreads" in view.capabilities) || projects.length === 0)
    return undefined;
  return { projects, startedIn: home?.project ? home : undefined };
}

/**
 * The thread's Project, or Add to a Project, opening a menu of every computer's Projects. A thread
 * started in a Project lives there, so its row only names it. Nothing shows where projectChoices
 * has none.
 */
export function ThreadProjectMenu({
  thread,
  view,
  computers,
}: {
  thread: Thread;
  view: ThreadsView;
  computers: HostThreads[];
}) {
  const id = useId();
  const choices = projectChoices(thread, view, computers);
  if (!choices) return null;
  const { projects, startedIn } = choices;
  const current = startedIn ?? projects.find((s) => s.id === thread.project);
  const label = (
    <>
      {current ? (
        <RepoIcon repo={current} />
      ) : (
        <MessagesSquare aria-hidden className="text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate">{current ? current.name : "Add to a Project"}</span>
    </>
  );
  if (startedIn)
    return (
      <div title="Started in this Project, so it stays here" className={menuItem}>
        {label}
      </div>
    );
  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        aria-haspopup="menu"
        aria-label={current ? `Project: ${current.name}` : "Add to a Project"}
        className={menuItem}
      >
        {label}
        <ChevronDown aria-hidden className="text-muted-foreground" />
      </button>
      <ProjectPicker id={id} thread={thread} view={view} projects={projects} />
    </>
  );
}

/**
 * The menu of `projects` to add `thread` to, checking its own, with Remove from Project while in
 * one.
 */
export function ProjectPicker({
  id,
  thread,
  view,
  projects,
  ref,
}: {
  id: string;
  thread: Thread;
  view: ThreadsView;
  projects: Repo[];
  ref?: RefObject<HTMLDivElement | null>;
}) {
  const own = useRef<HTMLDivElement>(null);
  const menu = ref ?? own;
  const move = async (project?: Repo) => {
    menu.current?.hidePopover();
    if (project?.id === thread.project) return;
    const failed = project
      ? await addToProject(view, [thread], project)
      : await view.setProject([thread.id]);
    if (failed)
      notify({ tone: "error", title: "Couldn't change the thread's Project", body: failed });
  };
  return (
    <Menu ref={menu} id={id} label="Projects" align="end" className="min-w-52 p-1.5">
      {projects.map((s) => (
        <ToolbarMenuRow
          key={s.id}
          // Wrapped, so the row doesn't mute it as it does a bare icon.
          icon={
            <span className="flex">
              <RepoIcon repo={s} />
            </span>
          }
          label={s.name}
          checked={s.id === thread.project}
          onClick={() => void move(s)}
        />
      ))}
      {projects.some((s) => s.id === thread.project) && (
        <>
          <hr className={toolbarMenuDivider} />
          <ToolbarMenuRow
            icon={<X aria-hidden />}
            label="Remove from Project"
            onClick={() => void move()}
          />
        </>
      )}
    </Menu>
  );
}
