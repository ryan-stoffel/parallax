import { t } from "i18next";
import { Fragment, type KeyboardEvent, type ReactNode } from "react";

import type { Host } from "../hosts";
import { Picker } from "../ui";
import { anchorOf } from "./search";

// What every Settings page is built from.

/** The host picker's choice for every computer at once, which no host's id can be. */
export const allHosts = "#all";

export const settingRow =
  "flex min-h-14 items-center justify-between gap-6 border-border/40 px-4 py-3 not-last:border-b";
export const quietButton =
  "rounded-md px-2.5 py-1 text-body text-muted-foreground hover:bg-hover hover:text-foreground";
export const primaryButton =
  "rounded-md bg-primary px-3 py-1 text-body font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50";
export const dangerButton =
  "rounded-md bg-red-600 px-2.5 py-1 text-body font-medium text-white enabled:hover:opacity-90 disabled:opacity-50";
export const field =
  "mt-1 block w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-body placeholder:text-faint-foreground";
/** A secondary action on a row: quiet, with a border so it reads as a button. */
export const outlineButton =
  "flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-body text-foreground enabled:hover:bg-hover disabled:opacity-50 [&_svg]:size-3.5";
/** A field on a row's right, sized to sit beside its title. */
export const rowField =
  "w-56 rounded-md border border-border bg-background px-2.5 py-1 text-body placeholder:text-faint-foreground";

/** A page's title, and what the page is for under it. `action` sits at the end of its line. */
export function PageTitle({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-8">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h1 className="text-heading font-semibold">{title}</h1>
        {action}
      </div>
      {children && <p className="mt-1 max-w-2xl text-body text-muted-foreground">{children}</p>}
    </header>
  );
}

/** A titled card of settings rows. `icon` leads its title, and `action` ends the title's line. */
export function Section({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} data-setting={anchorOf(title)} className="mb-10 scroll-mt-6">
      <div className="mb-3 flex min-h-7 items-center justify-between gap-4">
        <h2 className="flex items-center gap-2 text-reading font-semibold [&_svg]:size-4 [&_svg]:shrink-0">
          {icon}
          {title}
        </h2>
        {action}
      </div>
      <div className="rounded-xl border border-border/50 bg-(--pane-card)">{children}</div>
    </section>
  );
}

/**
 * A setting: its title and what it does on the left, its control on the right. A text title is
 * its `data-setting`, which Settings' search scrolls to.
 */
