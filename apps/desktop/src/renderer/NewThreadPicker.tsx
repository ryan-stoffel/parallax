import { t } from "i18next";
import { Plus, Search, SlidersHorizontal } from "lucide-react";
import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { flushSync } from "react-dom";

import { msg } from "../i18n";
import type { Repo } from "../protocol/generated/protocol";
import { close, Footer, navigate } from "./AddDialog";
import { pickerPrefs, setPickerPrefs, type PickerPrefs } from "./prefs";
import { RepoIcon } from "./Sidebar";
import { noRepo, type OtherRepo, type ThreadGroup } from "./threads";
import {
  IconButton,
  Menu,
  menuHeading,
  MenuOption,
  RowBadge,
  rowShortcut,
  Segmented,
  ToolbarMenuRow,
  useModHeld,
} from "./ui";
import type { Workspace } from "./WorkspaceMenu";

/** An orchestrator thread New thread's picker offers to continue. */
export interface PickerOrchestrator {
  /** `<host>/<id>`. */
  key: string;
  name: string;
  icon: ReactNode;
  /** Its computer, its branch, or what it last did. */
  hint?: string;
  open: () => void;
}

/** What the picker starts: a thread, or an orchestrator thread. */
export type PickerKind = "thread" | "orchestrator";

/** Opens the picker, on Thread unless told otherwise. */
export type NewThreadPickerHandle = { open: (kind?: PickerKind) => void };

const kinds: { value: PickerKind; name: string }[] = [
  { value: "thread", name: msg("Thread") },
  { value: "orchestrator", name: msg("Orchestrator") },
];

const orders: { value: PickerPrefs["order"]; label: string }[] = [
  { value: "recent", label: msg("Recently used") },
  { value: "name", label: msg("Name") },
  { value: "added", label: msg("Date added") },
];

/** How many rows Page Up and Page Down move. */
const page = 5;

/**
 * Mod+N's picker, laid out as Add Repository is. Thread lists which repository, or Chat, a new
 * thread goes in, then the orchestrator threads to continue (0093). Orchestrator lists the
 * repositories to start one in, then the same orchestrators. Tab switches between them, and
 * Shift+Tab moves focus as usual.
 * Up and Down move and wrap, Home, End, Page Up, and Page Down jump, Enter picks, Mod+1 to Mod+9
 * pick that row, Escape closes. The footer's menu sets the order, row size, and whether Thread
 * lists orchestrators (`pickerPrefs`). A repository on one computer shows that computer and its
 * path; one that several computers list (`several`) shows as one project, since the computer is
 * chosen after it (PLX-1498). Picking closes it and calls `onPick` with the group's id,
 * for one of the other computers' repositories `onPickElsewhere` with its computer and entry, an
 * orchestrator's `open`, or `onNewOrchestrator` with the repository to start it in.
 */
