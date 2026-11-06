import { ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

/**
 * shadcn/ui's Trace (https://ui.shadcn.com/docs/components/base/trace): a line for each step an
 * agent takes, with an icon, a title, an optional description, and a status. A line that opens
 * sits in a `TraceCollapsible`, a native `<details>` whose open state its caller keeps, as the
 * transcript keeps each row's by key. Its content renders only while open, so a closed tool call
 * doesn't hold its output: render `TraceCollapsibleContent` under `open &&`.
 */
const cx = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(" ");

/** A list of lines, such as the steps a fold opens to. */
export function Trace({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="trace"
      className={cx("flex w-full min-w-0 flex-col gap-2", className)}
      {...props}
    />
  );
}

export type TraceStatus = "running" | "error" | "pending";

/**
 * One line. A running line's title shimmers (index.css), a failed one is red, and a pending one,
 * such as a call that never finished, fades. Say the status in words too, as color isn't read out.
 */
export function TraceLine({
  className,
  status,
  ...props
}: ComponentProps<"span"> & { status?: TraceStatus }) {
  return (
    <span
      data-slot="trace-line"
      data-status={status}
      className={cx(
        "flex min-h-6 w-fit max-w-full min-w-0 items-center gap-2 text-body text-muted-foreground transition-colors in-[summary:hover,button:hover]:text-foreground data-[status=error]:text-danger data-[status=error]:in-[summary:hover,button:hover]:text-danger data-[status=pending]:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

/** A decorative icon: before the title it names the step, after it it's an indicator. */
export function TraceIcon({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden
      className={cx(
        "relative flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [[data-slot=trace-title]~&]:-ml-1",
        className,
      )}
      {...props}
    />
  );
}

/** What the step did, as a sentence on one line. */
export function TraceTitle({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="trace-title" className={cx("min-w-0 truncate", className)} {...props} />;
}

/** Secondary text after the title, such as a count or how a call went. */
export function TraceDescription({ children }: { children: ReactNode }) {
  return (
    <span
      data-slot="trace-description"
      className="shrink-0 text-faint-foreground tabular-nums in-data-[status=error]:text-danger"
    >
      {children}
    </span>
  );
}

/** A line that opens, its open state kept by the caller. */
export function TraceCollapsible({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details
      data-slot="trace-collapsible"
      open={open}
      onToggle={(e) => e.currentTarget.open !== open && onOpenChange(e.currentTarget.open)}
      className="flex w-full min-w-0 flex-col"
    >
      {children}
    </details>
  );
}

/** The line's button: put a `TraceLine` in it. It adds a chevron after the line. */
export function TraceCollapsibleTrigger({ children }: { children: ReactNode }) {
  return (
    <summary
      data-slot="trace-collapsible-trigger"
      className="flex w-fit max-w-full min-w-0 list-none items-center gap-1 rounded-md text-left text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden"
    >
      {children}
      {/* Its own row's open state only, not an open fold's around it. */}
      <TraceIcon className="text-faint-foreground transition-transform motion-reduce:transition-none [details[open]>summary>&]:rotate-90">
        <ChevronRight className="size-3.5" />
      </TraceIcon>
    </summary>
  );
}

/** What an open line shows, indented under it behind a rule. */
export function TraceCollapsibleContent({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="trace-collapsible-content"
      className="mt-2 mb-1 ml-[7px] min-w-0 border-l border-border pr-1 pl-4 leading-relaxed wrap-break-word text-muted-foreground"
    >
      {children}
    </div>
  );
}
