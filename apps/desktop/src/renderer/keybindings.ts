import { merged, stored } from "./stored";
import type { KeyPress } from "./ui";

/** An app command a keybinding runs. App, ThreadList, and OpenMenu act on them. */
export type Command =
  | "commandMenu"
  | "goToFile"
  | "searchContents"
  | "newThread"
  | "noRepoThread"
  | "sidebar"
  | "panel"
  | "browser"
  | "terminal"
  | "open"
  | "settings"
  | "usage"
  | "find"
  | "openPr"
  | "parentThread"
  | "nextThread"
  | "previousThread"
  | "leftThread"
  | "rightThread"
  | "thirdThread"
  | "fourthThread"
  | "back"
  | "forward";

/**
 * Every rebindable command, in Settings > Keybinds' order, with its default bindings. "Mod" is
 * Cmd on macOS and Ctrl elsewhere. Ctrl+Shift+` is Ctrl on macOS too, so the terminal's toggle
 * is the same press everywhere. `elsewhere` replaces the defaults off macOS.
 */
export const commands: { id: Command; name: string; defaults: string[]; elsewhere?: string[] }[] = [
  // The command menu and its file pages (PLX-993).
  { id: "commandMenu", name: "Open command menu", defaults: ["Mod+KeyK"] },
  { id: "goToFile", name: "Go to file", defaults: ["Mod+KeyP"] },
  { id: "searchContents", name: "Search project contents", defaults: ["Mod+Shift+KeyF"] },
  { id: "newThread", name: "New thread", defaults: ["Mod+KeyN"] },
  { id: "noRepoThread", name: "New chat", defaults: ["Mod+Shift+KeyN"] },
  { id: "sidebar", name: "Toggle sidebar", defaults: ["Mod+KeyS"] },
  { id: "panel", name: "Toggle side panel", defaults: ["Mod+Alt+KeyB"] },
  { id: "browser", name: "Open browser", defaults: ["Mod+Shift+KeyB"] },
  { id: "terminal", name: "Toggle terminal", defaults: ["Mod+KeyJ", "Ctrl+Shift+Backquote"] },
  { id: "open", name: "Open folder in default app", defaults: ["Mod+Alt+KeyO"] },
  { id: "settings", name: "Open Settings", defaults: ["Mod+Comma"] },
  { id: "usage", name: "Open Usage", defaults: ["Mod+Alt+KeyU"] },
  { id: "find", name: "Find in thread", defaults: ["Mod+KeyF"] },
  { id: "openPr", name: "Open pull request on GitHub", defaults: ["Mod+Shift+KeyP"] },
  // A thread's lineage (0041): from a parent, next and previous open its first and last child.
  { id: "parentThread", name: "Go to parent thread", defaults: ["Mod+Alt+ArrowUp"] },
  { id: "nextThread", name: "Next sibling thread", defaults: ["Mod+Alt+ArrowRight"] },
  { id: "previousThread", name: "Previous sibling thread", defaults: ["Mod+Alt+ArrowLeft"] },
  // The split's threads (PLX-587, PLX-1082), each by its place. The first two keep their old ids so
  // a saved rebinding still applies. Off macOS, Ctrl+1 to Ctrl+4 open sidebar rows.
  {
    id: "leftThread",
    name: "Focus thread 1",
    defaults: ["Ctrl+Digit1"],
    elsewhere: ["Ctrl+Shift+Digit1"],
  },
  {
    id: "rightThread",
    name: "Focus thread 2",
    defaults: ["Ctrl+Digit2"],
    elsewhere: ["Ctrl+Shift+Digit2"],
  },
  {
    id: "thirdThread",
    name: "Focus thread 3",
    defaults: ["Ctrl+Digit3"],
    elsewhere: ["Ctrl+Shift+Digit3"],
  },
  {
    id: "fourthThread",
    name: "Focus thread 4",
    defaults: ["Ctrl+Digit4"],
    elsewhere: ["Ctrl+Shift+Digit4"],
  },
  // The threads opened in this window, as a browser's history (PLX-789).
  { id: "back", name: "Back", defaults: ["Mod+BracketLeft"] },
  { id: "forward", name: "Forward", defaults: ["Mod+BracketRight"] },
];

