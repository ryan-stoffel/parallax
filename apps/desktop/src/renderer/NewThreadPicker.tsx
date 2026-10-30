import { ArrowLeft, Plus, Search } from "lucide-react";
import { useId, useState, type ReactNode, type Ref } from "react";

import type { Repo } from "../protocol/generated/protocol";
import { close, Footer, navigate } from "./AddDialog";
import { RepoIcon } from "./Sidebar";
import { noRepo, type OtherRepo, type ThreadGroup } from "./threads";
import { RowBadge, rowShortcut } from "./ui";

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

/**
 * Mod+N's picker: which repository, or Chat, a new thread goes in, laid out as Add Repository
 * is, then the orchestrator threads to continue and New orchestrator thread, since orchestrators
 * start here (0093). Up and Down move, Enter picks, Mod+1 to Mod+9 pick that row, Escape closes.
 * Open it with `ref.current.showModal()`; picking closes it and calls `onPick` with the group's id,
 * for one of the other computers' repositories `onPickElsewhere` with its computer and entry, an
 * orchestrator's `open`, or `onNewOrchestrator`.
 */
export function NewThreadPicker({
  ref,
  groups,
  repos,
  hostName,
  elsewhere,
  onPick,
  onPickElsewhere,
  orchestrators = [],
  onNewOrchestrator,
}: {
  ref: Ref<HTMLDialogElement>;
  /** Repositories and Chat, as the sidebar groups them. */
  groups: ThreadGroup[];
  /** The host's repo entries, for each group's icon and path. */
  repos: Repo[];
  hostName: string;
  /** The other computers' repositories, listed after the host's own. */
  elsewhere: OtherRepo[];
  onPick: (groupId: string) => void;
  onPickElsewhere: (hostId: string, groupId: string) => void;
  /** The orchestrator threads to continue, most recently active first. */
  orchestrators?: PickerOrchestrator[];
  /** Starts a new orchestrator thread; with none, New orchestrator thread doesn't show. */
  onNewOrchestrator?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();

  const q = query.trim().toLowerCase();
  // Each row's value is its group id, or for another computer's repository, `host/entry`, since
  // entry ids are only unique per computer.
  // Every row's icon and second line, and what picking it does. A repository's second line is its
  // computer and path.
  type Row = { value: string; name: string; icon: ReactNode; hint?: string; pick: () => void };
  const repoRows: Row[] = [
    ...groups.map((g): Row => {
      const repo = repos.find((r) => r.id === g.id);
      return {
        value: g.id,
        name: g.id === noRepo ? "No repo" : g.name,
        icon: <RepoIcon repo={repo} />,
        hint: repo && g.id !== noRepo && !g.project ? `${hostName} · ${repo.path}` : undefined,
        pick: () => onPick(g.id),
      };
    }),
    ...elsewhere.map((o): Row => ({
      value: `${o.host.id}/${o.repo.id}`,
      name: o.repo.name,
      icon: <RepoIcon repo={o.repo} />,
      hint: `${o.host.name} · ${o.repo.path}`,
      pick: () => onPickElsewhere(o.host.id, o.repo.id),
    })),
  ];
  const orchestratorRows: Row[] = [
    ...orchestrators.map((o): Row => ({
      value: `orchestrator:${o.key}`,
      name: o.name,
      icon: o.icon,
      hint: o.hint,
      pick: o.open,
    })),
    ...(onNewOrchestrator
      ? [
          {
            value: "orchestrator:new",
            name: "New orchestrator thread",
            icon: (
              <span className="grid size-4 place-items-center text-muted-foreground">
                <Plus className="size-4" />
              </span>
            ),
            hint: "A thread that plans the work and hands it to other threads",
            pick: onNewOrchestrator,
          },
        ]
      : []),
  ];
  const rows = [...repoRows, ...orchestratorRows];
  const matches = (row: Row) => row.name.toLowerCase().includes(q);
  const shownRepos = repoRows.filter(matches);
  const shownOrchestrators = orchestratorRows.filter(matches);
  const shown = [...shownRepos, ...shownOrchestrators];
  const current = shown[Math.min(active, shown.length - 1)];

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
        onMouseMove={() => setActive(i)}
        className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left data-active:bg-hover"
      >
        {row.icon}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-reading">{row.name}</span>
          {row.hint && (
            <span className="block truncate text-body text-muted-foreground">{row.hint}</span>
          )}
        </span>
        {i < 9 && <RowBadge index={i} />}
      </button>
    );
  };

  return (
    <dialog
      ref={ref}
      aria-label="New thread in"
      onClose={() => {
        setQuery("");
        setActive(0);
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
          const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
          const n = rowShortcut(e);
          if (n !== undefined) {
            // Not the sidebar's row too.
            e.preventDefault();
            e.stopPropagation();
            const row = shown[n];
            if (row) e.currentTarget.requestSubmit(submitterFor(e.currentTarget, row.value));
          } else if (step && shown.length > 0) {
            e.preventDefault();
            const i = current ? shown.indexOf(current) : 0;
            setActive((i + step + shown.length) % shown.length);
          } else if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
            e.preventDefault();
            if (current)
              e.currentTarget.requestSubmit(submitterFor(e.currentTarget, current.value));
          }
        }}
      >
        <div className="flex items-center gap-3 px-4 py-3.5">
          <button
            type="submit"
            value=""
            aria-label="Close"
            className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4"
          >
            <ArrowLeft />
          </button>
          <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
          <input
            // The native attribute, so showModal focuses the search box rather than Close.
            ref={(el) => el?.setAttribute("autofocus", "")}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={current && `${listId}-${current.value}`}
            aria-label="Search repositories and orchestrator threads"
            placeholder="Search…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            className="min-w-0 flex-1 bg-transparent text-reading placeholder:text-faint-foreground focus-visible:outline-none"
          />
        </div>
        <div className="max-h-[50vh] overflow-y-auto px-2 pb-2">
          <div id={listId} role="listbox" aria-label="Where it starts">
            {shownRepos.length > 0 && (
              <Section label="Repositories">{shownRepos.map((row) => option(row))}</Section>
            )}
            {shownOrchestrators.length > 0 && (
              <Section label="Orchestrator threads">
                {shownOrchestrators.map((row) => option(row))}
              </Section>
            )}
          </div>
          {shown.length === 0 && (
            <p className="px-2.5 py-2 text-body text-faint-foreground">Nothing matches</p>
          )}
        </div>
        <Footer keys={[[navigate[0], "Move"], ["Enter", "Pick"], close]} />
      </form>
    </dialog>
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
    <div role="group" aria-labelledby={id} className="first:[&>p]:pt-1">
      <p id={id} className="px-2.5 pt-2 pb-1.5 text-meta font-medium text-faint-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}
