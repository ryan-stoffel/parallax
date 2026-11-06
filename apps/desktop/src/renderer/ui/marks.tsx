import type { ReactNode } from "react";

import { icons } from "../icons";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const badgeTones: Record<BadgeTone, string> = {
  neutral: "bg-selected text-muted-foreground",
  accent: "bg-accent/12 text-accent",
  success: "bg-added/12 text-added",
  warning: "bg-warning/12 text-warning",
  danger: "bg-danger/12 text-danger",
};

const badgeShapes = {
  chip: "h-5 rounded-md px-1.5 text-meta",
  pill: "h-5 rounded-full px-2 text-meta",
  count: "h-4 min-w-4 justify-center rounded-full px-1 text-micro tabular-nums",
};

/**
 * A short label on a fill of its tone: a chip for a state or a kind ("Draft", "SSH"), a pill for a
 * tag, and a count for a number on a tab or an icon. `tone` defaults to neutral.
 */
export function Badge({
  shape = "chip",
  tone = "neutral",
  className = "",
  children,
}: {
  shape?: keyof typeof badgeShapes;
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 font-medium whitespace-nowrap [&_svg]:size-3 ${badgeShapes[shape]} ${badgeTones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export type DotTone = "on" | "off" | "working" | "warn" | "error";

const dotTones: Record<DotTone, string> = {
  on: "bg-added",
  off: "bg-faint-foreground",
  working: "bg-working",
  warn: "bg-warning",
  error: "bg-danger",
};

/**
 * A 6px dot for a state: on, off, working, needing the user, or failing. `pulse` for a state that
 * hasn't settled, such as connecting. Hidden from screen readers unless given a `label`, so the
 * text beside it says the state.
 */
export function StatusDot({
  tone,
  pulse,
  label,
}: {
  tone: DotTone;
  pulse?: boolean;
  label?: string;
}) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={`size-1.5 shrink-0 rounded-full ${dotTones[tone]} ${pulse ? "animate-pulse" : ""}`}
    />
  );
}

const spinnerSizes = { sm: "size-3.5", md: "size-4", lg: "size-5" };

/**
 * Work under way, a turning ring: sm (14px) beside text, md (16px) in a control, lg (20px) on its
 * own. It stands still under reduced motion.
 */
export function Spinner({
  size = "sm",
  label,
  className = "",
}: {
  size?: keyof typeof spinnerSizes;
  /** Says what's loading, for screen readers; without one it's hidden from them. */
  label?: string;
  className?: string;
}) {
  return (
    <icons.loading
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={`shrink-0 animate-spin text-muted-foreground ${spinnerSizes[size]} ${className}`}
    />
  );
}

/**
 * A thin bar filling to `value` percent, easing to each new value. Without a `value` it pulses, for
 * work whose end isn't known.
 */
export function ProgressBar({
  value,
  label,
  className = "",
}: {
  value?: number;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      className={`h-1 overflow-hidden rounded-full bg-hover ${className}`}
    >
      <div
        className={`h-full rounded-full bg-accent transition-[width] duration-slow ${value === undefined ? "w-1/4 animate-pulse" : ""}`}
        style={value === undefined ? undefined : { width: `${Math.min(Math.max(value, 0), 100)}%` }}
      />
    </div>
  );
}

/** A key or a shortcut, as "⌘K" or "Esc", in a small key cap. */
export function Kbd({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <kbd
      className={`shrink-0 rounded-sm border border-border bg-surface px-1 font-sans text-caption leading-4 text-muted-foreground ${className}`}
    >
      {children}
    </kbd>
  );
}

/**
 * What a list or a page shows with nothing in it: a 24px icon, a title, a line saying why or what
 * to do, and an optional action (a `Button`). Centered in its space, with no box around it.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  className = "",
}: {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center px-6 py-10 text-center [&>svg]:mb-3 [&>svg]:size-6 [&>svg]:text-faint-foreground ${className}`}
    >
      {icon}
      <p className="text-body font-medium text-foreground">{title}</p>
      {body && <p className="mt-1 max-w-80 text-meta text-muted-foreground">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * A small heading over a group in a list, such as a sidebar section or a day in a history, with
 * an optional `action` (an `IconButton`) at its end.
 */
export function GroupHeading({
  action,
  className = "",
  children,
}: {
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex h-7 items-center gap-2 px-2 ${className}`}>
      <h3 className="min-w-0 flex-1 truncate text-meta font-medium text-faint-foreground">
        {children}
      </h3>
      {action}
    </div>
  );
}
