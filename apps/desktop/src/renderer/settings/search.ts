import type { SettingsSection } from "../App";
import { commands } from "../keybindings";

/**
 * Settings' sections in the nav's order, each under its group, with words a search for it might
 * use. A section's path is `/` and its slug, as `/source-control`.
 */
export const settingsSections: {
  id: SettingsSection;
  name: string;
  group: string;
  keywords?: string;
}[] = [
  { id: "general", name: "General", group: "App", keywords: "preferences basics" },
  { id: "threads", name: "Threads", group: "App", keywords: "chats conversations defaults" },
  { id: "appearance", name: "Appearance", group: "App", keywords: "look theme style display" },
  { id: "keybinds", name: "Keybinds", group: "App", keywords: "shortcuts hotkeys keyboard" },
  { id: "providers", name: "Providers", group: "Agents", keywords: "agents models accounts ai" },
  { id: "usage", name: "Usage", group: "Agents", keywords: "tokens cost spend limits stats" },
  { id: "schedules", name: "Schedules", group: "Agents", keywords: "cron timers automation" },
  { id: "sourceControl", name: "Source control", group: "Projects", keywords: "git github" },
  { id: "scripts", name: "Scripts", group: "Projects", keywords: "setup commands worktree" },
  { id: "connections", name: "Connections", group: "System", keywords: "hosts computers ssh" },
  { id: "storage", name: "Storage", group: "System", keywords: "disk space cleanup" },
];

/**
 * One setting a search can find. `title` is its row's or section's title on its page, whose
 * `data-setting` is `anchorOf(title)`, unless `anchor` names another.
 */
export interface SettingEntry {
  section: SettingsSection;
  title: string;
  group?: string;
  description?: string;
  keywords?: string;
  anchor?: string;
}

