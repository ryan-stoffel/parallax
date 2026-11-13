import { t } from "i18next";

import { msg } from "../i18n";
import { stored } from "./stored";
import type { KeyPress } from "./ui";

/** An app command a keybinding runs. App, ThreadList, and OpenMenu act on them. */
export type Command =
  | "commandMenu"
  | "goToFile"
  | "searchContents"
  | "newThread"
  | "noRepoThread"
  | "newOrchestrator"
  | "newTab"
  | "closeTab"
  | "nextTab"
  | "previousTab"
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
  | "forward"
  | "cycleAppearance"
  | "toggleWordWrap"
  | "textLarger"
  | "textSmaller"
  | "settingsKeybinds"
  | "settingsProviders"
  | "settingsProjects";

/** What a keybinding's "When" can ask. Evaluated at each press (`whenHolds`). */
export type When = "always" | "!terminalFocus" | "terminalFocus" | "!inputFocus" | "inputFocus";

/** Each `When`, as Settings > Keybindings' menu offers it. */
export const whenOptions: { value: When; label: string; detail: string }[] = [
  { value: "always", label: msg("Always"), detail: msg("Anywhere in the app.") },
  {
    value: "!terminalFocus",
    label: "!terminalFocus",
    detail: msg("Unless a terminal has focus, so the shell gets the keys there."),
  },
  {
    value: "terminalFocus",
    label: "terminalFocus",
    detail: msg("Only while a terminal has focus."),
  },
  {
    value: "!inputFocus",
    label: "!inputFocus",
    detail: msg("Unless you're typing in a field or the composer."),
  },
  {
    value: "inputFocus",
    label: "inputFocus",
    detail: msg("Only while typing in a field or the composer."),
  },
];

/** A heading in Settings > Keybindings, in its order. */
export const commandCategories = [
  msg("Navigation"),
  msg("Threads"),
  msg("Panels"),
  msg("Code"),
  msg("Appearance"),
] as const;

/**
 * Every rebindable command, in Settings > Keybindings' order, as "Area: Action", with its default
 * binding, if any. "Mod" is Cmd on macOS and Ctrl elsewhere. `elsewhere` replaces the default off
 * macOS. A command has one binding at most.
 */
