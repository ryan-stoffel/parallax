import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode, type Ref } from "react";

import { anchorOf } from "./search";

// What Settings' two Connections pages, Computers and Sharing & access, share (PLX-1492).

/** A card as Settings draws one. */
export const card = "rounded-xl border border-border/50 bg-(--pane-card)";

/** A small label after a computer's name, as Settings draws one. */
export const badge = "shrink-0 rounded-sm bg-hover px-1.5 py-px text-caption font-normal";

/**
 * A setting as `Row` draws one, with `status` under its description. Its controls go under its text
 * when the card is too narrow for both, so neither is squeezed. `title` is its `data-setting`, which
 * Settings' search scrolls to.
 */
export function AccessRow({
  title,
  anchor = anchorOf(title),
  description,
  status,
  children,
}: {
  title: string;
  /** Its `data-setting`, when another setting on the page has its title. */
  anchor?: string;
  description?: ReactNode;
  /** What it's doing now, or what went wrong. */
  status?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      data-setting={anchor}
      className="flex min-h-14 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-border/40 px-4 py-3 not-last:border-b"
    >
      <div className="min-w-[min(14rem,100%)] flex-1">
        <span className="block text-body font-medium">{title}</span>
        {description && (
          <span className="mt-0.5 block text-meta text-muted-foreground">{description}</span>
        )}
        {status}
      </div>
      {children && (
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * A card that opens and closes under its own heading: a chevron and `title`, then `summary`, what it
 * holds in a few words, and `action`, its controls, at the end of the line. Open at first. `open`
 * holds it open while something inside needs to be seen. `title` is its `data-setting`.
 */
export function CollapsibleCard({
  ref,
  title,
  summary,
  action,
  open: held,
  children,
}: {
  ref?: Ref<HTMLElement>;
  title: string;
  summary?: ReactNode;
  action?: ReactNode;
  open?: boolean;
  children: ReactNode;
}) {
  const [chosen, setChosen] = useState(true);
  const open = held || chosen;
  const bodyId = useId();
  return (
    <section
      ref={ref}
      aria-label={title}
      data-setting={anchorOf(title)}
      className={`mb-10 scroll-mt-6 ${card}`}
    >
      <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <h2 className="shrink-0 text-reading font-semibold">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? bodyId : undefined}
            onClick={() => setChosen(!open)}
            className="-ml-1 flex items-center gap-2 rounded-md py-0.5 pr-1.5 pl-1 hover:bg-hover"
          >
            <ChevronDown
              aria-hidden
              className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${open ? "" : "-rotate-90"}`}
            />
            {title}
          </button>
        </h2>
        {summary && (
          <span className="min-w-[min(8rem,100%)] flex-1 text-meta text-muted-foreground">
            {summary}
          </span>
        )}
        {action && (
          <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
            {action}
          </div>
        )}
      </div>
      {open && (
        <div id={bodyId} className="border-t border-border/40">
          {children}
        </div>
      )}
    </section>
  );
}

/** What's wrong, at the top of a card, with what to do about it in `children`. */
export function NoticeRow({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-border/40 px-4 py-3 not-last:border-b"
    >
      <div className="min-w-[min(14rem,100%)] flex-1">
        <p className="text-body font-medium">{title}</p>
        <p className="text-meta text-muted-foreground">{body}</p>
      </div>
      {children && <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}
