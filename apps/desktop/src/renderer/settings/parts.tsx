import type { ReactNode } from "react";

import type { Host } from "../hosts";

// What every Settings page is built from.

export const settingRow =
  "flex items-center justify-between gap-4 border-border px-4 py-3 not-last:border-b";
export const quietButton =
  "rounded-md px-2.5 py-1 text-[12.5px] text-muted-foreground hover:bg-hover hover:text-foreground";
export const primaryButton =
  "rounded-md bg-primary px-3 py-1 text-[12.5px] font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50";
export const dangerButton =
  "rounded-md bg-red-600 px-2.5 py-1 text-[12.5px] font-medium text-white enabled:hover:opacity-90 disabled:opacity-50";
export const field =
  "mt-1 block w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] placeholder:text-faint-foreground";
/** A field on a row's right, sized to sit beside its title. */
export const rowField =
  "w-56 rounded-md border border-border bg-background px-2.5 py-1 text-[13px] placeholder:text-faint-foreground";

/** A page's title, and what the page is for under it. */
export function PageTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <>
      <h1 className={`text-xl font-semibold ${children ? "mb-1.5" : "mb-6"}`}>{title}</h1>
      {children && <p className="mb-6 text-[13px] text-muted-foreground">{children}</p>}
    </>
  );
}

/** A titled card of settings rows. `action` sits at the end of the title's line. */
export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="mb-8">
      <div className="mb-2 flex min-h-7 items-center justify-between gap-4">
        <h2 className="text-[12.5px] font-medium text-muted-foreground">{title}</h2>
        {action}
      </div>
      <div className="rounded-xl border border-border bg-surface">{children}</div>
    </section>
  );
}

/** A setting: its title and what it does on the left, its control on the right. */
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
    <div className={settingRow}>
      <div className="min-w-0">
        <span className="block text-[13px] font-medium">{title}</span>
        {description && (
          <span className="block text-[12.5px] text-muted-foreground">{description}</span>
        )}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/** An on/off switch named `label`. */
export function Switch({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        // A switch inside a clickable row toggles only itself.
        e.stopPropagation();
        onChange(!checked);
      }}
      className="relative h-5 w-9 shrink-0 rounded-full bg-faint-foreground transition-colors outline-offset-2 aria-checked:bg-accent disabled:opacity-50"
    >
      <span
        aria-hidden
        className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : ""}`}
      />
    </button>
  );
}

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

/**
 * "on <host>", a select of `hosts`, shown only when there's more than one, or with `always`, as
 * the host's name alone.
 */
export function HostPicker({
  hosts,
  value,
  onChange,
  always,
}: {
  hosts: Host[];
  value: string;
  onChange: (id: string) => void;
  always?: boolean;
}) {
  if (hosts.length < 2)
    return always ? (
      <p className="text-[15px] text-muted-foreground">
        Applying settings on <span className="font-medium text-foreground">{hosts[0]?.name}</span>
      </p>
    ) : null;
  return (
    <label className="flex items-center gap-1.5 text-[15px] text-muted-foreground">
      Applying settings on
      <select
        aria-label="Host"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md bg-transparent py-0.5 pr-1 font-medium text-foreground hover:bg-hover"
      >
        {hosts.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 1536 → "1.5 KB": a size in bytes for people. */
export function formatBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? `${n} ${units[0]}` : `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
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
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        className="w-48 rounded-md border border-border bg-background px-2 py-0.5 text-[13px] text-foreground"
      />
      <button type="submit" className={primaryButton}>
        Save
      </button>
      <button type="button" className={quietButton} onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