export const commands: {
  id: Command;
  name: string;
  category: (typeof commandCategories)[number];
  default?: string;
  elsewhere?: string;
}[] = [
  // The command menu and its file pages (PLX-993).
  {
    id: "commandMenu",
    name: msg("Command Menu: Toggle"),
    category: "Navigation",
    default: "Mod+KeyK",
  },
  { id: "goToFile", name: msg("File Picker: Toggle"), category: "Navigation", default: "Mod+KeyP" },
  {
    id: "searchContents",
    name: msg("Project Search: Toggle"),
    category: "Navigation",
    default: "Mod+Shift+KeyF",
  },
  { id: "settings", name: msg("Settings: Open"), category: "Navigation", default: "Mod+Comma" },
  { id: "settingsKeybinds", name: msg("Settings: Open Keybindings"), category: "Navigation" },
  { id: "settingsProviders", name: msg("Settings: Open Providers"), category: "Navigation" },
  { id: "settingsProjects", name: msg("Settings: Open Projects"), category: "Navigation" },
  { id: "usage", name: msg("Usage: Open"), category: "Navigation", default: "Mod+Alt+KeyU" },
  // The threads opened in this window, as a browser's history (PLX-789).
  { id: "back", name: msg("History: Back"), category: "Navigation", default: "Mod+BracketLeft" },
  {
    id: "forward",
    name: msg("History: Forward"),
    category: "Navigation",
    default: "Mod+BracketRight",
  },
  { id: "newThread", name: msg("Thread: New"), category: "Threads", default: "Mod+KeyN" },
  {
    id: "noRepoThread",
    name: msg("Thread: New Without Repo"),
    category: "Threads",
    default: "Mod+Shift+KeyN",
  },
  {
    id: "newOrchestrator",
    name: msg("Thread: New Orchestrator"),
    category: "Threads",
    default: "Mod+Shift+KeyO",
  },
  { id: "find", name: msg("Thread: Find"), category: "Threads", default: "Mod+KeyF" },
  // A thread's lineage (0041): from a parent, next and previous open its first and last child.
  {
    id: "parentThread",
    name: msg("Thread: Go to Parent"),
    category: "Threads",
    default: "Mod+Alt+ArrowUp",
  },
  {
    id: "nextThread",
    name: msg("Thread: Next Sibling"),
    category: "Threads",
    default: "Mod+Alt+ArrowRight",
  },
  {
    id: "previousThread",
    name: msg("Thread: Previous Sibling"),
    category: "Threads",
    default: "Mod+Alt+ArrowLeft",
  },
  // The top bar's tabs (PLX-1289).
  { id: "newTab", name: msg("Tab: New"), category: "Threads", default: "Mod+KeyT" },
  { id: "closeTab", name: msg("Tab: Close"), category: "Threads", default: "Mod+KeyW" },
  { id: "nextTab", name: msg("Tab: Next"), category: "Threads", default: "Ctrl+Tab" },
  { id: "previousTab", name: msg("Tab: Previous"), category: "Threads", default: "Ctrl+Shift+Tab" },
  // The split's threads (PLX-587, PLX-1082), each by its place. The first two keep their old ids so
  // a saved rebinding still applies. Off macOS, Ctrl+1 to Ctrl+4 open sidebar rows.
  {
    id: "leftThread",
    name: msg("Split: Focus Thread 1"),
    category: "Threads",
    default: "Ctrl+Digit1",
    elsewhere: "Ctrl+Shift+Digit1",
  },
  {
    id: "rightThread",
    name: msg("Split: Focus Thread 2"),
    category: "Threads",
    default: "Ctrl+Digit2",
    elsewhere: "Ctrl+Shift+Digit2",
  },
  {
    id: "thirdThread",
    name: msg("Split: Focus Thread 3"),
    category: "Threads",
    default: "Ctrl+Digit3",
    elsewhere: "Ctrl+Shift+Digit3",
  },
  {
    id: "fourthThread",
    name: msg("Split: Focus Thread 4"),
    category: "Threads",
    default: "Ctrl+Digit4",
    elsewhere: "Ctrl+Shift+Digit4",
  },
  { id: "sidebar", name: msg("Sidebar: Toggle"), category: "Panels", default: "Mod+KeyS" },
  { id: "panel", name: msg("Side Panel: Toggle"), category: "Panels", default: "Mod+Alt+KeyB" },
  { id: "browser", name: msg("Browser: Toggle"), category: "Panels", default: "Mod+Shift+KeyB" },
  { id: "terminal", name: msg("Terminal: Toggle"), category: "Panels", default: "Mod+KeyJ" },
  {
    id: "open",
    name: msg("Folder: Open in Default App"),
    category: "Code",
    default: "Mod+Alt+KeyO",
  },
  {
    id: "openPr",
    name: msg("Pull Request: Open on GitHub"),
    category: "Code",
    default: "Mod+Shift+KeyP",
  },
  { id: "cycleAppearance", name: msg("Appearance: Cycle"), category: "Appearance" },
  { id: "toggleWordWrap", name: msg("Appearance: Toggle Word Wrap"), category: "Appearance" },
  { id: "textLarger", name: msg("Appearance: Larger Text"), category: "Appearance" },
  { id: "textSmaller", name: msg("Appearance: Smaller Text"), category: "Appearance" },
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

/** A keybinding's keys as the OS writes each: ["⌃", "⇧", "T"] on macOS, else ["Ctrl", "Shift", "T"]. */
export function keysOf(keybinding: string): string[] {
  const parts = keybinding.split("+");
  const code = parts.pop()!;
  const key = keyNames[code] ?? code.replace(/^(Key|Digit)/, "");
  const mac = window.parallax.platform === "darwin";
  return [...parts.map((p) => (mac ? macSymbols[p]! : p)), key];
}

/** A keybinding as the OS writes it: "⌃⇧T" on macOS, "Ctrl+Shift+T" elsewhere. */
export const formatKeybinding = (keybinding: string): string =>
  keysOf(keybinding).join(window.parallax.platform === "darwin" ? "" : "+");

/** A keybinding as `aria-keyshortcuts` writes it: "Meta+Shift+KeyN" is "Meta+Shift+N". */
export const ariaKeyshortcut = (keybinding: string) =>
  keybinding.replace(/^Ctrl\b/, "Control").replace(/(Key|Digit)(\w)$/, "$2");

// Cmd or Ctrl with these sends a message, or copies, pastes, cuts, undoes, or selects all.
export const editingKeys = ["Enter", "NumpadEnter", "KeyC", "KeyV", "KeyX", "KeyZ", "KeyA"];

/** A command's changes from its defaults: its key, null for none, and its When. */
type Override = { key?: string | null; when?: When };
type Overrides = Partial<Record<Command, Override>>;

const known = (id: string): id is Command => commands.some((c) => c.id === id);
const isWhen = (value: unknown): value is When => whenOptions.some((w) => w.value === value);

/**
 * Saved overrides, dropping what this version doesn't know. A list is how they were saved when a
 * command could have several: its first stays, and an empty one means none.
 */
export function parseOverrides(raw: unknown): Overrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const next: Overrides = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!known(id)) continue;
    if (Array.isArray(value)) {
      const first: unknown = value[0];
      next[id] = { key: typeof first === "string" ? first : null };
    } else if (value && typeof value === "object") {
      const { key, when } = value as { key?: unknown; when?: unknown };
      const override: Override = {};
      if (typeof key === "string" || key === null) override.key = key;
      if (isWhen(when)) override.when = when;
      next[id] = override;
    }
  }
  return next;
}

