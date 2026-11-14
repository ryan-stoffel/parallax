// Thread details' Project row (0090): the Project a thread is in, and a menu to add it to one, move
// it to another, or take it out. The sidebar row's Add to Project opens the same menu. It lists every
// computer's Projects, since same-named Projects count as one (0097).
import { t } from "i18next";
import { ChevronDown, MessagesSquare, X } from "lucide-react";
import { type RefObject, useId, useRef } from "react";

import type { Repo, Thread } from "../protocol/generated/protocol";
import { notify } from "./notifications";
import { RepoIcon, type HostThreads } from "./Sidebar";
import { addToProject, projectChoices, type ThreadsView } from "./threads";
import { Menu, menuItem, ToolbarMenuRow, toolbarMenuDivider } from "./ui";

export { projectChoices };

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
      <span className="min-w-0 flex-1 truncate">
        {current ? current.name : t("Add to a Project")}
      </span>
    </>
  );
  if (startedIn)
    return (
      <div title={t("Started in this Project, so it stays here")} className={menuItem}>
        {label}
      </div>
    );
  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        aria-haspopup="menu"
        aria-label={
          current ? t("Project: {{name}}", { name: current.name }) : t("Add to a Project")
        }
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
      notify({ tone: "error", title: t("Couldn't change the thread's Project"), body: failed });
  };
  return (
    <Menu
      ref={menu}
      id={id}
      label={t("Projects")}
      align="end"
      // Its Projects are checkboxes, and it must not open on Remove from Project.
      focus='[role^="menuitem"]'
      className="max-h-80 min-w-52 overflow-y-auto p-1.5"
    >
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
            label={t("Remove from Project")}
            onClick={() => void move()}
          />
        </>
      )}
    </Menu>
  );
}