export function Row({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      data-setting={typeof title === "string" ? anchorOf(title) : undefined}
      className={settingRow}
    >
      <div className="min-w-0">
        <span className="block text-body font-medium">{title}</span>
        {description && (
          <span className="mt-0.5 block text-meta text-muted-foreground">{description}</span>
        )}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/**
 * A page that fills Settings: `bar` across the top, `list` on the left, and the chosen item's
 * `children` on the right. The list and the pane each scroll. Stacked until there's room beside it.
 */
export function ListPane({
  bar,
  list,
  children,
}: {
  bar?: ReactNode;
  list: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="@container flex h-full min-h-0 flex-col">
      {bar && (
        <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-5 pt-3 pb-2">
          {bar}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto @3xl:flex-row @3xl:overflow-hidden">
        <div className="flex shrink-0 flex-col border-b border-border/50 @3xl:w-72 @3xl:overflow-y-auto @3xl:border-r @3xl:border-b-0">
          {list}
        </div>
        <div className="min-w-0 flex-1 @3xl:overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

/** A list's heading in `ListPane`, with its `action` at the end of the line. */
export function ListHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-2 px-4 pt-3 pb-1 text-meta font-medium text-faint-foreground">
      {children}
      {action}
    </div>
  );
}

/** One item of a `ListPane`'s list, as a button that chooses it. */
export function ListItem({
  chosen,
  onClick,
  id,
  controls,
  icon,
  title,
  detail,
  off,
}: {
  chosen: boolean;
  onClick: () => void;
  id?: string;
  /** The pane it shows, for a list whose panes stay mounted. */
  controls?: string;
  icon?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  off?: boolean;
}) {
  return (
    <button
      id={id}
      type="button"
      role="tab"
      aria-selected={chosen}
      aria-controls={controls}
      tabIndex={chosen ? 0 : -1}
      onClick={onClick}
      className={`mx-2 flex w-[calc(100%-1rem)] items-start gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-hover aria-selected:bg-selected ${off ? "opacity-60" : ""}`}
    >
      {icon && <span className="mt-0.5 shrink-0 [&_svg]:size-4">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium">{title}</span>
        {detail && <span className="mt-0.5 block text-meta text-muted-foreground">{detail}</span>}
      </span>
    </button>
  );
}

/** Up and Down move between a tablist's tabs, wrapping at the ends, and choose the one they reach. */
export function moveTab(e: KeyboardEvent<HTMLElement>) {
  const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
  const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  const i = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
  if (!step || i === -1) return;
  e.preventDefault();
  const next = tabs[(i + step + tabs.length) % tabs.length]!;
  next.click();
  next.focus();
}

/** The app's switch, now in ui (0092); Settings' pages still import it from here. */
export { Switch } from "../ui";

/** A dot for a state: on, off, needing the user, or failing. */
export function StatusDot({ tone }: { tone: "on" | "off" | "warn" | "error" }) {
  const color = {
    on: "bg-added",
    off: "bg-faint-foreground",
    warn: "bg-warning",
    error: "bg-danger",
  }[tone];
  return <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${color}`} />;
}

/** A mark `t` leaves where `name`'s control goes, for `withNodes`. */
const mark = (name: string) => `\u0001${name}\u0001`;

/** A translated sentence with each `mark` in it replaced by its node, so a control can sit in it. */
const withNodes = (text: string, nodes: Record<string, ReactNode>) =>
  text
    .split("\u0001")
    .map((part, i) => (i % 2 ? <Fragment key={i}>{nodes[part]}</Fragment> : part));

/**
 * "on <host>", a select of `hosts`, shown only when there's more than one, or with `always`, as
 * the host's name alone.
 */
export function HostPicker({
  hosts,
  value,
  onChange,
  always,
  all,
  scope,
}: {
  hosts: Host[];
  value: string;
  onChange: (id: string) => void;
  always?: boolean;
  /** Offers `allHosts`, All computers, first. */
  all?: boolean;
  /** What on the host the settings are for, as a menu, read before the host. */
  scope?: ReactNode;
}) {
  const sentence = (computer: ReactNode) =>
    withNodes(
      scope
        ? t("Applying settings for {{scope}} on {{computer}}", {
            scope: mark("scope"),
            computer: mark("computer"),
          })
        : t("Applying settings on {{computer}}", { computer: mark("computer") }),
      { scope, computer },
    );
  if (hosts.length < 2)
    return always ? (
      <div className="flex flex-wrap items-center gap-1.5 text-reading text-muted-foreground">
        {sentence(<span className="font-medium text-foreground">{hosts[0]?.name}</span>)}
      </div>
    ) : null;
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-reading text-muted-foreground">
      {sentence(
        <Picker
          field
          label={t("Computer")}
          value={value}
          onChange={onChange}
          options={[
            ...(all ? [{ value: allHosts, label: t("All computers") }] : []),
            ...hosts.map((h) => ({ value: h.id, label: h.name })),
          ]}
          className="max-w-56"
          panelClassName="min-w-48"
        />,
      )}
    </span>
  );
}

/** Which of `hosts` a picker's `value` means: all of them for `allHosts`. */
export const hostsOf = (hosts: Host[], value: string) =>
  value === allHosts ? hosts : hosts.filter((h) => h.id === value);

/**
 * Remove, or `label`, and Cancel, for a removal that asks first in place. Cancel takes focus, so a
 * double click or a second Enter can't remove.
 */
export function ConfirmRemove({
  label = t("Remove"),
  disabled,
  onRemove,
  onCancel,
}: {
  label?: string;
  disabled?: boolean;
  onRemove: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <button type="button" disabled={disabled} onClick={onRemove} className={dangerButton}>
        {label}
      </button>
      <button type="button" autoFocus onClick={onCancel} className={quietButton}>
        {t("Cancel")}
      </button>
    </>
  );
}

/** 1536 → "1.5 KB": a size in bytes for people. */
export function formatBytes(bytes: number): string {
  const units = ["", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0
    ? t("{{count}} bytes", { count: n })
    : `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** A name to edit in place: Enter or Save calls `onSave`, and Escape or Cancel `onCancel`. */
export function RenameForm({
  label,
  value,
  onSave,
  onCancel,
}: {
  label: string;
  value: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(new FormData(e.currentTarget).get("name") as string);
      }}
    >
      <input
        name="name"
        aria-label={label}
        defaultValue={value}
        autoFocus
        maxLength={64}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // Not Settings' too.
          e.preventDefault();
          onCancel();
        }}
        className="w-48 rounded-md border border-border bg-background px-2 py-0.5 text-body text-foreground"
      />
      <button type="submit" className={primaryButton}>
        {t("Save")}
      </button>
      <button type="button" className={quietButton} onClick={onCancel}>
        {t("Cancel")}
      </button>
    </form>
  );
}
