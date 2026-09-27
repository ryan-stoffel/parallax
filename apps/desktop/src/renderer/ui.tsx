import { ChevronDown, ChevronRight } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

/** A Mod shortcut as the OS writes it: "Alt+B" is "⌘⌥B" on macOS, "Ctrl+Alt+B" elsewhere. */
export const shortcut = (keys: string) =>
  window.wisp.platform === "darwin" ? `⌘${keys.replace("Alt+", "⌥")}` : `Ctrl+${keys}`;

/** A square, icon-only toolbar button. `label` is its accessible name and tooltip. */
export function IconButton({
  label,
  keys,
  children,
  ...props
}: { label: string; keys?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={keys ? `${label} (${shortcut(keys)})` : label}
      className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4"
      {...props}
    >
      {children}
    </button>
  );
}

/** A quiet inline native <select>, sized to its value, with an optional leading icon. */
export function Picker({
  label,
  icon,
  children,
  ...props
}: { label: string; icon?: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className="relative flex items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground">
      <span className="sr-only">{label}</span>
      {icon && <span className="pointer-events-none absolute left-2 [&_svg]:size-3.5">{icon}</span>}
      <select
        className={`field-sizing-content appearance-none rounded-md bg-transparent py-1 pr-6 text-[12.5px] ${icon ? "pl-7" : "pl-2"}`}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 size-3.5 opacity-70" />
    </label>
  );
}

/** Where the user is: host, workspace, then the current page. */
export function Breadcrumb({ items }: { items: string[] }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 text-[13px]">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i} className={`flex min-w-0 items-center gap-1 ${last ? "" : "shrink-0"}`}>
              {i > 0 && (
                <ChevronRight aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
              )}
              <span
                aria-current={last ? "page" : undefined}
                className={`truncate ${last ? "font-medium text-foreground" : "text-muted-foreground"}`}
              >
                {item}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The 52px top row of a pane. On macOS it is also the window's title bar. */
export function TopBar({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`titlebar flex h-13 shrink-0 items-center gap-2 px-3 ${className}`}>
      {children}
    </div>
  );
}