const overrides = stored<Overrides>("parallax.keybindings", {}, (raw) => parseOverrides(raw));

/** The binding `command` runs on, this OS's, if any: the user's, or else its default. */
export function bindingOf(command: Command): string | undefined {
  const saved = overrides.get()[command]?.key;
  return saved !== undefined ? (saved ?? undefined) : defaultKey(command);
}

/** `command`'s default binding on this OS, if any. */
function defaultKey(command: Command): string | undefined {
  const c = commands.find((c) => c.id === command)!;
  const fallback = window.parallax.platform !== "darwin" && c.elsewhere ? c.elsewhere : c.default;
  return fallback && resolve(fallback);
}

/** When `command`'s binding applies. */
export const whenOf = (command: Command): When => overrides.get()[command]?.when ?? "always";

/** Saves `change` over `command`'s override, dropping an empty override, for every window. */
function change(command: Command, update: Override) {
  const { [command]: current, ...rest } = overrides.get();
  const next = { ...current, ...update };
  overrides.set(Object.keys(next).length ? { ...rest, [command]: next } : rest);
}

/** Sets `command`'s one binding, or null for none. */
export const setBinding = (command: Command, key: string | null) => change(command, { key });

/** Sets when `command`'s binding applies. */
export const setWhen = (command: Command, when: When) => change(command, { when });

/** Puts `command`'s default binding and When back. */
export function resetBinding(command: Command) {
  const { [command]: _, ...rest } = overrides.get();
  overrides.set(rest);
}

/** Puts every command's defaults back. */
export const resetBindings = () => overrides.set({});

/** Whether `command`'s binding and When are its defaults. */
export const isDefault = (command: Command) => !overrides.get()[command];

/** The command that owns `keybinding`, if any, whatever its When. */
export const commandOf = (keybinding: string): Command | undefined =>
  commands.find((c) => bindingOf(c.id) === keybinding)?.id;

/** Whether `when` holds for the element with focus now. */
export function whenHolds(when: When): boolean {
  if (when === "always") return true;
  const focused = document.activeElement;
  const terminal = !!focused?.closest(".xterm");
  const input =
    !terminal &&
    !!focused?.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
  if (when === "terminalFocus") return terminal;
  if (when === "!terminalFocus") return !terminal;
  return when === "inputFocus" ? input : !input;
}

/** The command a press of `keybinding` runs now: its owner, while its When holds. */
export function activeCommand(keybinding: string): Command | undefined {
  const command = commandOf(keybinding);
  return command && whenHolds(whenOf(command)) ? command : undefined;
}

