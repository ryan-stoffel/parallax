import { t } from "i18next";
import { useState } from "react";

import { StateIcon } from "./IssueParts";
import {
  boardColumns,
  boardGroups,
  categoryOf,
  providerNames,
  type BoardColumn,
  type IssueEntry,
} from "./issues";
import { age } from "./Sidebar";
import { TrackerLogo } from "./TrackerLogo";

/** The drag's data type: an issue card, by its issue's URL. */
const issueDragType = "application/x-parallax-issue";

/**
 * The Issues page as a board: a column for each way a state leans (Backlog, To do, In progress,
 * Done), each scrolling on its own, with `entries` as cards in the order given. A card opens its
 * issue, and dragged onto another column asks `onMove` to move it there. A card in `moving`, whose
 * move its tracker hasn't answered, can't be dragged again until it has. The columns keep their
 * width and the board scrolls sideways where the page is narrow.
 */
export function IssueBoard({
  entries,
  moving,
  onOpen,
  onMove,
}: {
  entries: readonly IssueEntry[];
  /** The URLs of the issues with a move in flight. */
  moving: ReadonlySet<string>;
  onOpen: (entry: IssueEntry) => void;
  onMove: (entry: IssueEntry, column: BoardColumn) => void;
}) {
  const groups = boardGroups(entries);
  // The column a dragged card is over.
  const [over, setOver] = useState<BoardColumn>();
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 gap-3 overflow-x-auto px-6 pb-6">
      {boardColumns.map((column) => (
        <section
          key={column.id}
          aria-label={t(column.label)}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(issueDragType)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setOver(column.id);
          }}
          onDragLeave={(e) => {
            // Leaving for a card inside it is still over it.
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setOver((at) => (at === column.id ? undefined : at));
          }}
          onDrop={(e) => {
            e.preventDefault();
            setOver(undefined);
            const url = e.dataTransfer.getData(issueDragType);
            const entry = entries.find((x) => x.issue.url === url);
            if (entry && categoryOf(entry.issue.state.category) !== column.id)
              onMove(entry, column.id);
          }}
          className={`flex min-h-0 min-w-56 flex-1 flex-col rounded-xl transition-colors ${over === column.id ? "bg-selected" : "bg-hover/50"}`}
        >
          <h2 className="flex h-9 shrink-0 items-center gap-2 px-3 text-meta font-medium text-muted-foreground">
            <StateIcon state={{ id: "", name: "", category: column.id }} className="size-3.5" />
            {t(column.label)}
            <span className="font-normal text-faint-foreground tabular-nums">
              {groups[column.id].length}
            </span>
          </h2>
          <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-1.5">
            {groups[column.id].map((entry) => (
              <li key={entry.issue.url} data-issue={entry.issue.url}>
                <IssueCard
                  entry={entry}
                  moving={moving.has(entry.issue.url)}
                  onOpen={() => onOpen(entry)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * One issue on the board, with what its list row shows: its tracker's logo, its key, and how long
 * since it changed; its title on up to three lines; and where it is filed.
 */
function IssueCard({
  entry,
  moving,
  onOpen,
}: {
  entry: IssueEntry;
  moving: boolean;
  onOpen: () => void;
}) {
  const { issue } = entry;
  return (
    <button
      type="button"
      draggable={!moving}
      aria-busy={moving}
      onDragStart={(e) => {
        e.dataTransfer.setData(issueDragType, issue.url);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={onOpen}
      title={`${issue.key} ${issue.title}`}
      className="flex w-full cursor-pointer flex-col gap-1 rounded-lg bg-surface px-3 py-2.5 text-left ring-1 ring-border transition-[background-color,transform] duration-100 ring-inset hover:bg-hover active:scale-[0.985]"
    >
      <span className="flex items-center gap-1.5 text-meta text-faint-foreground">
        <TrackerLogo
          provider={issue.provider}
          aria-hidden={false}
          role="img"
          aria-label={providerNames[issue.provider]}
          className="size-3.5 shrink-0"
        />
        <span className="min-w-0 flex-1 truncate">{issue.key}</span>
        <span className="shrink-0">{age(issue.updatedAt)}</span>
      </span>
      <span className="line-clamp-3 text-body leading-snug wrap-break-word">{issue.title}</span>
      <span className="truncate text-meta text-faint-foreground">{issue.container.name}</span>
    </button>
  );
}