/** The commands that focus the split's threads, by their place in it. */
export const tileCommands = ["leftThread", "rightThread", "thirdThread", "fourthThread"] as const;

const order = ["Ctrl", "Alt", "Shift", "Meta"];
export const modifiers = ["Control", "Alt", "Shift", "Meta", "AltGraph"];

/** `binding` with Mod made this OS's, and its modifiers in `keybindingOf`'s order. */
function resolve(binding: string): string {
  const mod = window.parallax.platform === "darwin" ? "Meta" : "Ctrl";
  const parts = binding.split("+").map((p) => (p === "Mod" ? mod : p));
  const key = parts.pop()!;
  return [...order.filter((m) => parts.includes(m)), key].join("+");
}

/**
 * The keybinding a press makes, as its modifiers then its key's code, e.g. "Ctrl+Shift+KeyT".
 * Undefined for a lone modifier, for a press without Cmd or Ctrl, which would type, and off macOS
 * for AltGr, which arrives as Ctrl+Alt and types characters.
 */
export function keybindingOf(e: KeyPress): string | undefined {
  if (modifiers.includes(e.key) || !(e.metaKey || e.ctrlKey)) return undefined;
  if (window.parallax.platform !== "darwin" && e.getModifierState("AltGraph")) return undefined;
  const held = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"];
  return [...held.filter(Boolean), e.code].join("+");
}

const macSymbols: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" };
const keyNames: Record<string, string> = {
  Comma: ",",
  Backquote: "`",
  Period: ".",
  Slash: "/",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  BracketLeft: "[",
  BracketRight: "]",
};

/** A keybinding as the OS writes it: "⌃⇧T" on macOS, "Ctrl+Shift+T" elsewhere. */
export function formatKeybinding(keybinding: string): string {
  const parts = keybinding.split("+");
  const code = parts.pop()!;
  const key = keyNames[code] ?? code.replace(/^(Key|Digit)/, "");
  return window.parallax.platform === "darwin"
    ? parts.map((p) => macSymbols[p]).join("") + key
    : [...parts, key].join("+");
}

/** A keybinding as `aria-keyshortcuts` writes it: "Meta+Shift+KeyN" is "Meta+Shift+N". */
export const ariaKeyshortcut = (keybinding: string) =>
  keybinding.replace(/^Ctrl\b/, "Control").replace(/(Key|Digit)(\w)$/, "$2");

// Cmd or Ctrl with these sends a message, or copies, pastes, cuts, undoes, or selects all.
export const editingKeys = ["Enter", "NumpadEnter", "KeyC", "KeyV", "KeyX", "KeyZ", "KeyA"];

type Overrides = Partial<Record<Command, string[]>>;
const overrides = stored<Overrides>("parallax.keybindings", {}, merged);

/** The bindings `command` runs on, this OS's: the user's, or else its defaults. */
export function bindingsOf(command: Command): string[] {
  const c = commands.find((c) => c.id === command)!;
  const defaults = window.parallax.platform !== "darwin" && c.elsewhere ? c.elsewhere : c.defaults;
  return overrides.get()[command] ?? defaults.map(resolve);
}

/**
 * Sets `command`'s bindings, saved for every window of this computer. Undefined puts its
 * defaults back; an empty list leaves it with none.
 */
export function setBindings(command: Command, bindings: string[] | undefined) {
  const next = { ...overrides.get() };
  if (bindings) next[command] = bindings;
  else delete next[command];
  overrides.set(next);
}

/** Puts every command's defaults back. */
export const resetBindings = () => overrides.set({});

/** Whether `command`'s bindings are its defaults. */
export const isDefault = (command: Command) => !overrides.get()[command];

/** The command `keybinding` runs, if any. */
export const commandOf = (keybinding: string): Command | undefined =>
  commands.find((c) => bindingsOf(c.id).includes(keybinding))?.id;

/** Re-renders on any binding change. */
export const useKeybindings = overrides.use;

/** `command`'s first binding as the OS writes it, kept current, for tooltips and menus. */
export function useShortcutLabel(command?: Command): string | undefined {
  useKeybindings();
  const first = command && bindingsOf(command)[0];
  return first && formatKeybinding(first);
}
