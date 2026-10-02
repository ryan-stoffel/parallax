import { Check, ChevronDown, Search } from "lucide-react";
import {
  Fragment,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type ToggleEvent,
} from "react";

/** A Mod shortcut as the OS writes it: "Alt+B" is "⌘⌥B" on macOS, "Ctrl+Alt+B" elsewhere. */
export const shortcut = (keys: string) =>
  window.parallax.platform === "darwin" ? `⌘${keys.replace("Alt+", "⌥")}` : `Ctrl+${keys}`;

/**
 * A square, icon-only toolbar button. `label` is its accessible name and tooltip; `aria-pressed`
 * shows it on.
 */
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
      className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground aria-pressed:bg-selected aria-pressed:text-foreground [&_svg]:size-4"
      {...props}
    >
      {children}
    </button>
  );
}

/** A segmented control's option: a label around a visually hidden radio. */
export const segment =
  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] text-muted-foreground hover:text-foreground has-checked:bg-selected has-checked:text-foreground has-focus-visible:outline-2 has-focus-visible:outline-ring [&_svg]:size-3.5";

/**
 * A row of radios drawn as one segmented control, named by `label`. Disabled, it stays in place
 * but can't be changed.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: { value: T; name: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset
      aria-label={label}
      disabled={disabled}
      className="flex shrink-0 gap-0.5 rounded-lg border border-border p-0.5 disabled:pointer-events-none disabled:opacity-50"
    >
      {options.map((o) => (
        <label key={o.value} className={segment}>
          <input
            type="radio"
            name={label}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            className="sr-only"
          />
          {o.name}
        </label>
      ))}
    </fieldset>
  );
}

// Every dropdown shares these: a quiet trigger, and a panel 8px under it with the same radius.
/** A menu's trigger: sized to its content, highlighted on hover. */
export const menuButton =
  "flex items-center gap-1.5 rounded-lg py-1 pr-1.5 pl-2 text-[13.5px] text-muted-foreground enabled:hover:bg-hover enabled:hover:text-foreground disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0";

const panelAreas = {
  start: "[position-area:bottom_span-right]",
  end: "[position-area:bottom_span-left]",
  center: "[position-area:bottom]",
};

/**
 * A menu's panel, a native popover: under its trigger and lined up with its left edge (`end`:
 * its right edge; `center`: centered under it), flipping when there's no room. Escape and
 * clicking away close it.
 */
export const menuPanel = (align: "start" | "end" | "center" = "start") =>
  `inset-auto m-0 mt-2 rounded-lg border border-border bg-surface text-foreground shadow-composer [position-try-fallbacks:flip-block,flip-inline] ${panelAreas[align]}`;

/** A row in a menu panel. */
export const menuItem =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover [&_svg]:size-3.5 [&_svg]:shrink-0";

/**
 * Opens a menu on a right-click by clicking its trigger. Where the right-click arrives while a
 * button is still down (a right-click on macOS and Linux, Control-click on macOS), the menu opens
 * on its release, which would otherwise close it again as a click outside a popover. A release the
 * window never sees, as when the button is held while switching apps, opens nothing: the window's
 * blur, a cancelled pointer, or the next press ends the wait.
 */
export function openOnContextMenu(e: MouseEvent<HTMLElement>, trigger: HTMLElement | null) {
  e.preventDefault();
  if (e.buttons === 0) return trigger?.click();
  const wait = new AbortController();
  const { signal } = wait;
  window.addEventListener(
    "pointerup",
    () => {
      wait.abort();
      trigger?.click();
    },
    { signal },
  );
  for (const type of ["blur", "pointercancel", "pointerdown"])
    window.addEventListener(type, () => wait.abort(), { signal });
}

/** Up and Down move focus between a menu's items, wrapping at the ends and passing disabled ones. */
export function moveFocus(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const items = [
    ...e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)'),
  ];
  const step = e.key === "ArrowDown" ? 1 : -1;
  const i = items.indexOf(document.activeElement as HTMLElement);
  // From outside the items (a search box), Down starts at the top and Up at the bottom.
  items.at(i === -1 ? (step === 1 ? 0 : -1) : (i + step) % items.length)?.focus();
}

export interface PickerOption {
  value: string;
  label: string;
  icon?: ReactNode;
  /** A line under the label. */
  description?: string;
  /** A quiet note at the row's end, such as "current". */
  hint?: string;
  /** Draws a line above this option, to set it apart. */
  divider?: boolean;
}

/**
 * One choice in a menu: icon, label, and an optional description and hint, checked when chosen.
 * A `disabled` one can't be picked, and its hint should say why.
 */