/** A title as a path segment and a `data-setting`: "Time format" → "time-format". */
export const anchorOf = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Every setting, by page. Keep in step with the pages: search.test.ts checks each renders. */
export const settingsIndex: SettingEntry[] = [
  // General
  ...entries("general", "Open", [
    ["Open folders in", "What Open uses", "editor ide vscode cursor finder explorer default app"],
    [
      "Terminal",
      "The terminal used to open folders",
      "ghostty iterm alacritty warp kitty shell console",
    ],
    [
      "Terminal command",
      "Type parallax in a terminal to open Parallax there",
      "cli path shell install",
    ],
  ]),
  ...entries("general", "Notifications", [
    [
      "System notifications",
      "An alert from your computer when a thread finishes, fails, or needs you",
      "alerts notify os banner sound",
    ],
    [
      "In-app notifications",
      "A toast when a thread finishes, fails, or needs you",
      "alerts toast popup",
    ],
  ]),
  ...entries("general", "Preferences", [
    ["Time format", "System default follows your OS clock", "clock 12-hour 24-hour am pm hours"],
    [
      "Send shortcut",
      "What sends a message, and what starts a new line",
      "enter submit cmd ctrl newline keyboard",
    ],
    [
      "Open pull requests in",
      "Your system browser, or the side panel's",
      "browser github pr links",
    ],
  ]),
  ...entries("general", "Updates", [
    [
      "Download updates automatically",
      "Download a new Parallax release as soon as it's out",
      "auto update upgrade release",
    ],
    [
      "Check for provider updates",
      "Check Claude Code and Codex for new releases",
      "claude codex cli version",
    ],
    [
      "Update providers automatically",
      "Update Claude Code and Codex when a release is found",
      "auto upgrade claude codex",
    ],
  ]),
  ...entries("general", "About", [
    ["Version", "This copy of Parallax", "about build release number"],
    ["Open source licenses", "Notices for bundled fonts", "fonts notices legal credits"],
  ]),
  // Threads
  ...entries("threads", "New threads", [
    ["Model", "The model a new thread starts on", "default model claude gpt opus sonnet codex"],
    [
      "Reasoning",
      "How hard it thinks, its context window, and fast mode",
      "effort thinking context window fast mode",
    ],
    [
      "Permissions",
      "What a new thread may do without asking",
      "access approve ask sandbox edit yolo full",
    ],
    ["Legacy Plan mode", "List Plan in the Access picker", "plan access picker"],
    [
      "Workspace",
      "Where a thread in a repository works",
      "worktree branch local repository checkout",
    ],
    ["Naming model", "Names a new thread and its branch", "title rename branch name auto"],
  ]),
  ...entries("threads", "Sidebar", [
    ["Working section", "List working threads under Working", "sidebar running active busy list"],
    ["Archive pages", "Show archived threads a page at a time", "archived show more pagination"],
  ]),
  ...entries("threads", "Resuming threads", [
    [
      "Resume after a usage limit",
      "Continue once the limit resets",
      "rate limit auto resume quota retry",
    ],
    [
      "Continue threads after restarts",
      "Continue after plxd restarts",
      "restart plxd update crash interrupted",
    ],
  ]),
  // Appearance
  ...entries("appearance", "Theme", [
    [
      "Color scheme",
      "Which theme shows. System follows your OS",
      "dark mode light mode night system theme",
    ],
    ["Light theme", "Shown in light mode", "theme colors vs code"],
    ["Dark theme", "Shown in dark mode", "theme colors vs code"],
    ["Installed themes", "VS Code themes from Open VSX", "open vsx vscode extensions add theme"],
  ]),
  ...entries("appearance", undefined, [
    ["Colors", "Change the shown theme's colors", "accent palette custom json customize"],
  ]),
  ...entries("appearance", "Window", [
    [
      "Background",
      "Clear or blurred, where the desktop shows through",
      "transparent blur vibrancy opaque frosted glass",
    ],
    [
      "Background opacity",
      "How much of the theme covers what shows through",
      "transparency translucent",
    ],
  ]),
  ...entries("appearance", "Text", [
    [
      "Interface font",
      "Menus, chat, and everything outside code",
      "font family size typography ui",
    ],
    [
      "Code font",
      "Code blocks, diffs, file previews, and the terminal",
      "monospace mono font size typography terminal",
    ],
    ["Word wrap", "Wrap long lines in code by default", "wrap lines long"],
  ]),
  ...entries("appearance", "Interface", [
    ["Contrast", "Stronger text and borders", "accessibility high contrast"],
    ["Reduce motion", "Stops animations", "animations accessibility"],
    [
      "Change colors",
      "What marks added and removed lines",
      "diff colors colorblind red green blue orange",
    ],
    ["Usage in the composer", "A ring, a row, or nothing", "ring inline limits context meter"],
  ]),
  // Keybinds
  ...entries("keybinds", undefined, [
    ["Shortcuts", "Shortcuts for the whole app", "hotkeys keyboard bindings rebind reset"],
  ]),
  ...commands.map((c): SettingEntry => ({
    section: "keybinds",
    group: "Shortcuts",
    title: c.name,
    keywords: "shortcut keybind hotkey",
  })),
  ...entries("keybinds", "Built in", [
    ["Open a sidebar row", "The first nine threads in the sidebar", "number jump"],
    ["Send a message", undefined, "enter submit"],
    ["Steer an agent now", undefined, "interrupt"],
    ["Start a new thread and stay here", undefined, "background"],
    ["New line in a message", undefined, "newline shift enter"],
  ]),
  // Providers
  ...entries("providers", undefined, [
    ["Account", "Sign in to a provider", "sign in login authenticate subscription install"],
    ["Display name", "How threads and model menus name a provider", "rename"],
    ["Binary path", "The binary a provider runs", "program executable path cli"],
    ["Launch arguments", "Arguments passed on session start", "args flags cli"],
    [
      "Environment",
      "API keys, base URLs, and other variables",
      "env variables api key base url secret",
    ],
    ["Models", "The models a provider offers", "custom model add model"],
  ]),
  {
    section: "providers",
    title: "API keys",
    description: "Keys kept in the host's keychain",
    keywords: "anthropic openai key",
    // Claude Code's pane is the one shown first.
    anchor: "anthropic-api-keys",
  },
  // Usage, Schedules, Source control, Scripts
  ...entries("schedules", undefined, [
    [
      "Scheduled tasks",
      "Prompts on a timer or webhook",
      "cron timer webhook recurring automation pause",
    ],
  ]),
  ...entries("sourceControl", undefined, [
    ["Hosting", "The GitHub CLI on each host", "github gh cli pull requests sign in git"],
  ]),
  ...entries("scripts", undefined, [
    [
      "Scripts",
      "Setup and settle scripts in a thread's worktree",
      "setup settle worktree commands",
    ],
    ["From parallax.json", "Scripts a repository defines", "parallax json import config"],
  ]),
  // Connections
  ...entries("connections", undefined, [
    ["This computer", "Its name and plxd", "rename computer name local"],
    ["Local plxd", "Runs agents on this computer", "daemon status version"],
  ]),
  ...entries("connections", "Parallax Connect", [
    ["Parallax Connect", "Your computers, wherever they are", "relay remote devices account sync"],
  ]),
  ...entries("connections", "Same network", [
    ["Same network", "Pair computers on this network", "lan local network wifi"],
    ["Pair computers on this network", undefined, "lan pair wifi"],
    [
      "Open in a browser",
      "Use Parallax from a browser on this network",
      "web phone mobile certificate",
    ],
    ["Reach from anywhere", "Through Parallax Relay", "relay internet remote"],
    ["Pair a device", "With a pairing code", "pairing code phone"],
    ["Computers on this network", undefined, "lan nearby devices"],
  ]),
  ...entries("connections", undefined, [
    ["SSH hosts", "Machines you reach over SSH", "ssh remote server add host"],
  ]),
  // Storage
  ...entries("storage", undefined, [
    ["On this computer", "What Parallax keeps, and its size", "disk space size cache logs"],
  ]),
  ...entries("storage", "Worktrees", [
    [
      "Clean up merged worktrees",
      "Delete a thread's worktree once its branch merges",
      "delete prune merged branches",
    ],
  ]),
  ...entries("storage", undefined, [
    ["Archived threads", "Delete a host's archived threads", "delete archived clear history"],
  ]),
];

