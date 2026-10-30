import { useId, type ComponentProps, type ReactNode, type Ref } from "react";

import { Button } from "./controls";

export type DialogWidth = "sm" | "md" | "lg" | "xl";

const widths: Record<DialogWidth, string> = {
  sm: "w-[24rem]",
  md: "w-[28rem]",
  lg: "w-[36rem]",
  xl: "w-[44rem]",
};

/**
 * A modal's shell, a native `<dialog>`: open it with `ref.current.showModal()`, and close it with
 * `close()`, Escape, or a `<form method="dialog">` inside. sm (24rem) asks a question, md (28rem)
 * holds a short form, lg (36rem) a longer one, and xl (44rem) a list or a preview. `placement`
 * "top" sets it 14% down the window, for a palette whose height changes as it filters. It fades
 * and scales in and out (index.css). `className` adds to its classes.
 */
export function Dialog({
  width = "md",
  placement = "center",
  className = "",
  ...props
}: { width?: DialogWidth; placement?: "center" | "top" } & ComponentProps<"dialog">) {
  return (
    <dialog
      className={`${placement === "top" ? "mx-auto mt-[14vh]" : "m-auto"} ${widths[width]} max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface p-0 text-foreground shadow-composer backdrop:bg-black/50 ${className}`}
      {...props}
    />
  );
}

/**
 * A modal asking to confirm `action`, such as deleting a thread. Cancel closes it, and the red
 * button runs `onConfirm`. While `busy`, that button is disabled and reads `busy`, as "Deleting…".
 * `alternate` adds a plain button before it, for a second way to go ahead.
 */
export function ConfirmDialog({
  ref,
  title,
  titleClass = "",
  action,
  busy,
  error,
  onConfirm,
  alternate,
  children,
}: {
  ref: Ref<HTMLDialogElement>;
  title: ReactNode;
  titleClass?: string;
  action: string;
  busy?: string;
  error?: string;
  onConfirm: () => void;
  /** A second way to go ahead, as a plain button before `action`'s. */
  alternate?: { action: string; onConfirm: () => void };
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <Dialog ref={ref} width={alternate ? "md" : "sm"} aria-labelledby={titleId}>
      <form method="dialog" className="px-5 pt-4 pb-4">
        <h2 id={titleId} className={`text-reading font-semibold ${titleClass}`}>
          {title}
        </h2>
        <p className="mt-1.5 text-body text-muted-foreground">{children}</p>
        {error && (
          <p role="alert" className="mt-2 text-body text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="submit" value="cancel">
            Cancel
          </Button>
          {alternate && (
            <Button variant="outline" disabled={!!busy} onClick={alternate.onConfirm}>
              {alternate.action}
            </Button>
          )}
          <Button variant="danger" disabled={!!busy} onClick={onConfirm}>
            {busy || action}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
