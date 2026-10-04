import { ArrowLeft } from "lucide-react";

import type { Project } from "../protocol/generated/protocol";
import { useShortcutLabel } from "./keybindings";
import { ProjectIcon } from "./Sidebar";

/**
 * Tucked over a child thread's composer, as the plan is: which Project it belongs to, and the way
 * back to that Project's coordinator, with its shortcut.
 */
export function ChildStrip({ project, onBack }: { project: Project; onBack: () => void }) {
  const keys = useShortcutLabel("parentThread");
  return (
    <section
      aria-label="Child thread"
      className="mx-5 -mb-4 flex items-center gap-2.5 rounded-t-3xl border border-b-0 border-border bg-surface py-1.5 pr-1.5 pb-5.5 pl-4 text-[13px]"
    >
      <ProjectIcon icon={project.icon} className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        A child thread of <span className="text-foreground">{project.name}</span>, started by its
        coordinator
      </span>
      <button
        type="button"
        onClick={onBack}
        title={keys ? `Back to the coordinator (${keys})` : "Back to the coordinator"}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] text-muted-foreground hover:bg-hover hover:text-foreground"
      >
        <ArrowLeft aria-hidden className="size-3.5" />
        Coordinator
        {keys && <kbd className="font-sans text-[11px] text-faint-foreground">{keys}</kbd>}
      </button>
    </section>
  );
}