function entries(
  section: SettingsSection,
  group: string | undefined,
  rows: [title: string, description: string | undefined, keywords: string][],
): SettingEntry[] {
  return rows.map(([title, description, keywords]) => ({
    section,
    group,
    title,
    description,
    keywords,
  }));
}

/** A search's hit: a section, or a setting on one, with its path and the `data-setting` to show. */
export interface SettingsResult {
  section: SettingsSection;
  title: string;
  /** Where it is, for people: "General › Notifications". */
  place: string;
  path: string;
  anchor?: string;
}

const slugOf = (id: SettingsSection) => anchorOf(settingsSections.find((s) => s.id === id)!.name);

const sectionResult = (s: (typeof settingsSections)[number]): SettingsResult => ({
  section: s.id,
  title: s.name,
  place: s.group,
  path: `/${anchorOf(s.name)}`,
});

const settingResult = (e: SettingEntry): SettingsResult => {
  const anchor = e.anchor ?? anchorOf(e.title);
  const name = settingsSections.find((s) => s.id === e.section)!.name;
  return {
    section: e.section,
    title: e.title,
    place: e.group && e.group !== e.title ? `${name} › ${e.group}` : name,
    path: `/${slugOf(e.section)}/${anchor}`,
    anchor,
  };
};

const wordsOf = (text = "") => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * Whether `a` is within `max` edits of `b`, where swapping two neighbors is one edit
 * (optimal string alignment).
 */
function near(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        row[j] = Math.min(row[j]!, before[j - 2]! + 1);
    }
    before = prev;
    prev = row;
  }
  return prev[b.length]! <= max;
}

