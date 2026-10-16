import { Check, CircleAlert, Layers, MessageCircleQuestion, Minus, Search } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { Area } from "../protocol/generated/protocol";
import { areaColor, areaColors, areaNameError, maxAreaName, nextColor } from "./areas";
import type { Attention } from "./attention";
import { DoneMark, WorkingMark } from "./AttentionMark";
import { shortcut } from "./ui";

/** A thread or Project the editor can pick, under its repo entry's group. */
export interface Candidate {
  kind: "thread" | "project";
  id: string;
  title: string;
  /** Its group: a repo entry's id, or "" for No repo. */
  group: string;
  groupName: string;
  groupIcon: ReactNode;
  attention: Attention;
  /** When it was last active, newest first within a group. */
  at: string;
}

/** A repo entry or Space the editor can add whole (PLX-852). */
export interface Folder {
  id: string;
  name: string;
  icon: ReactNode;
  space: boolean;
}

/** What Save sends: the area's fields, its members split by kind. */
export type AreaFields = Omit<Area, "id">;

/** A small mark of what a candidate asks of the user, or nothing when it's settled. */
function StatusMark({ attention }: { attention: Attention }) {
  const look = "flex [&_svg]:size-3.5";
  if (attention === "needsYou")
    return (
      <span title="Needs you" className={`${look} text-warning`}>
        <MessageCircleQuestion aria-hidden />
      </span>
    );
  if (attention === "working")
    return (
      <span title="Working" className={`${look} text-working`}>
        <WorkingMark />
      </span>
    );
  if (attention === "failed")
    return (
      <span title="Failed" className={`${look} text-danger`}>
        <CircleAlert aria-hidden />
      </span>
    );
  if (attention === "done")
    return (
      <span title="Done" className={`${look} text-added`}>
        <DoneMark animate={false} />
      </span>
    );
  return null;
}

/** A square of an area's color. */
export function AreaSwatch({
  color,
  className = "size-2.5",
}: {
  color: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      style={{ background: areaColor(color) }}
      className={`inline-block shrink-0 rounded-[3px] ${className}`}
    />
  );
}

/** A checkbox's box: checked, mixed, or empty. */
function Box({ state }: { state: boolean | "mixed" }) {
  return (
    <span
      aria-hidden
      className={`grid size-3.75 shrink-0 place-items-center rounded-[4.5px] border-[1.5px] text-accent-foreground [&_svg]:size-2.5 ${state ? "border-accent bg-accent" : "border-border"}`}
    >
      {state === "mixed" ? <Minus strokeWidth={3.5} /> : state ? <Check strokeWidth={3.5} /> : null}
    </span>
  );
}

/**
 * New area or Edit area (PLX-789), a modal: a name, one of eight colors (a new area's starts at
 * the first no area uses), and a searchable picker of the host's top-level threads and Projects,
 * grouped by repo, each group with a checkbox for all of it. Each candidate shows its status and
 * the other areas it's in. Where the host's plxd has `areaRepos`, a list above it adds whole Spaces
 * and repos (PLX-852). ⌘↵ saves, as Enter in the name does; Delete area asks inline first.
 */
