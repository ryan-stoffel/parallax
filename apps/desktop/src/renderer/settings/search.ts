import type { SettingsSection } from "../App";
import { commands } from "../keybindings";

/** Settings' sections in the nav's order, under their groups, with words a search for each might use. */
export const settingsSections: {
  id: SettingsSection;
  name: string;
  group: string;
  keywords?: string;
}[] = [
  { id: "general", name: "General", group: "App", keywords: "preferences basics" },
  { id: "appearance", name: "Appearance", group: "App", keywords: "look theme style display" },
  {
    id: "accessibility",
    name: "Accessibility",
    group: "App",
    keywords: "a11y contrast color blind motion diff legibility vision",
  },
  {
    id: "keybinds",
    name: "Keybindings",
    group: "App",
    keywords: "shortcuts hotkeys keyboard keybinds",
  },
  { id: "providers", name: "Providers", group: "Agents", keywords: "agents models accounts ai" },
  { id: "threads", name: "Threads", group: "Agents", keywords: "chats conversations defaults" },
  {
    id: "orchestrators",
    name: "Orchestrators",
    group: "Agents",
    keywords: "autonomy children landing checks",
  },
  { id: "schedules", name: "Schedules", group: "Agents", keywords: "cron timers automation" },
  {
    id: "browser",
    name: "Browser",
    group: "Agents",
    keywords: "web chrome helium tabs pages internet",
  },
  {
    id: "devices",
    name: "Devices",
    group: "Agents",
    keywords: "emulator simulator ios android xcode phone",
  },
  {
    id: "computerUse",
    name: "Computer use",
    group: "Agents",
    keywords: "desktop apps mac control accessibility",
  },
  {
    id: "projects",
    name: "Projects",
    group: "Code",
    keywords: "repositories repos per repo defaults scripts setup",
  },
  {
    id: "sourceControl",
    name: "Source control",
    group: "Code",
    keywords: "git github pull request",
  },
  { id: "worktrees", name: "Worktrees", group: "Code", keywords: "branch prefix base cleanup git" },
  { id: "connections", name: "Connections", group: "System", keywords: "hosts computers ssh" },
  { id: "storage", name: "Storage", group: "System", keywords: "disk space cleanup" },
  {
    id: "beta",
    name: "Beta",
    group: "System",
    keywords: "experimental preview labs early features flask tabs cards",
  },
  {
    id: "about",
    name: "About",
    group: "System",
    keywords: "version licenses credits bug report star support ko-fi discussion feedback",
  },
];

/**
 * One setting a search can find. `title` is its row's or section's title on its page, whose
 * `data-setting` is `anchorOf(title)`, unless `anchor` names another.
 */
interface SettingEntry {
  section: SettingsSection;
  title: string;
  group?: string;
  description?: string;
  keywords?: string;
  anchor?: string;
}