/**
 * How well one typed word matches a field's words: 1 for a whole word, then a word's start, a
 * part of a word, and with `fuzzy`, a word with a typo (one for five letters or more, two from
 * nine).
 */
function wordScore(q: string, words: string[], fuzzy: boolean): number {
  let best = 0;
  const typos = !fuzzy ? 0 : q.length >= 9 ? 2 : q.length >= 5 ? 1 : 0;
  for (const w of words) {
    if (w === q) return 1;
    if (w.startsWith(q)) best = Math.max(best, 0.8);
    else if (q.length >= 3 && w.includes(q)) best = Math.max(best, 0.5);
    // A typo in the whole word, or in the part typed so far, as "notifcat" for "notifications".
    else if (typos && (near(q, w, typos) || near(q, w.slice(0, q.length), typos)))
      best = Math.max(best, 0.4);
  }
  return best;
}

/**
 * Scores an entry for typed words: each must match its title, keywords, group, section, or
 * description, which count in that order. 0 when one doesn't match.
 */
function score(
  query: string,
  typed: string[],
  fields: [text: string | undefined, weight: number][],
  fuzzy: boolean,
) {
  const words = fields.map(([text, weight]) => {
    const ws = wordsOf(text);
    // Run together, so "darkmode" finds "dark mode".
    return { ws: ws.length > 1 ? [...ws, ws.join("")] : ws, weight };
  });
  let total = 0;
  for (const q of typed) {
    const best = Math.max(...words.map(({ ws, weight }) => wordScore(q, ws, fuzzy) * weight));
    if (!best) return 0;
    total += best;
  }
  const title = fields[0]![0]!.toLowerCase();
  if (title.startsWith(query)) total += 5;
  else if (title.includes(query)) total += 3;
  return total;
}

/**
 * Entries matching `query`'s words, best first; ties keep the index's order. Typos count only
 * when nothing matches without them, so "clock" doesn't also find "block".
 */
function byWords(
  query: string,
  list: { result: SettingsResult; fields: [string | undefined, number][] }[],
) {
  const q = query.trim().toLowerCase();
  const typed = wordsOf(q);
  if (!typed.length) return list.map((e) => e.result);
  const ranked = (fuzzy: boolean) =>
    list
      .map((e, i) => ({ e, i, s: score(q, typed, e.fields, fuzzy) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.e.result);
  const exact = ranked(false);
  return exact.length ? exact : ranked(true);
}

const sectionFields = (s: (typeof settingsSections)[number]) => ({
  result: sectionResult(s),
  fields: [
    [s.name, 10],
    [s.keywords, 6],
    [s.group, 3],
  ] as [string | undefined, number][],
});

const settingFields = (e: SettingEntry) => ({
  result: settingResult(e),
  fields: [
    [e.title, 10],
    [e.keywords, 6],
    [e.group, 3],
    [settingsSections.find((s) => s.id === e.section)!.name, 3],
    [e.description, 2],
  ] as [string | undefined, number][],
});

/**
 * Settings matching `query`. Words find sections and settings by any word of theirs, best first.
 * A path walks them: `/` lists the sections, `/gen` those starting so, `/general/` General's
 * settings, and `/general/time` those of General's matching "time".
 */
export function searchSettings(query: string): SettingsResult[] {
  if (!query.startsWith("/"))
    return byWords(query, [
      ...settingsSections.map(sectionFields),
      ...settingsIndex.map(settingFields),
    ]);
  const [head = "", ...rest] = query.slice(1).split("/");
  if (!rest.length)
    return settingsSections
      .filter((s) => anchorOf(s.name).startsWith(head.toLowerCase()))
      .map(sectionResult);
  const section =
    settingsSections.find((s) => anchorOf(s.name) === head.toLowerCase()) ??
    settingsSections.find((s) => anchorOf(s.name).startsWith(head.toLowerCase()));
  if (!section) return [];
  const tail = rest.join(" ").replace(/-/g, " ");
  return byWords(tail, settingsIndex.filter((e) => e.section === section.id).map(settingFields));
}
