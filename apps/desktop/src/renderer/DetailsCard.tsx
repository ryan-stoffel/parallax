import { useId, useState, type ReactNode } from "react";

import { icons } from "./icons";
import {
  isCard,
  moveCard,
  toggleCollapsed,
  useThreadDetailsPrefs,
  type ThreadDetailsCardId,
} from "./threadDetailsItems";

/** The shell of one of Thread details' stacked cards. */
export const detailsCard = "rounded-xl border border-border bg-surface";

const DRAG_TYPE = "application/x-parallax-details-card";

/**
 * A card in Thread details under a heading that collapses it, with `summary` at the heading's end
 * for what's worth knowing while it's shut. Dragging the heading onto another card moves it there.
 * Both are kept (threadDetailsItems.ts). `hidden` leaves it mounted, for what it listens for.
 */
export function DetailsCard({
  id,
  title,
  summary,
  hidden,
  children,
}: {
  id: ThreadDetailsCardId;
  title: string;
  summary?: ReactNode;
  hidden?: boolean;
  children: ReactNode;
}) {
  const body = useId();
  const { isCollapsed, position } = useThreadDetailsPrefs();
  const collapsed = isCollapsed(id);
  const [over, setOver] = useState(false);
  return (
    <section
      aria-label={title}
      hidden={hidden}
      style={{ order: position(id) }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const moved = e.dataTransfer.getData(DRAG_TYPE);
        if (isCard(moved)) moveCard(moved, id);
      }}
      className={`${detailsCard} ${over ? "border-ring" : ""}`}
    >
      <button
        type="button"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, id);
          e.dataTransfer.effectAllowed = "move";
        }}
        aria-expanded={!collapsed}
        aria-controls={body}
        onClick={() => toggleCollapsed(id)}
        className="group/heading flex h-8 w-full cursor-grab items-center gap-2 rounded-xl px-3 text-meta text-muted-foreground hover:text-foreground active:cursor-grabbing"
      >
        <span className="shrink-0">{title}</span>
        <span className="ml-auto min-w-0 truncate text-faint-foreground tabular-nums">
          {summary}
        </span>
        <icons.expand
          aria-hidden
          className={`size-3.5! shrink-0 text-faint-foreground transition-transform duration-fast ${collapsed ? "-rotate-90" : ""}`}
        />
      </button>
      <div id={body} hidden={collapsed} className="px-1 pb-1">
        {children}
      </div>
    </section>
  );
}