/** A title as a `data-setting`: "Time format" → "time-format". */
export const anchorOf = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Every setting, by page, in the nav's order, which breaks ties in search. Keep in step with the
 * pages: Settings.test.tsx checks those on General, Threads, Appearance, Accessibility, Browser,
 * and Keybindings render.
 */
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
  // Threads
  ...entries("threads", "New threads", [
    ["Computer", "The computer a new thread starts on", "host machine remote ssh device default"],
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
  ]),
  ...entries("threads", "Text generation", [
    ["Naming model", "Names a new thread and its branch", "title rename branch name auto"],
    [
      "Thread title instructions",
      "Added to the prompt that names a new thread",
      "title naming prompt custom rules rename",
    ],
    [
      "Response streaming",
      "When a reply's text appears while the agent writes it",
      "stream paragraphs wait full response typing live text",
    ],
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
  ...entries("threads", "Import", [
    [
      "Import sessions",
      "Continue Claude, Codex, and Cursor sessions as threads",
      "import history past migrate desktop app claude codex cursor chats remote control rc",
    ],
    [
      "Import chats",
      "Bring in chats from a ChatGPT or Claude export",
      "import chatgpt openai claude.ai export zip conversations history",
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
  ...entries("appearance", "Chat", [
    [
      "Rich text composer",
      "Format Markdown as you type",
      "markdown formatting plain prompt box editor bold lists",
    ],
    ["Render math", "Typeset LaTeX in messages", "latex katex tex equations formulas"],
    [
      "Tool calls",
      "The commands, edits, and searches a thread shows",
      "zen hide successful failed thinking activity work steps focus quiet",
    ],
  ]),
  ...entries("appearance", "Sidebar", [
    [
      "Layout",
      "Inbox, by activity, or Traditional, in a folder per repo",
      "sidebar inbox traditional classic beta folders repos group nav pinned projects",
    ],
    ["Projects", "In the sidebar's head, or under More", "sidebar nav pages edit"],
    ["Pull requests", "In the sidebar's head, or under More", "sidebar nav pages edit prs"],
    ["Usage", "In the sidebar's head, or under More", "sidebar nav pages edit limits"],
    ["Working section", "List working threads under Working", "sidebar running active busy list"],
    ["Archive pages", "Show archived threads a page at a time", "archived show more pagination"],
  ]),
  // Browser (PLX-974)
  ...entries("browser", "Appearance", [
    ["Theme", "Parallax's own colors, or Helium's and Chrome's", "color colour palette dark light"],
    ["Show bookmarks bar", "Under the toolbar, while there are bookmarks", "favorites"],
    ["Page size", "Desktop lays a page out as on a monitor", "zoom fit monitor"],
  ]),
  ...entries("browser", "Search engine", [
    ["Search engine", "What the address bar searches with", "google duckduckgo bing brave kagi"],
  ]),
  ...entries("browser", "On startup", [
    [
      "Continue where you left off",
      "Each side panel opens the browser tabs it had",
      "restore session tabs",
    ],
  ]),
  ...entries("browser", "Home button", [
    ["Show home button", "In the toolbar, beside Reload", "homepage"],
    ["Home page", "Empty opens a new tab", "homepage start page url"],
  ]),
  ...entries("browser", "Downloads", [
    ["Location", "Where downloads go", "downloads folder save path"],
    [
      "Ask where to save each file before downloading",
      "Off, each file goes straight to the location",
      "downloads save dialog prompt",
    ],
  ]),
  ...entries("browser", "Privacy", [
    [
      "Clear browsing data",
      "Browsing history, cookies and other site data, cached images and files",
      "cache cookies history delete privacy",
    ],
  ]),
  ...entries("browser", undefined, [
    [
      "Extensions",
      "Installed extensions, and Load unpacked",
      "chrome web store add-ons plugins load unpacked",
    ],
  ]),
  // Keybindings
  ...entries("keybinds", undefined, [
    ["Shortcuts", "Shortcuts for the whole app", "hotkeys keyboard bindings rebind reset"],
  ]),
  ...commands.map((c): SettingEntry => ({
    section: "keybinds",
    group: c.category,
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
    [
      "Status",
      "Sign in to a provider, or re-authenticate",
      "account sign in login authenticate reauthenticate subscription plan install",
    ],
    ["Display name", "How threads and model menus name a provider", "rename"],
    ["Labels", "Tags to tell your providers apart", "tag filter group"],
    ["Binary path", "The binary a provider runs", "program executable path cli"],
    ["Launch arguments", "Arguments passed on session start", "args flags cli"],
    [
      "Environment",
      "API keys, base URLs, and other variables",
      "env variables api key base url secret",
    ],
    ["Models", "The models a provider offers", "custom model add model"],
    ["Hubs", "Run Claude Code and Codex through a CLIProxyAPI hub", "cliproxyapi proxy accounts"],
    [
      "Link providers across computers",
      "Use the same providers on every computer",
      "sync share same hosts machines",
    ],
  ]),
  {
    section: "providers",
    title: "API keys",
    description: "Keys kept in the host's keychain",
    keywords: "anthropic openai key",
    // Claude Code's pane is the one shown first.
    anchor: "anthropic-api-keys",
  },
  // Usage, Schedules, Source control
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
  ...entries("computerUse", undefined, [
    [
      "Permissions",
      "Accessibility and Screen Recording for plxd",
      "accessibility screen recording privacy macos grant",
    ],
    ["Always allowed", "Apps every thread may use without asking", "apps allow remove"],
  ]),
  ...entries("projects", undefined, [
    ["Project icon", "The icon the sidebar shows", "image logo glyph color picture upload"],
    [
      "New thread defaults",
      "A repository's own model, reasoning, permissions, workspace, and base branch",
      "per repo model effort permission workspace base branch override",
    ],
    [
      "Scripts",
      "Setup and settle scripts in a thread's worktree",
      "setup settle worktree commands",
    ],
    ["From parallax.json", "Scripts a repository defines", "parallax json import config"],
    ["Git", "A repository's remote, and its current and default branches", "origin url"],
    ["Instructions", "What every thread in a Project is told", "project system prompt"],
  ]),
  ...entries("worktrees", "New worktrees", [
    ["Workspace", "Where a thread in a repository works", "checkout current default"],
    ["Start from", "The branch a new worktree starts from", "base default current origin"],
    ["Branch prefix", "What a new thread's branch starts with", "name parallax namespace"],
  ]),
  ...entries("worktrees", "Cleanup", [
    [
      "Clean up merged worktrees",
      "Delete a worktree and branch once its pull request merges",
      "remove",
    ],
  ]),
  ...entries("sourceControl", "Pull requests", [
    [
      "Open pull requests in",
      "Your system browser, or the side panel's",
      "browser github pr links",
    ],
    ["Click a pull request link to", "Open it in Parallax, or on GitHub", "pr link"],
    ["Merge method", "What the merge box starts on", "squash rebase merge commit"],
    ["Delete branch on merge", "Whether a merge deletes the branch", "cleanup"],
  ]),
  ...entries("orchestrators", "New orchestrators", [
    ["Full access", "A new orchestrator starts with full access", "bypass permission"],
    ["Autonomy", "Who answers a new orchestrator's questions", "ask routine full"],
  ]),
  ...entries("orchestrators", undefined, [
    ["Base branch", "What its integration branch is cut from", "integration target"],
    ["Land automatically", "Its children land without your approval", "auto land merge"],
    ["Children at once", "How many of its children run together", "max parallel concurrency"],
    ["Allow API keys", "Whether its children may run on an API key", "account"],
    ["Checks", "The command run after each landing", "test ci verify"],
  ]),
  ...entries("devices", undefined, [
    ["Device hub", "What streams a device to the Device panel", "install setup"],
    ["Agents can use devices", "Agents open and drive these devices", "tools"],
    [
      "Local simulators",
      "Whether this computer can run them",
      "ios android xcode iphone simctl studio sdk adb avd emulators apple",
    ],
    ["Simulators and emulators", "The devices on this computer", "boot start stop power"],
  ]),
  ...entries("about", undefined, [
    ["Version", "This copy of Parallax, to copy", "about build release number"],
    [
      "Check for updates",
      "Ask now whether a newer Parallax is out",
      "updater upgrade download install latest new version release",
    ],
    [
      "Get involved",
      "Report a bug, share an idea, star the repo, or support on Ko-fi",
      "feedback issue discussion github kofi donate",
    ],
    ["This computer", "The plxd, Electron, and Chromium this copy runs on", "operating system os"],
    ["Open source", "Parallax's license and source code", "apache repository github"],
    [
      "Licenses and credits",
      "The code, fonts, logos, and models Parallax uses",
      "third party notices legal attribution dependencies",
    ],
  ]),
  ...entries("accessibility", "Vision", [
    ["Contrast", "Stronger text and borders", "high contrast"],
    ["Interface text size", "How large the app's text is", "font zoom big small"],
    ["Focus rings", "A thicker outline on what has keyboard focus", "keyboard navigation outline"],
    ["Underline links", "Links stay underlined", "color"],
  ]),
  ...entries("accessibility", "Motion", [
    ["Reduce motion", "Stops animations", "animation vestibular"],
  ]),
  ...entries("accessibility", "Diffs", [
    [
      "Diff colors",
      "What marks added and removed lines",
      "red green blue orange color blind custom",
    ],
    [
      "Line tint",
      "How strongly a changed line's background shows",
      "intensity contrast legibility",
    ],
  ]),
  // Connections
  ...entries("connections", "Parallax Connect", [
    [
      "Parallax Connect",
      "Your computers, wherever they are",
      "add computer relay remote devices account sync setup code",
    ],
    ["This computer", "Its name and plxd", "rename computer name local daemon status version plxd"],
  ]),
  ...entries("connections", "Reach from anywhere", [
    ["Reach from anywhere", "Through Parallax Relay", "relay internet remote"],
    ["Tailscale", "Find computers on your Tailscale network", "tailnet vpn"],
  ]),
  ...entries("connections", undefined, [
    [
      "Agents can work here",
      "Agents on your other computers can run commands on the ones you turn on",
      "agent work delegate remote peer",
    ],
    [
      "Load Balancer",
      "Start new threads on the computer with the most room",
      "auto balance load busy cpu memory new thread computers",
    ],
  ]),
  ...entries("connections", "Same network", [
    ["Same network", "Pair computers on this network", "lan local network wifi"],
    ["Pair computers on this network", undefined, "lan pair wifi"],
    [
      "Open in a browser",
      "Use Parallax from a browser on this network",
      "web phone mobile certificate",
    ],
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

/** A search's hit: a section, or a setting on one with the `data-setting` to show. */
interface SettingsResult {
  section: SettingsSection;
  title: string;
  /** Where a setting is, for people: "General › Preferences". None for a section. */
  place?: string;
  anchor?: string;
}

/** A section or setting as search sees it: its result, and its fields with their weights. */
type Searchable = { result: SettingsResult; fields: [text: string | undefined, weight: number][] };

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
function score(query: string, typed: string[], fields: Searchable["fields"], fuzzy: boolean) {
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
function byWords(query: string, list: Searchable[]) {
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

const sectionFields = (s: (typeof settingsSections)[number]): Searchable => ({
  result: { section: s.id, title: s.name },
  fields: [
    [s.name, 10],
    [s.keywords, 6],
  ],
});

const settingFields = (e: SettingEntry): Searchable => {
  const name = settingsSections.find((s) => s.id === e.section)!.name;
  return {
    result: {
      section: e.section,
      title: e.title,
      place: e.group && e.group !== e.title ? `${name} › ${e.group}` : name,
      anchor: e.anchor ?? anchorOf(e.title),
    },
    fields: [
      [e.title, 10],
      [e.keywords, 6],
      [e.group, 3],
      [name, 3],
      [e.description, 2],
    ],
  };
};

/**
 * Sections and settings matching `query`, best first: each typed word must match a word of
 * theirs, so "general" finds General and "clock" finds Time format.
 */
export const searchSettings = (query: string): SettingsResult[] =>
  byWords(query, [...settingsSections.map(sectionFields), ...settingsIndex.map(settingFields)]);
