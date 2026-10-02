import { Check, ImageUp, Search } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent, type Ref, type ToggleEvent } from "react";

import type { ProjectIcon as ProjectIconValue } from "../protocol/generated/protocol";
import { imageUrl, readIcon } from "./images";
import { defaultIcon, iconColors, iconLook, projectIcons } from "./projectIcons";
import { menuPanel } from "./ui";

// The grid's columns, which Up and Down step across.
const columns = 9;
const steps: Partial<Record<string, number>> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -columns,
  ArrowDown: columns,
};

/**
 * A Project's icon picker, a native popover like the menus: a search box, the colors (the accent,
 * then the palette), and a grid of icons drawn in the chosen color. Open it with
 * `popoverTarget={id}`, or with `showPopover({ source })` to sit under another element. It starts
 * at `value` each time it opens and keeps its own pick from then on. Every pick, a color or an
 * icon, calls `onPick` with both, since an icon replaces the whole icon (0032), and the picker
 * stays open so both can be set. Arrow keys move in the grid, Enter picks, and Escape closes.
 * With `maxImageBytes`, where the host keeps icon images (0038), Upload image beside the search box
 * picks an image file instead, shown selected on that button. A glyph or color picked after it
 * replaces it, and a file that can't be used says why in the picker.
 */
export function IconPicker({
  ref,
  id,
  value,
  onPick,
  align = "start",
  maxImageBytes,
}: {
  ref?: Ref<HTMLDivElement>;
  id: string;
  /** Where it starts: the Project's icon, or none for the default. */
  value?: ProjectIconValue;
  onPick: (icon: ProjectIconValue) => void;
  /** `center`: centered under what opened it. */
  align?: "start" | "center";
  /** The host's `iconImages` cap, or none where its plxd keeps no icon images. */
  maxImageBytes?: number;
}) {
  const colorGroup = useId();
  const searchBox = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  // Its content is drawn only while it's open, so a sidebar of Projects holds no hidden grids.
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState(value ?? defaultIcon);
  const [query, setQuery] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string>();

  const q = query.trim().toLowerCase();
  const shown = q
    ? projectIcons.filter((i) => i.label.toLowerCase().includes(q) || i.keywords.includes(q))
    : projectIcons;
  // The one icon Tab stops at in the grid: the current one, or the first shown.
  const tabStop = shown.find((i) => i.name === pick.name) ?? shown[0];

  const choose = (next: ProjectIconValue) => {
    setUploadError(undefined);
    setPick(next);
    onPick(next);
  };
  // The accent is no color at all.
  const withColor = (color?: string) => (color ? { name: pick.name, color } : { name: pick.name });
  const withGlyph = (name: string) => (pick.color ? { name, color: pick.color } : { name });
  // An image keeps the glyph and color under it, for an app that doesn't draw images (0038).
  const upload = async (file: File) => {
    const image = await readIcon(file, maxImageBytes!);
    if (typeof image === "string") setUploadError(image);
    else choose({ ...withColor(pick.color), image });
  };

  const moveInGrid = (e: KeyboardEvent<HTMLElement>) => {
    const step = steps[e.key];
    if (!step) return;
    e.preventDefault();
    const options = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
    const next = options.indexOf(document.activeElement as HTMLElement) + step;
    // Up from the top row goes back to the search box.
    if (next < 0 && e.key === "ArrowUp") searchBox.current?.focus();
    else options[next]?.focus();
  };

  return (
    <div
      ref={ref}
      id={id}
      popover="auto"
      role="dialog"
      aria-label="Project icon"
      onBeforeToggle={(e: ToggleEvent<HTMLDivElement>) => {
        if (e.newState !== "open") return;
        setPick(value ?? defaultIcon);
        setQuery("");
        setUploadError(undefined);
        setOpen(true);
      }}
      onToggle={(e: ToggleEvent<HTMLDivElement>) => {
        if (e.newState === "open") searchBox.current?.focus();
        else setOpen(false);
      }}
      className={`${menuPanel(align)} w-80 overflow-hidden p-0`}
    >
      {open && (
        <>
          <label className="flex items-center gap-2 border-b border-border px-3 py-2.5 focus-within:border-ring">
            <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
            <input
              ref={searchBox}
              type="search"
              aria-label="Search icons"
              placeholder="Search icons"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter belongs to an input method while it composes.
                if (e.nativeEvent.isComposing) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  grid.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
                } else if (e.key === "Enter") {
                  // Picks the first match, and never submits a form around it. With nothing typed
                  // it picks nothing, since the box has focus as the picker opens.
                  e.preventDefault();
                  if (q && shown[0]) choose(withGlyph(shown[0].name));
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-[13.5px] placeholder:text-faint-foreground focus-visible:outline-none"
            />
            {maxImageBytes !== undefined && (
              <>
                <button
                  type="button"
                  aria-label="Upload image"
                  title="Upload image"
                  aria-pressed={!!pick.image}
                  onClick={() => fileInput.current?.click()}
                  className="-my-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground aria-pressed:bg-selected [&_svg]:size-4"
                >
                  {pick.image ? (
                    <img
                      alt=""
                      src={imageUrl(pick.image)}
                      className="size-4 rounded-[22%] object-cover"
                    />
                  ) : (
                    <ImageUp aria-hidden />
                  )}
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  hidden
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  onChange={(e) => {
                    const file = e.currentTarget.files?.[0];
                    // Cleared, so picking the same file again reads it again.
                    e.currentTarget.value = "";
                    if (file) void upload(file);
                  }}
                />
              </>
            )}
          </label>
          {uploadError && (
            <p role="alert" className="px-3 pt-2 text-[12.5px] text-danger">
              {uploadError}
            </p>
          )}
          <fieldset aria-label="Color" className="flex justify-between px-3 pt-3 pb-1">
            {iconColors.map((c) => {
              // An image has no color of its own.
              const checked = !pick.image && pick.color === c.key;
              return (
                <label
                  key={c.label}
                  title={c.label}
                  className={`grid size-5 place-items-center rounded-full ${c.fill} has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring`}
                >
                  <input
                    type="radio"
                    name={colorGroup}
                    aria-label={c.label}
                    checked={checked}
                    onChange={() => choose(withColor(c.key))}
                    className="sr-only"
                  />
                  {/* The palette is dark on the light theme and light on the dark one, so the
                      page's background reads on it; the accent has its own foreground. */}
                  {checked && (
                    <Check
                      aria-hidden
                      strokeWidth={3}
                      className={`size-3 ${c.key ? "text-background" : "text-accent-foreground"}`}
                    />
                  )}
                </label>
              );
            })}
          </fieldset>
          {shown.length > 0 ? (
            <div
              ref={grid}
              role="listbox"
              aria-label="Icons"
              onKeyDown={moveInGrid}
              className={`grid max-h-64 grid-cols-9 gap-0.5 overflow-y-auto p-2 ${iconLook(pick).color}`}
            >
              {shown.map((i) => (
                <button
                  key={i.name}
                  type="button"
                  role="option"
                  aria-selected={!pick.image && i.name === pick.name}
                  aria-label={i.label}
                  title={i.label}
                  tabIndex={i === tabStop ? 0 : -1}
                  onClick={() => choose(withGlyph(i.name))}
                  className="grid size-8 place-items-center rounded-md hover:bg-hover aria-selected:bg-selected [&_svg]:size-4.5"
                >
                  <i.Icon aria-hidden />
                </button>
              ))}
            </div>
          ) : (
            <p className="px-3 pt-2 pb-3 text-[12.5px] text-faint-foreground">No icons match</p>
          )}
        </>
      )}
    </div>
  );
}
