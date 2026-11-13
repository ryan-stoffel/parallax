import { t } from "i18next";
import { ClipboardList, FolderGit2, FolderOpen } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
} from "react";

import { Actions } from "./Actions";
import { RemoteControlSection } from "./ClaudeRemoteControl";
import { UsageRows, type ComposerUsageData } from "./ComposerUsage";
import { DetailsCard, detailsCard } from "./DetailsCard";
import { GitMenu } from "./GitMenu";
import { icons } from "./icons";
import { LineageSection } from "./Lineage";
import { OpenMenu } from "./OpenMenu";
import { LinkedPullRequests } from "./PullRequests";
import { hostIcon } from "./RunTargetMenu";
import { ThreadProjectMenu } from "./ThreadProjectMenu";
import type { Host } from "./hosts";
import {
  resetThreadDetails,
  THREAD_DETAILS_ITEMS,
  toggleItem,
  useThreadDetailsPrefs,
} from "./threadDetailsItems";
import {
  GroupHeading,
  IconButton,
  Menu,
  MenuOption,
  menuItem,
  openOnContextMenu,
  toolbarMenuDivider,
} from "./ui";

/** Where the keys of the threads that show Thread details are kept, as a JSON array. */
export const THREAD_DETAILS_KEY = "parallax.threadDetails.open";
const THREAD_DETAILS_ID = "thread-details";
/** What's in the workspace card, which goes when all of them are off. */
const WORKSPACE_ITEMS = ["environment", "openIn", "actions", "project"] as const;

/** The docked card's width, `w-72`, its right gap included. */
const DOCKED_WIDTH = 288;
/** The least a thread keeps beside a docked card, as it keeps beside the app's panels. */
const MIN_THREAD_WIDTH = 400;

/**
 * Whether docking Thread details in a row `width` wide would leave a thread too little room, so
 * the card floats over the thread instead. `share` is the part of the row its tile has.
 */
export const tooNarrowToDock = (width: number, share = 1) =>
  width > 0 && width * share - DOCKED_WIDTH < MIN_THREAD_WIDTH;

type ThreadDetailsMode = "docked" | "floating" | "hidden";

/** The keys of the threads kept showing Thread details. */
function readOpen(): string[] {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(THREAD_DETAILS_KEY) ?? "[]");
    return Array.isArray(kept) ? kept.filter((key) => typeof key === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Where Thread details shows for the thread `key` names, in the thread row `ref` is set on, which
 * may unmount and return (behind the Pull requests page) and is measured again each time. Each
 * thread keeps its own choice, hidden until shown there. Shown, it docks beside the thread, which
 * centers its text and composer in what's left, and floats over the thread only when docking
 * wouldn't leave it enough room. `share` is the part of the row its tile has.
 */
export function useThreadDetails(key: string, share = 1) {
  const [element, ref] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(readOpen);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setNarrow(tooNarrowToDock(element.getBoundingClientRect().width, share));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, share]);
  const toggle = () =>
    setOpen((was) => {
      const next = was.includes(key) ? was.filter((other) => other !== key) : [...was, key];
      localStorage.setItem(THREAD_DETAILS_KEY, JSON.stringify(next));
      return next;
    });
  // Hides it for `key`'s thread, as when what it opened takes over. Never shows it, even called
  // from a render before the user closed it, as when Create PR finishes.
  const close = () =>
    setOpen((was) => {
      const next = was.filter((other) => other !== key);
      localStorage.setItem(THREAD_DETAILS_KEY, JSON.stringify(next));
      return next;
    });
  const mode: ThreadDetailsMode = !open.includes(key) ? "hidden" : narrow ? "floating" : "docked";
  return { mode, toggle, close, ref };
}

/** The top bar's button that shows and hides Thread details. */
export function ThreadDetailsButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <IconButton
      label={t("Thread details")}
      aria-pressed={open}
      aria-controls={THREAD_DETAILS_ID}
      onClick={onToggle}
    >
      <ClipboardList />
    </IconButton>
  );
}

/**
 * Thread details, inside the thread's card, docked at its right or floating over the thread: a
 * stack of cards, after the redesign in `pingdotgg/t3code`'s `maria/redesign/*`. The
 * workspace card comes first, with the thread's computer and folder, Open in, repository actions,
 * and its Project. The others, Git, pull requests, context, and lineage, can be collapsed and
 * reordered. Its menu, on a right-click anywhere or the sliders button, shows and hides each item.
 * A Claude Remote Control thread's session takes the place of the host, Open in, actions, and Git,
 * which are another computer's (PLX-1140). Mounted while hidden, and so are items turned off, so
 * the Open and action shortcuts keep working.
 */
