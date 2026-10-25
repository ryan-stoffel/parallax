import { ArrowLeft } from "./icons";

import type { ReactNode } from "react";

import { useShortcutLabel } from "./keybindings";

/**
 * Tucked over a child thread's composer: whose child it is, `name` opening it (a Project's home, or
 * the parent thread), and Open parent, with its shortcut. A Project child passes its Project's icon.
 */
export function ChildStrip({
  name,
  icon,
  onOpenName,
  onBack,
}: {
  name: string;
  icon?: ReactNode;
  onOpenName: () => void;
  onBack: () => void;
}) {
  const keys = useShortcutLabel("parentThread");
  return (
    <section
      aria-label="Child thread"
      className="flex items-center gap-2.5 py-1 pr-1.5 pl-4 text-body"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        A child thread of{" "}
        <button
          type="button"
          onClick={onOpenName}
          className="rounded-md text-foreground underline decoration-muted-foreground decoration-dotted decoration-2 underline-offset-[6px] hover:decoration-foreground hover:decoration-solid"
        >
          {name}
        </button>
      </span>
      <button
        type="button"
        onClick={onBack}
        title={keys ? `Open parent (${keys})` : "Open parent"}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-body text-muted-foreground hover:bg-hover hover:text-foreground"
      >
        <ArrowLeft aria-hidden className="size-3.5" />
        Open parent
        {keys && <kbd className="font-sans text-caption text-faint-foreground">{keys}</kbd>}
      </button>
    </section>
  );
}
