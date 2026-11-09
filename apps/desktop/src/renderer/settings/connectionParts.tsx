import type { ReactNode } from "react";

import { anchorOf } from "./search";

// What Settings > Connections' cards share (PLX-1492).

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

/** One of a computer's own settings, in its opened row: its name, a note, and its controls. */
export function ComputerSetting({
  title,
  note,
  children,
}: {
  title: string;
  /** Why it's as it is, or what it's doing now. */
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-1">
      <div className="min-w-[min(10rem,100%)] flex-1">
        <span className="block text-body">{title}</span>
        {note && <span className="block text-meta text-muted-foreground">{note}</span>}
      </div>
      <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
        {children}
      </div>
    </div>
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
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/40 px-4 py-3"
    >
      <div className="min-w-[min(14rem,100%)] flex-1">
        <p className="text-body font-medium">{title}</p>
        <p className="text-meta text-muted-foreground">{body}</p>
      </div>
      {children && <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}