export function AreaEditor({
  area,
  areas,
  candidates,
  folders,
  initial,
  onSave,
  onDelete,
  onClose,
}: {
  /** The area to edit; absent for New area. */
  area?: Area;
  /** The host's areas, for unique names, the next color, and each candidate's other areas. */
  areas: readonly Area[];
  candidates: readonly Candidate[];
  /** The host's Spaces and repos, where its plxd keeps them as members; absent hides the list. */
  folders?: readonly Folder[];
  /** New area's name and picks to start with, as from the filter's text or a row's menu. */
  initial?: { name?: string; threads?: string[]; projects?: string[] };
  /** Saves; resolves to plxd's error, for people, or undefined once saved. */
  onSave: (fields: AreaFields) => Promise<string | undefined>;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const [name, setName] = useState(area?.name ?? initial?.name ?? "");
  const [color, setColor] = useState(area?.color ?? nextColor(areas));
  const [picked, setPicked] = useState(
    () =>
      new Set([
        ...(area?.threads ?? initial?.threads ?? []),
        ...(area?.projects ?? initial?.projects ?? []),
      ]),
  );
  const [pickedFolders, setPickedFolders] = useState(() => new Set(area?.repos ?? []));
  // The area's Spaces and repos as it opened come first, then Spaces before repos.
  const [firstFolders] = useState(pickedFolders);
  const rank = (f: Folder) => (firstFolders.has(f.id) ? 0 : 2) + (f.space ? 0 : 1);
  const sortedFolders = folders && [...folders].sort((a, b) => rank(a) - rank(b));
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    nameInput.current?.focus();
  }, []);

  const q = query.trim().toLowerCase();
  const shown = candidates.filter(
    (c) => !q || c.title.toLowerCase().includes(q) || c.groupName.toLowerCase().includes(q),
  );
  // Groups holding what the area had as it opened come first, and stay put while picking.
  const [first] = useState(picked);
  const leads = (group: string) =>
    candidates.some((c) => c.group === group && first.has(c.id)) ? 0 : 1;
  const groups = [...new Set(shown.map((c) => c.group))]
    .sort((a, b) => leads(a) - leads(b))
    .map((group) => {
      const members = shown
        .filter((c) => c.group === group)
        .sort(
          (a, b) =>
            (a.kind === "project" ? 0 : 1) - (b.kind === "project" ? 0 : 1) ||
            Date.parse(b.at) - Date.parse(a.at),
        );
      return { group, name: members[0]!.groupName, icon: members[0]!.groupIcon, members };
    });
  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(picked);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    setPicked(next);
  };

  const save = async () => {
    if (saving) return;
    const problem = areaNameError(name, areas, area?.id);
    if (problem) {
      setError(problem);
      nameInput.current?.focus();
      return;
    }
    setSaving(true);
    const known = new Map(candidates.map((c) => [c.id, c.kind]));
    // Members the picker doesn't list, such as an archived thread or the archived row New area
    // was opened from, stay as they were.
    const keep = (list: string[] = []) => list.filter((id) => !known.has(id));
    const failed = await onSave({
      name: name.trim(),
      color,
      threads: [
        ...keep(area?.threads ?? initial?.threads),
        ...[...picked].filter((id) => known.get(id) === "thread"),
      ],
      projects: [
        ...keep(area?.projects ?? initial?.projects),
        ...[...picked].filter((id) => known.get(id) === "project"),
      ],
      ...(folders && { repos: [...pickedFolders] }),
    });
    setSaving(false);
    if (failed) setError(failed);
  };

  const count = [...picked].filter((id) => candidates.some((c) => c.id === id)).length;
  const others = (id: string) =>
    areas.filter((a) => a.id !== area?.id && [...a.threads, ...a.projects].includes(id));
  const sectionLabel =
    "mt-3.5 mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground";
  const pickRow =
    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.25 text-left text-[13px] hover:bg-hover";

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void save();
        } else if (e.key === "Escape" && confirming) {
          e.preventDefault();
          setConfirming(false);
        }
      }}
      className="m-auto max-h-[calc(100%-2.5rem)] open:flex w-[27rem] max-w-[calc(100%-2.5rem)] flex-col rounded-2xl border border-border bg-surface p-4.5 text-foreground shadow-composer backdrop:bg-black/40 motion-safe:animate-[sidebar-pop_140ms_ease-out]"
    >
      <h2 id={titleId} className="text-[15px] font-semibold">
        {area ? "Edit area" : "New area"}
      </h2>
      {!area && (
        <p className="mt-1 text-[12.5px] leading-normal text-muted-foreground">
          Pick threads from any repo, Project, or Space. They stay where they are, and show up here
          too.
        </p>
      )}
      <label className={`${sectionLabel} mt-3`}>Name</label>
      <input
        ref={nameInput}
        aria-label="Name"
        aria-invalid={!!error}
        value={name}
        maxLength={maxAreaName}
        autoComplete="off"
        spellCheck={false}
        placeholder="Launch week, Client work…"
        onChange={(e) => {
          setName(e.target.value);
          setError(undefined);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          }
        }}
        className={`h-8.5 w-full rounded-lg border bg-transparent px-2.5 text-[13px] placeholder:text-faint-foreground focus-visible:outline-none ${error ? "border-danger ring-3 ring-danger/15" : "border-border focus:border-ring focus:ring-3 focus:ring-ring/15"}`}
      />
      {error && (
        <p role="alert" className="mt-1.5 text-[12px] text-danger">
          {error}
        </p>
      )}
      <p className={sectionLabel}>Color</p>
      <div
        role="radiogroup"
        aria-label="Color"
        className="flex gap-2"
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault();
          const i = areaColors.findIndex((c) => c.key === color);
          const next =
            areaColors[
              (i + (e.key === "ArrowRight" ? 1 : -1) + areaColors.length) % areaColors.length
            ]!;
          setColor(next.key);
          e.currentTarget.querySelector<HTMLElement>(`[data-color="${next.key}"]`)?.focus();
        }}
      >
        {areaColors.map((c) => (
          <button
            key={c.key}
            type="button"
            role="radio"
            data-color={c.key}
            aria-checked={color === c.key}
            aria-label={c.label}
            title={c.label}
            tabIndex={color === c.key ? 0 : -1}
            onClick={() => setColor(c.key)}
            style={{ background: areaColor(c.key) }}
            className="size-5 rounded-md transition-transform hover:scale-110 aria-checked:ring-2 aria-checked:ring-foreground aria-checked:ring-offset-2 aria-checked:ring-offset-surface motion-reduce:transition-none"
          />
        ))}
      </div>
      {folders && folders.length > 0 && (
        <>
          <p className={sectionLabel}>
            Spaces and repos
            <span className="font-normal">· every thread in them</span>
          </p>
          <div className="mb-0.5 max-h-32 shrink-0 overflow-y-auto rounded-xl border border-border p-1">
            {sortedFolders!.map((f) => {
              const on = pickedFolders.has(f.id);
              return (
                <button
                  key={f.id}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => {
                    const next = new Set(pickedFolders);
                    if (on) next.delete(f.id);
                    else next.add(f.id);
                    setPickedFolders(next);
                  }}
                  className={pickRow}
                >
                  <Box state={on} />
                  {f.icon}
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <span className="shrink-0 text-[11.5px] text-faint-foreground">
                    {f.space ? "Space" : "Repo"}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
      <p className={sectionLabel}>
        Threads and Projects
        <span className="font-normal">· {count} picked</span>
        {count > 0 && (
          <button
            type="button"
            onClick={() =>
              toggle(
                candidates.map((c) => c.id),
                false,
              )
            }
            className="ml-auto rounded px-1 text-[12px] font-medium text-accent hover:underline"
          >
            Clear
          </button>
        )}
      </p>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border">
        <label className="flex shrink-0 items-center gap-2 border-b border-border px-2.5 py-1.75 text-faint-foreground">
          <Search aria-hidden className="size-3.5 shrink-0" />
          <input
            aria-label="Find a thread"
            placeholder="Find a thread, Project, or repo"
            value={query}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Escape clears the search before it closes the editor.
              if (e.key === "Escape" && query) {
                e.preventDefault();
                setQuery("");
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground placeholder:text-faint-foreground focus-visible:outline-none"
          />
        </label>
        <div className="max-h-64 overflow-y-auto p-1">
          {groups.map((g) => {
            const ids = g.members.map((m) => m.id);
            const n = ids.filter((id) => picked.has(id)).length;
            const state = n === 0 ? false : n === ids.length ? true : ("mixed" as const);
            return (
              <div key={g.group} role="group" aria-label={g.name}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={state}
                  title={`${state === true ? "Remove" : "Add"} every thread in ${g.name}`}
                  onClick={() => toggle(ids, state !== true)}
                  className={`${pickRow} mt-0.5 text-[12px] font-medium text-muted-foreground`}
                >
                  <Box state={state} />
                  {g.icon}
                  <span className="min-w-0 truncate">{g.name}</span>
                  <span className="ml-auto shrink-0 font-normal text-faint-foreground tabular-nums">
                    {n ? `${n} of ` : ""}
                    {ids.length}
                  </span>
                </button>
                {g.members.map((m) => {
                  const on = picked.has(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      title={m.title}
                      onClick={() => toggle([m.id], !on)}
                      className={`${pickRow} pl-7.5`}
                    >
                      <Box state={on} />
                      {m.kind === "project" && (
                        <Layers aria-hidden className="size-3.5 shrink-0 text-accent" />
                      )}
                      <span
                        className={`min-w-0 flex-1 truncate ${m.kind === "project" ? "font-medium" : ""}`}
                      >
                        {m.title}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.25">
                        <StatusMark attention={m.attention} />
                        {others(m.id).map((a) => (
                          <span key={a.id} title={`Also in ${a.name}`} className="flex">
                            <AreaSwatch color={a.color} className="size-1.75" />
                          </span>
                        ))}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          {groups.length === 0 && (
            <p className="px-2 py-1.5 text-[12.5px] text-faint-foreground">
              {candidates.length ? "Nothing matches." : "No threads yet."}
            </p>
          )}
        </div>
      </div>
      <div className="mt-4 flex shrink-0 items-center gap-2">
        {confirming && area ? (
          <div
            role="alertdialog"
            aria-label={`Delete ${area.name}?`}
            className="flex w-full items-center gap-2 rounded-lg bg-danger/8 py-1.5 pr-1.5 pl-3 text-[12.5px]"
          >
            <span className="flex-1 leading-snug">
              Delete <b className="font-semibold">{area.name}</b>? Its threads stay where they are.
            </span>
            <button
              type="button"
              autoFocus
              onClick={() => setConfirming(false)}
              className="rounded-md border border-border px-2.5 py-1 text-[12px] font-medium hover:bg-hover"
            >
              Keep
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="rounded-md bg-red-600 px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90"
            >
              Delete
            </button>
          </div>
        ) : (
          <>
            {area && onDelete && (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-medium text-danger hover:bg-hover"
              >
                Delete area
              </button>
            )}
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              className="rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-medium hover:bg-hover"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!name.trim() || saving}
              onClick={() => void save()}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-40"
            >
              {area ? "Save" : "Create area"}
              <kbd className="font-sans text-[11px] opacity-70">{shortcut("↵")}</kbd>
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}