/** Every command's binding and When as Settings' JSON editor shows them. */
export function bindingsJson(): string {
  const all = Object.fromEntries(
    commands.map((c) => [c.id, { key: bindingOf(c.id) ?? null, when: whenOf(c.id) }]),
  );
  return JSON.stringify(all, null, 2);
}

/** A key, as `keybindingOf` writes one or a default ("Mod") does: a code such as KeyK, never K. */
const keyShape = /^((Ctrl|Alt|Shift|Meta|Mod)\+)+[A-Z][A-Za-z0-9]+$/;

/** Why a resolved `key` can't be a command's, as recording it would say: it'd never run. */
function refusal(key: string): string | undefined {
  const parts = key.split("+");
  const code = parts.at(-1)!;
  if (!parts.includes("Ctrl") && !parts.includes("Meta"))
    return t("{{key}} needs Mod, Ctrl, or Meta", { key });
  if (editingKeys.includes(code)) return t("{{key}} is an editing shortcut", { key });
  const mod = window.parallax.platform === "darwin" ? "Meta" : "Ctrl";
  // As `rowShortcut` reads a press: whatever else is held, but Shift or Alt.
  if (
    /^Digit[1-9]$/.test(code) &&
    parts.includes(mod) &&
    !parts.includes("Shift") &&
    !parts.includes("Alt")
  )
    return t("{{key}} opens a sidebar row", { key });
  return undefined;
}

/**
 * Applies the JSON editor's `text` over the current bindings: a command it leaves out stays as it
 * is. Answers what's wrong instead, changing nothing: an unknown command or When, a key that can't
 * be pressed or that recording would refuse, or two commands on one key.
 */
export function applyBindingsJson(text: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return [(error as Error).message];
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return [t("Expected an object of commands.")];
  const errors: string[] = [];
  const next: Overrides = { ...overrides.get() };
  for (const [id, value] of Object.entries(raw)) {
    if (!known(id)) {
      errors.push(t("Unknown command: {{id}}", { id }));
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(t("{{id}}: an object with key and when", { id }));
      continue;
    }
    const { key, when } = value as { key?: unknown; when?: unknown };
    if (key !== undefined && key !== null && !(typeof key === "string" && keyShape.test(key))) {
      errors.push(t('{{id}}: a key like "Mod+KeyK", or null for none', { id }));
      continue;
    }
    const resolved = typeof key === "string" ? resolve(key) : key;
    const problem = typeof resolved === "string" ? refusal(resolved) : undefined;
    if (problem) {
      errors.push(`${id}: ${problem}`);
      continue;
    }
    if (when !== undefined && !isWhen(when)) {
      errors.push(t("{{id}}: unknown when {{when}}", { id, when: JSON.stringify(when) }));
      continue;
    }
    // Only what differs from the default is saved, and what's left out stays as it is.
    const override: Override = { ...next[id] };
    if (resolved !== undefined) {
      if (resolved === (defaultKey(id) ?? null)) delete override.key;
      else override.key = resolved;
    }
    if (when !== undefined) {
      if (when === "always") delete override.when;
      else override.when = when;
    }
    if (Object.keys(override).length) next[id] = override;
    else delete next[id];
  }
  if (errors.length) return errors;
  const before = overrides.get();
  overrides.set(next);
  const owners = new Map<string, string>();
  for (const c of commands) {
    const key = bindingOf(c.id);
    if (!key) continue;
    const owner = owners.get(key);
    if (owner)
      errors.push(
        t("{{key}} is on both {{first}} and {{second}}", {
          key: formatKeybinding(key),
          first: owner,
          second: c.id,
        }),
      );
    owners.set(key, c.id);
  }
  if (errors.length) overrides.set(before);
  return errors;
}

/** Re-renders on any binding change. */
export const useKeybindings = overrides.use;

/** `command`'s binding as the OS writes it, kept current, for tooltips and menus. */
export function useShortcutLabel(command?: Command): string | undefined {
  useKeybindings();
  const binding = command && bindingOf(command);
  return binding && formatKeybinding(binding);
}