export function NewThreadPicker({
  ref,
  groups,
  repos,
  hostId,
  hostName,
  elsewhere,
  several,
  lastUsed,
  onPick,
  onPickElsewhere,
  orchestrators = [],
  onNewOrchestrator,
}: {
  ref: Ref<NewThreadPickerHandle>;
  /** Repositories and Chat, as the sidebar groups them. */
  groups: ThreadGroup[];
  /** The host's repo entries, for each group's icon and path. */
  repos: Repo[];
  hostId: string;
  /** The host's name, shown on its rows when there's more than one computer to tell apart. */
  hostName?: string;
  /** The other computers' repositories, listed among the host's own. */
  elsewhere: OtherRepo[];
  /** The names of the repositories more than one computer lists (`reposOnSeveral`). */
  several?: ReadonlySet<string>;
  /** When a repository last had a thread, in ms, by `<host>/<entry>`. */
  lastUsed: ReadonlyMap<string, number>;
  onPick: (groupId: string) => void;
  onPickElsewhere: (hostId: string, groupId: string) => void;
  /** The orchestrator threads to continue, most recently active first. */
  orchestrators?: PickerOrchestrator[];
  /** Starts a new orchestrator thread; with none, the Orchestrator switch doesn't show. */
  onNewOrchestrator?: (workspace?: Workspace) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [kind, setKind] = useState<PickerKind>("thread");
  const prefs = pickerPrefs.use();
  const modHeld = useModHeld();
  const listId = useId();
  const menuId = useId();
  // As of opening, so another thread's prompt never moves a row under the active one.
  const [usedAtOpen, setUsedAtOpen] = useState(lastUsed);

  useImperativeHandle(ref, () => ({
    open: (start = "thread") => {
      // Rendered before showModal, so it never shows the other kind's rows first.
      flushSync(() => {
        setKind(start);
        setUsedAtOpen(lastUsed);
      });
      dialog.current?.showModal();
    },
  }));

  const switchKind = (next: PickerKind) => {
    setKind(next);
    setActive(0);
    search.current?.focus();
  };

  // Each row's value is its group id, or for another computer's repository, `host/entry`, since
  // entry ids are only unique per computer.
  type Row = {
    value: string;
    name: string;
    icon: ReactNode;
    /** Whose it is, before its second line. */
    computer?: string;
    /** Its second line. */
    hint?: string;
    /** That the hint is a path, whose end says the most, so it's cut from the start. */
    path?: boolean;
    pick: () => void;
  };

  // Every repository, wherever it is, and what starting in one needs.
  const places = [
    ...groups
      .filter((g) => g.id !== noRepo)
      .flatMap((g) => {
        const repo = repos.find((r) => r.id === g.id);
        return repo
          ? [{ hostId, repo, computer: hostName, pick: () => onPick(g.id), name: g.name }]
          : [];
      }),
    ...elsewhere.map((o) => ({
      hostId: o.host.id,
      repo: o.repo,
      computer: o.host.name,
      pick: () => onPickElsewhere(o.host.id, o.repo.id),
      name: o.repo.name,
    })),
  ];
  const used = (p: (typeof places)[number]) => usedAtOpen.get(`${p.hostId}/${p.repo.id}`) ?? 0;
  if (prefs.order === "name") places.sort((a, b) => a.name.localeCompare(b.name));
  if (prefs.order === "recent") places.sort((a, b) => used(b) - used(a));
  if (prefs.order === "added")
    places.sort((a, b) => Date.parse(a.repo.createdAt) - Date.parse(b.repo.createdAt));
  const noRepoGroup = groups.find((g) => g.id === noRepo);

  const placeRow = (p: (typeof places)[number], pick: () => void): Row => ({
    value: p.hostId === hostId ? p.repo.id : `${p.hostId}/${p.repo.id}`,
    name: p.name,
    icon: <RepoIcon repo={p.repo} />,
    // One computer's copy says where it is; a repository on several is just the project.
    ...(!several?.has(p.repo.name) && { computer: p.computer, hint: p.repo.path, path: true }),
    pick,
  });
  const repoRows: Row[] =
    kind === "thread"
      ? [
          ...places.map((p) => placeRow(p, p.pick)),
          ...(noRepoGroup
            ? [
                {
                  value: noRepo,
                  name: t("No repo"),
                  icon: <RepoIcon repo={undefined} />,
                  pick: () => onPick(noRepo),
                },
              ]
            : []),
        ]
      : places.length > 0
        ? places.map((p) =>
            placeRow(p, () => onNewOrchestrator?.({ hostId: p.hostId, repo: p.repo })),
          )
        : [
            {
              value: "orchestrator:new",
              name: t("New orchestrator thread"),
              icon: (
                <span className="grid size-4 place-items-center text-muted-foreground">
                  <Plus className="size-4" />
                </span>
              ),
              hint: t("A thread that plans the work and hands it to other threads"),
              pick: () => onNewOrchestrator?.(),
            },
          ];
  const orchestratorRows: Row[] =
    kind === "orchestrator" || prefs.orchestrators
      ? orchestrators.map((o) => ({
          value: `orchestrator:${o.key}`,
          name: o.name,
          icon: o.icon,
          hint: o.hint,
          pick: o.open,
        }))
      : [];
  const rows = [...repoRows, ...orchestratorRows];

  // Every word has to match its name or second line, and matches in the name come first.
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const inName = (row: Row) => words.every((w) => row.name.toLowerCase().includes(w));
  const matching = (all: Row[]) => {
    const found = all.filter((row) => {
      const text = `${row.name} ${row.computer ?? ""} ${row.hint ?? ""}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    return [...found.filter(inName), ...found.filter((row) => !inName(row))];
  };
  const shownRepos = matching(repoRows);
  const shownOrchestrators = matching(orchestratorRows);
  const shown = [...shownRepos, ...shownOrchestrators];
  const current = shown[Math.min(active, shown.length - 1)];

  // The active row stays in view as the keys move it. A section's label sticks over the list, and
  // the list's scroll padding keeps the row clear of it. The first row shows its label too.
  useEffect(() => {
    if (shown[0] === current) list.current?.scrollTo?.({ top: 0 });
    else
      list.current
        ?.querySelector<HTMLElement>("[data-active]")
        ?.scrollIntoView?.({ block: "nearest" });
  }, [current?.value, kind, query, prefs.compact]);

  const option = (row: Row) => {
    const i = shown.indexOf(row);
    return (
      <button
        key={row.value}
        id={`${listId}-${row.value}`}
        type="submit"
        role="option"
        aria-selected={row === current}
        name="group"
        value={row.value}
        data-active={row === current || undefined}
        // Chromium sends a mouse move with no movement when a row scrolls under a resting pointer,
        // which would take the active row back from the keyboard.
        onMouseMove={(e) => {
          if (e.movementX !== 0 || e.movementY !== 0) setActive(i);
        }}
        className={`flex w-full items-center gap-3 rounded-lg px-2.5 text-left data-active:bg-hover ${prefs.compact ? "py-1.5" : "py-2"}`}
      >
        {row.icon}
        <span className={`min-w-0 flex-1 ${prefs.compact ? "flex items-baseline gap-2.5" : ""}`}>
          <span
            className={`truncate text-reading ${prefs.compact ? "max-w-[60%] shrink-0" : "block"}`}
          >
            {row.name}
          </span>
          <RowHint row={row} />
        </span>
        {modHeld && i < 9 && <RowBadge index={i} />}
      </button>
    );
  };

  return (
    <dialog
      ref={dialog}
      aria-label={t("New thread in")}
      onClose={() => {
        setQuery("");
        setActive(0);
        setKind("thread");
      }}
      // A click on the backdrop, outside the panel, closes it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
      className="mx-auto mt-[14vh] w-[36rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface p-0 text-foreground shadow-composer backdrop:bg-black/50"
    >
      <form
        method="dialog"
        // The dialog closes itself on submit; the button that submitted says what was picked.
        onSubmit={(e) => {
          const value = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value");
          rows.find((row) => row.value === value)?.pick();
        }}
        onKeyDown={(e) => {
          const n = rowShortcut(e);
          const last = shown.length - 1;
          const at = current ? shown.indexOf(current) : 0;
          // Where the key moves the active row. With text typed, Home and End stay the box's.
          const moves: Record<string, number> = {
            ArrowDown: at === last ? 0 : at + 1,
            ArrowUp: at === 0 ? last : at - 1,
            PageDown: Math.min(at + page, last),
            PageUp: Math.max(at - page, 0),
            ...(!query && { Home: 0, End: last }),
          };
          const to = moves[e.key];
          if (n !== undefined) {
            // Not the sidebar's row too.
            e.preventDefault();
            e.stopPropagation();
            const row = shown[n];
            if (row) e.currentTarget.requestSubmit(submitterFor(e.currentTarget, row.value));
          } else if (to !== undefined && shown.length > 0) {
            e.preventDefault();
            setActive(to);
            // Shift+Tab stays the browser's, which is how the keyboard reaches the options button.
          } else if (e.key === "Tab" && !e.shiftKey && onNewOrchestrator) {
            e.preventDefault();
            switchKind(kind === "thread" ? "orchestrator" : "thread");
          } else if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
            e.preventDefault();
            if (current)
              e.currentTarget.requestSubmit(submitterFor(e.currentTarget, current.value));
          }
        }}
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
          <input
            // The native attribute, so showModal focuses the search box.
            ref={(el) => {
              search.current = el;
              el?.setAttribute("autofocus", "");
            }}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={current && `${listId}-${current.value}`}
            aria-label={t("Search repositories and orchestrator threads")}
            placeholder={t("Search…")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            className="min-w-0 flex-1 bg-transparent text-reading placeholder:text-faint-foreground focus-visible:outline-none"
          />
          {onNewOrchestrator && (
            <Segmented
              label={t("Start")}
              options={kinds.map((k) => ({ ...k, name: t(k.name) }))}
              value={kind}
              onChange={switchKind}
            />
          )}
        </div>
        <div
          ref={list}
          // Clears the sticky label above a row and the padding below it.
          className="max-h-[50vh] scroll-pt-8 scroll-pb-2 overflow-y-auto px-2 pb-2"
        >
          <div id={listId} role="listbox" aria-label={t("Where it starts")}>
            {shownRepos.length > 0 && (
              <Section label={kind === "thread" ? t("Repositories") : t("New orchestrator in")}>
                {shownRepos.map((row) => option(row))}
              </Section>
            )}
            {shownOrchestrators.length > 0 && (
              <Section
                label={
                  kind === "thread"
                    ? t("Orchestrator threads")
                    : t("Continue", { context: "orchestrator threads to resume" })
                }
              >
                {shownOrchestrators.map((row) => option(row))}
              </Section>
            )}
          </div>
          {shown.length === 0 && (
            <p className="px-2.5 pt-3 pb-1 text-body text-faint-foreground">
              {t("Nothing matches")}
            </p>
          )}
        </div>
        <Footer
          keys={[
            [navigate[0], t("Move")],
            ["Enter", t("Pick")],
            ...(onNewOrchestrator
              ? ([["Tab", kind === "thread" ? t("Orchestrator") : t("Thread")]] as [
                  ReactNode,
                  string,
                ][])
              : []),
            close,
          ]}
        >
          <IconButton label={t("Picker options")} popoverTarget={menuId} className="ml-auto">
            <SlidersHorizontal />
          </IconButton>
        </Footer>
      </form>
      {/* Outside the form, so its keys never move the list or pick a row. */}
      <Menu
        id={menuId}
        label={t("Picker options")}
        align="end"
        focus='[aria-checked="true"]'
        className="w-56"
        onClose={() => search.current?.focus()}
      >
        <div className={menuHeading}>{t("Sort repositories by")}</div>
        {orders.map((o) => (
          <MenuOption
            key={o.value}
            option={{ value: o.value, label: t(o.label) }}
            checked={prefs.order === o.value}
            onClick={() => setPickerPrefs({ order: o.value })}
          />
        ))}
        <hr className="-mx-1 my-1 border-border" />
        <ToolbarMenuRow
          icon={null}
          className="px-2!"
          label={t("Compact rows")}
          checked={prefs.compact}
          onClick={() => setPickerPrefs({ compact: !prefs.compact })}
        />
        <ToolbarMenuRow
          icon={null}
          className="px-2!"
          label={t("Orchestrators under Thread")}
          checked={prefs.orchestrators}
          onClick={() => setPickerPrefs({ orchestrators: !prefs.orchestrators })}
        />
      </Menu>
    </dialog>
  );
}

/** A row's second line, or the rest of its one line when compact: its computer, then its hint. */
function RowHint({ row }: { row: { computer?: string; hint?: string; path?: boolean } }) {
  if (!row.computer && !row.hint) return null;
  return (
    <span className="flex min-w-0 flex-1 text-body text-muted-foreground">
      {row.computer && (
        <span className="shrink-0 whitespace-pre">
          {row.computer}
          {row.hint && " · "}
        </span>
      )}
      {row.hint && (
        // Right to left, so a path too long for the row loses its start and keeps its folder.
        <span className={`min-w-0 truncate ${row.path ? "[direction:rtl]" : ""}`}>
          <bdi>{row.hint}</bdi>
        </span>
      )}
    </span>
  );
}

/** The group's own button, so a keyboard pick submits the same value a click would. */
function submitterFor(form: HTMLFormElement, id: string): HTMLButtonElement | undefined {
  return form.querySelector<HTMLButtonElement>(`button[name="group"][value="${id}"]`) ?? undefined;
}

/** A section of the picker's list, under its label, which screen readers name it by. */
function Section({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id}>
      <p
        id={id}
        className="sticky top-0 z-10 bg-surface px-2.5 pt-2.5 pb-1.5 text-meta font-medium text-faint-foreground"
      >
        {label}
      </p>
      {children}
    </div>
  );
}