export function MenuOption({
  option: o,
  checked,
  disabled,
  onClick,
}: {
  option: PickerOption;
  checked: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
      className={`${menuItem} ${o.description ? "items-start py-2" : ""} disabled:opacity-50 disabled:hover:bg-transparent`}
    >
      {/* One line tall, so a two-line row's icon sits beside its label. */}
      {o.icon && <span className="grid h-5 place-items-center">{o.icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate leading-5">{o.label}</span>
        {o.description && (
          <span className="mt-0.5 block text-[12px] leading-snug text-faint-foreground">
            {o.description}
          </span>
        )}
      </span>
      {o.hint && (
        <span className="shrink-0 text-[11.5px] leading-5 text-faint-foreground">{o.hint}</span>
      )}
      {/* Always takes its room, so choosing never rewraps a row or resizes the menu. */}
      <span className={`grid h-5 place-items-center ${checked ? "" : "invisible"}`}>
        <Check aria-hidden className="text-accent" />
      </span>
    </button>
  );
}

/** A small heading over a group of a menu's options. */
export const menuHeading = "px-2 pt-1.5 pb-1 text-[11.5px] font-medium text-faint-foreground";

/** The badge on a choice that can't be picked yet, saying why, such as "Not available yet". */
export const unavailableBadge =
  "shrink-0 rounded-md border border-amber-500/30 px-2 py-0.5 text-[12px] text-amber-500";

/**
 * A dropdown showing the chosen option, with a check beside it in the menu. The chosen option's
 * icon leads, else `icon`. Pass `value` to control it, or leave it to keep its own choice,
 * starting at `defaultValue`. `search` adds a filter box with that placeholder. Other buttons
 * can open the same menu with `popoverTarget={id}`; it anchors to whichever opened it, and
 * `button={false}` leaves them as its only way in.
 */
export function Picker({
  id,
  label,
  icon,
  options,
  value,
  defaultValue,
  onChange,
  align,
  search,
  panelClassName = "min-w-44",
  button = true,
}: {
  id?: string;
  button?: boolean;
  label: string;
  icon?: ReactNode;
  options: PickerOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  align?: "start" | "end";
  search?: string;
  panelClassName?: string;
}) {
  const ownId = useId();
  const menuId = id ?? ownId;
  const menu = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const [own, setOwn] = useState(defaultValue);
  const [query, setQuery] = useState("");
  // Uncontrolled, it shows the first option until one is picked, even if options arrive later.
  const current =
    options.find((o) => o.value === (value ?? own)) ??
    (value === undefined ? options[0] : undefined);
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;

  const choose = (o: PickerOption) => {
    menu.current?.hidePopover();
    setOwn(o.value);
    onChange?.(o.value);
  };

  return (
    <>
      {button && (
        <button
          type="button"
          popoverTarget={menuId}
          aria-haspopup="menu"
          aria-label={`${label}: ${current?.label ?? "none"}`}
          title={current?.label}
          // It can shrink, cutting a long choice (a branch name) short rather than widening its row.
          className={`${menuButton} min-w-0`}
        >
          {current?.icon ?? icon}
          <span className="truncate">{current?.label}</span>
          <ChevronDown aria-hidden className="opacity-70" />
        </button>
      )}
      <div
        ref={menu}
        id={menuId}
        popover="auto"
        role="menu"
        aria-label={label}
        onToggle={(e: ToggleEvent<HTMLDivElement>) => {
          if (e.newState === "closed") return setQuery("");
          if (search) searchBox.current?.focus();
          else menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
        }}
        onKeyDown={moveFocus}
        className={`${menuPanel(align)} overflow-hidden p-0 ${panelClassName}`}
      >
        {search && (
          <label className="flex items-center gap-2 border-b border-border px-3 py-2.5 focus-within:border-ring">
            <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
            <input
              ref={searchBox}
              type="search"
              aria-label={search}
              placeholder={search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shown[0]) choose(shown[0]);
              }}
              className="min-w-0 flex-1 bg-transparent text-[13.5px] placeholder:text-faint-foreground focus-visible:outline-none"
            />
          </label>
        )}
        <div className="max-h-80 overflow-y-auto p-1">
          {shown.map((o) => (
            <Fragment key={o.value}>
              {o.divider && <div role="separator" className="-mx-1 my-1 h-px bg-border" />}
              <MenuOption option={o} checked={o === current} onClick={() => choose(o)} />
            </Fragment>
          ))}
          {shown.length === 0 && (
            <p className="px-2 py-1.5 text-[12.5px] text-faint-foreground">No matches</p>
          )}
        </div>
      </div>
    </>
  );
}

export interface Crumb {
  label: string;
  icon?: ReactNode;
  /** Makes it a link back to that page. */
  onClick?: () => void;
}

/** Where the user is: host, workspace, then the current page, split by slashes. */
export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-2 text-[13px]">
        {items.map(({ label, icon, onClick }, i) => {
          const last = i === items.length - 1;
          const Tag = onClick ? "button" : "span";
          return (
            // The slash is CSS content, so it stays out of the crumb's text.
            <li
              key={i}
              className={`flex min-w-0 items-center gap-2 ${last ? "" : "shrink-0"} ${i > 0 ? "before:text-faint-foreground before:content-['/']" : ""}`}
            >
              <Tag
                {...(onClick && { type: "button", onClick })}
                aria-current={last ? "page" : undefined}
                className={`flex min-w-0 items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0 ${last ? "font-medium text-foreground" : "text-muted-foreground"} ${onClick ? "rounded-md hover:text-foreground" : ""}`}
              >
                {icon}
                <span className="truncate">{label}</span>
              </Tag>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The 52px top row of a pane. On macOS and Windows it is also the window's title bar. */
export function TopBar({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`titlebar flex h-13 shrink-0 items-center gap-2 px-3 ${className}`}>
      {children}
    </div>
  );
}