export function ThreadDetails({
  mode,
  host,
  folder,
  worktree,
  actions,
  git,
  prs,
  lineage,
  project,
  remoteControl,
  usage,
}: {
  mode: ThreadDetailsMode;
  host: Host;
  folder?: string;
  worktree?: boolean;
  actions?: ComponentProps<typeof Actions>;
  git?: ComponentProps<typeof GitMenu>;
  prs?: ComponentProps<typeof LinkedPullRequests>;
  lineage?: Omit<ComponentProps<typeof LineageSection>, "visible">;
  project?: ComponentProps<typeof ThreadProjectMenu>;
  /** A Claude Remote Control thread's session, once read. */
  remoteControl?: ComponentProps<typeof RemoteControlSection>;
  /** The open thread's context and usage, as its composer last reported them. */
  usage?: ComposerUsageData;
}) {
  const menuId = useId();
  const customize = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const { shows, customized } = useThreadDetailsPrefs();
  const linked = prs?.prs.urls.length ?? 0;
  const prOpen = !!prs?.prs.urls.some((url) => prs.prs.get(url)?.pr?.state === "open");
  const onContextMenu = (e: MouseEvent<HTMLElement>) => {
    // Menus opened from the card, fields, links, and selected text keep their own.
    const target = e.target as Element;
    if (
      e.defaultPrevented ||
      target.closest("[popover], dialog, input, textarea, a[href]") ||
      !window.getSelection()?.isCollapsed
    )
      return;
    openOnContextMenu(e, customize.current);
  };
  const copyFolder = () => {
    if (!folder) return;
    void navigator.clipboard.writeText(folder);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  const customizeButton = (
    <IconButton
      ref={customize}
      size="sm"
      label={t("Customize Thread details")}
      popoverTarget={menuId}
      aria-haspopup="menu"
    >
      <icons.customize />
    </IconButton>
  );
  // This computer's or the thread's computer's folder, apps, and actions.
  const workspace = (
    <section
      aria-label={t("Workspace")}
      hidden={!WORKSPACE_ITEMS.some(shows)}
      className={`${detailsCard} p-1`}
    >
      <div
        hidden={!shows("environment")}
        title={folder ?? t("No folder yet")}
        className="group flex items-center gap-0.5 py-0.5 pr-1 pl-2 text-body"
      >
        <span aria-hidden className="shrink-0 text-muted-foreground">
          {hostIcon(host)}
        </span>
        {worktree ? (
          <FolderGit2 aria-hidden className="shrink-0 text-muted-foreground" />
        ) : (
          <FolderOpen aria-hidden className="shrink-0 text-muted-foreground" />
        )}
        <span className="ml-2 min-w-0 flex-1 truncate">{host.name}</span>
        {folder && (
          <IconButton
            reveal
            size="sm"
            label={copied ? t("Copied") : t("Copy folder path")}
            onClick={copyFolder}
          >
            {copied ? <icons.done /> : <icons.copy />}
          </IconButton>
        )}
        {shows("environment") && customizeButton}
      </div>
      <div hidden={!shows("openIn")}>
        <OpenMenu hostId={host.id} hostName={host.name} folder={folder} />
      </div>
      {actions && (
        <div hidden={!shows("actions")}>
          <Actions {...actions} />
        </div>
      )}
      {project && (
        <div hidden={!shows("project")}>
          <ThreadProjectMenu {...project} />
        </div>
      )}
    </section>
  );
  return (
    <aside
      id={THREAD_DETAILS_ID}
      aria-label={t("Thread details")}
      hidden={mode === "hidden"}
      data-mode={mode}
      // Inside the thread's card, below its tabs' row. Docked, it takes room beside the thread;
      // floating, it hovers over the thread's right, short of the composer. Either way it's opaque cards sized to their rows, scrolling past
      // their room.
      className={`flex w-72 flex-col py-2 pr-3 ${
        mode === "floating"
          ? "pointer-events-none absolute top-0 right-0 bottom-36 z-30 max-w-[calc(100%-1rem)]"
          : "shrink-0"
      }`}
    >
      <div
        onContextMenu={onContextMenu}
        // Floating, the backing keeps the transcript from showing between the cards.
        className={`rise-in pointer-events-auto flex max-h-full flex-col gap-1.5 overflow-y-auto rounded-xl text-foreground [&_img]:size-4 [&_svg]:size-4 ${
          mode === "floating" ? "bg-background shadow-composer" : ""
        }`}
      >
        {remoteControl && <RemoteControlSection {...remoteControl} />}
        {/* A Remote Control thread works on another computer, which its section names: no folder,
            apps, actions, or Git of this one's. */}
        {remoteControl
          ? project &&
            shows("project") && (
              <section aria-label={t("Project")} className={`${detailsCard} p-1`}>
                <ThreadProjectMenu {...project} />
              </section>
            )
          : workspace}
        {git && !remoteControl && (
          <GitMenu
            {...git}
            hasPr={prOpen}
            branch={shows("branch")}
            changes={shows("changes")}
            actions={shows("gitActions")}
          />
        )}
        {prs && linked > 0 && (
          <DetailsCard
            id="prs"
            title={t("Pull requests")}
            summary={linked > 1 ? linked : undefined}
            hidden={!shows("prs")}
          >
            <LinkedPullRequests {...prs} />
          </DetailsCard>
        )}
        {usage?.summary && (
          <DetailsCard
            id="context"
            title={t("Context")}
            summary={usage.context}
            hidden={!shows("context")}
          >
            <div className="px-2 pt-0.5 pb-2 text-body tabular-nums">
              <UsageRows data={usage} />
            </div>
          </DetailsCard>
        )}
        {lineage && (
          <LineageSection {...lineage} hidden={!shows("lineage")} visible={mode !== "hidden"} />
        )}
        {/* The sliders sit in the first row. With that row off or a Remote Control thread's in its
            place, they go here. */}
        {(remoteControl || !shows("environment")) && (
          <div style={{ order: 99 }} className="flex justify-end">
            {customizeButton}
          </div>
        )}
        <Menu id={menuId} label={t("Show in Thread details")} align="end" className="w-60 p-1">
          <GroupHeading>{t("Show in Thread details")}</GroupHeading>
          {THREAD_DETAILS_ITEMS.map((item) => (
            <MenuOption
              key={item.id}
              role="menuitemcheckbox"
              option={{ value: item.id, label: t(item.label) }}
              checked={shows(item.id)}
              onClick={() => toggleItem(item.id)}
            />
          ))}
          <hr className={toolbarMenuDivider} />
          <button
            type="button"
            role="menuitem"
            disabled={!customized}
            onClick={resetThreadDetails}
            className={`${menuItem} disabled:opacity-50 disabled:hover:bg-transparent`}
          >
            {t("Reset to default")}
          </button>
        </Menu>
      </div>
    </aside>
  );
}
