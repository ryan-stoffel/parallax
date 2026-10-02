import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";

/** One of the user's prompts in a transcript: its row, what it says, and how the agent replied. */
export interface Prompt {
  /** Its row's index in the transcript's list. */
  index: number;
  text: string;
  /** The start of the agent's last reply to it, as plain text. */
  reply?: string;
}

/** Text for one line of a card: Markdown's marks, links, and list markers left out. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:[-*+]|\d+\.|#+|>)\s+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A bar for each of the user's prompts, down the transcript's left edge. While the rail is hovered
 * or has keyboard focus, the one being read is longer and brighter. Hovering or focusing a bar
 * shows its prompt and the start of the reply beside it, and clicking it scrolls back to that
 * prompt.
 */
export function PromptRail({
  prompts,
  current,
  onJump,
}: {
  prompts: readonly Prompt[];
  /** The position in `prompts` of the one being read. */
  current: number;
  onJump: (prompt: Prompt) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  // The bar whose card shows, and the card's middle, from the rail's top.
  const [shown, setShown] = useState<{ at: number; middle: number }>();
  const show = (at: number, bar: HTMLElement) => {
    const top = rail.current?.getBoundingClientRect().top ?? 0;
    const box = bar.getBoundingClientRect();
    setShown({ at, middle: box.top - top + box.height / 2 });
  };
  const prompt = shown && prompts[shown.at];
  return (
    <div
      ref={rail}
      onMouseLeave={() => setShown(undefined)}
      className="group/rail absolute top-1/2 left-1 z-10 flex max-h-[70%] -translate-y-1/2"
    >
      <nav
        aria-label="Prompts"
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setShown(undefined)}
        onScroll={() => setShown(undefined)}
        className="flex flex-col overflow-y-auto [scrollbar-width:none]"
      >
        {prompts.map((p, at) => (
          <button
            key={p.index}
            type="button"
            aria-label={`Go to prompt ${at + 1}: ${p.text}`}
            aria-current={at === current ? "true" : undefined}
            onMouseEnter={(e) => show(at, e.currentTarget)}
            onFocus={(e) => show(at, e.currentTarget)}
            onClick={() => onJump(p)}
            className="group flex h-2.5 w-5 shrink-0 cursor-default items-center px-0.5 focus-visible:outline-none"
          >
            <span
              className={`h-0.5 rounded-full transition-[width,background-color] group-hover:w-4 group-hover:bg-foreground group-focus-visible:w-4 group-focus-visible:bg-foreground ${
                at === current
                  ? "w-2.5 bg-faint-foreground/60 group-has-[:focus-visible]/rail:w-4 group-has-[:focus-visible]/rail:bg-foreground group-hover/rail:w-4 group-hover/rail:bg-foreground"
                  : "w-2.5 bg-faint-foreground/60"
              }`}
            />
          </button>
        ))}
      </nav>
      {prompt && (
        <div
          aria-hidden
          style={{ top: shown.middle }}
          className="pointer-events-none absolute left-full ml-2 w-80 -translate-y-1/2 rounded-xl border border-border bg-surface px-4 py-3 shadow-composer"
        >
          <p className="line-clamp-3 text-[14px] break-words text-foreground">{prompt.text}</p>
          {prompt.reply && (
            <p className="mt-1 line-clamp-3 text-[13px] leading-relaxed break-words text-muted-foreground">
              {prompt.reply}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** "Scroll to end", over the bottom of a transcript scrolled up from it. */
export function ScrollToEnd({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface py-1.5 pr-3.5 pl-2.5 text-[13px] text-muted-foreground shadow-composer hover:text-foreground [&_svg]:size-4"
    >
      <ChevronDown aria-hidden />
      Scroll to end
    </button>
  );
}
