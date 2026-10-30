// Thread details' Space row (0090): the Space a thread is in, and a menu to add it to one, move it
// to another, or take it out. The sidebar row's Add to Space opens the same menu.
import { ChevronDown, MessagesSquare, X } from "lucide-react";
import { type RefObject, useId, useRef } from "react";

import type { Repo, Thread } from "../protocol/generated/protocol";
import { notify } from "./notifications";
import { RepoIcon } from "./Sidebar";
import type { ThreadsView } from "./threads";
import { Menu, menuItem, ToolbarMenuRow, toolbarMenuDivider } from "./ui";

/**
 * Where `thread` can be added to a Space: this computer's Spaces, and the Space it was started in,
 * which it stays in. Undefined for a Project's thread, or where plxd can't add threads to Spaces or
 * has none.
 */
export function spaceChoices(
  thread: Thread,
  view: ThreadsView,
): { spaces: Repo[]; startedIn?: Repo } | undefined {
  const { repos } = view.state;
  const home = repos.find((r) => r.id === thread.repo);
  const spaces = repos.filter((r) => r.space);
  if (!home || !("spaceThreads" in view.capabilities) || spaces.length === 0) return undefined;
  return { spaces, startedIn: home.space ? home : undefined };
}

/**
 * The thread's Space, or Add to a Space, opening a menu of this computer's Spaces. A thread started in
 * a Space lives there, so its row only names it. Nothing shows where spaceChoices has none.
 */
export function SpaceMenu({ thread, view }: { thread: Thread; view: ThreadsView }) {
  const id = useId();
  const choices = spaceChoices(thread, view);
  if (!choices) return null;
  const { spaces, startedIn } = choices;
  const current = startedIn ?? spaces.find((s) => s.id === thread.space);
  const label = (
    <>
      {current ? (
        <RepoIcon repo={current} />
      ) : (
        <MessagesSquare aria-hidden className="text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate">{current ? current.name : "Add to a Space"}</span>
    </>
  );
  if (startedIn)
    return (
      <div title="Started in this Space, so it stays here" className={menuItem}>
        {label}
      </div>
    );
  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        aria-haspopup="menu"
        aria-label={current ? `Space: ${current.name}` : "Add to a Space"}
        className={menuItem}
      >
        {label}
        <ChevronDown aria-hidden className="text-muted-foreground" />
      </button>
      <SpacePicker id={id} thread={thread} view={view} spaces={spaces} />
    </>
  );
}

/** The menu of `spaces` to add `thread` to, checking its own, with Remove from Space while in one. */
export function SpacePicker({
  id,
  thread,
  view,
  spaces,
  ref,
}: {
  id: string;
  thread: Thread;
  view: ThreadsView;
  spaces: Repo[];
  ref?: RefObject<HTMLDivElement | null>;
}) {
  const own = useRef<HTMLDivElement>(null);
  const menu = ref ?? own;
  const move = async (space?: string) => {
    menu.current?.hidePopover();
    if (space === thread.space) return;
    const failed = await view.setSpace([thread.id], space);
    if (failed)
      notify({ tone: "error", title: "Couldn't change the thread's Space", body: failed });
  };
  return (
    <Menu ref={menu} id={id} label="Spaces" align="end" className="min-w-52 p-1.5">
      {spaces.map((s) => (
        <ToolbarMenuRow
          key={s.id}
          // Wrapped, so the row doesn't mute it as it does a bare icon.
          icon={
            <span className="flex">
              <RepoIcon repo={s} />
            </span>
          }
          label={s.name}
          checked={s.id === thread.space}
          onClick={() => void move(s.id)}
        />
      ))}
      {spaces.some((s) => s.id === thread.space) && (
        <>
          <hr className={toolbarMenuDivider} />
          <ToolbarMenuRow
            icon={<X aria-hidden />}
            label="Remove from Space"
            onClick={() => void move()}
          />
        </>
      )}
    </Menu>
  );
}
