import i18next, { t } from "i18next";

import { msg } from "../../i18n";
import type { SettingsSection } from "../App";
import { commands } from "../keybindings";

/** Settings' sections in the nav's order, under their groups, with words a search for each might use. */
export const settingsSections: {
  id: SettingsSection;
  name: string;
  group: string;
  keywords?: string;
}[] = [
  { id: "general", name: msg("General"), group: msg("App"), keywords: msg("preferences basics") },
  {
    id: "appearance",
    name: msg("Appearance"),
    group: msg("App"),
    keywords: msg("look theme style display"),
  },
  {
    id: "accessibility",
    name: msg("Accessibility"),
    group: msg("App"),
    keywords: msg("a11y contrast color blind motion diff legibility vision"),
  },
  {
    id: "keybinds",
    name: msg("Keybindings"),
    group: msg("App"),
    keywords: msg("shortcuts hotkeys keyboard keybinds"),
  },
  {
    id: "providers",
    name: msg("Providers"),
    group: msg("Agents"),
    keywords: msg("agents models accounts ai"),
  },
  {
    id: "threads",
    name: msg("Threads"),
    group: msg("Agents"),
    keywords: msg("chats conversations defaults"),
  },
  {
    id: "orchestrators",
    name: msg("Orchestrators"),
    group: msg("Agents"),
    keywords: msg("autonomy children landing checks"),
  },
  {
    id: "schedules",
    name: msg("Schedules"),
    group: msg("Agents"),
    keywords: msg("cron timers automation"),
  },
  {
    id: "browser",
    name: msg("Browser"),
    group: msg("Agents"),
    keywords: msg("web chrome helium tabs pages internet"),
  },
  {
    id: "devices",
    name: msg("Devices"),
    group: msg("Agents"),
    keywords: msg("emulator simulator ios android xcode phone"),
  },
  {
    id: "computerUse",
    name: msg("Computer use"),
    group: msg("Agents"),
    keywords: msg("desktop apps mac control accessibility"),
  },
  {
    id: "projects",
    name: msg("Projects"),
    group: msg("Code"),
    keywords: msg("repositories repos per repo defaults scripts setup"),
  },
  {
    id: "sourceControl",
    name: msg("Source control"),
    group: msg("Code"),
    keywords: msg("git github pull request"),
  },
  {
    id: "worktrees",
    name: msg("Worktrees"),
    group: msg("Code"),
    keywords: msg("branch prefix base cleanup git"),
  },
  // Connections: the computers this app uses, then how this one is reached (PLX-1492). Computers
  // keeps the id the one Connections page had, so what opened that page still opens it.
  {
    id: "connections",
    name: msg("Computers"),
    group: msg("Connections"),
    keywords: msg("hosts connections ssh machines remote devices"),
  },
  {
    id: "sharing",
    name: msg("Sharing & access"),
    group: msg("Connections"),
    keywords: msg("connections reach pair access devices this computer relay"),
  },
  {
    id: "storage",
    name: msg("Storage"),
    group: msg("System"),
    keywords: msg("disk space cleanup"),
  },
  {
    id: "beta",
    name: msg("Beta"),
    group: msg("System"),
    keywords: msg("experimental preview labs early features flask tabs cards"),
  },
  {
    id: "about",
    name: msg("About"),
    group: msg("System"),
    keywords: msg("version licenses credits bug report star support ko-fi discussion feedback"),
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

/** The shown language's text to its English key, built once per language. */
let english: { language: string; of: Map<string, string> } | undefined;

/**
 * The English text `shown` was translated from, or `shown` when it isn't a translation. Pages pass
 * `anchorOf` their titles as shown, and search and the pages' fixed anchors use English.
 */
function englishOf(shown: string): string {
  const language = i18next.language;
  if (!language || language === "en") return shown;
  if (english?.language !== language) {
    const bundle: Record<string, string> = i18next.getResourceBundle(language, "translation") ?? {};
    english = { language, of: new Map(Object.entries(bundle).map(([key, text]) => [text, key])) };
  }
  return english.of.get(shown) ?? shown;
}

/**
 * A title as a `data-setting`: "Time format" → "time-format". A translated title gets its English
 * one's, so an anchor is the same in every language.
 */
export const anchorOf = (title: string) =>
  englishOf(title)
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
  ...entries("general", msg("Open"), [
    [
      msg("Open folders in"),
      msg("What Open uses"),
      msg("editor ide vscode cursor finder explorer default app"),
    ],
    [
      msg("Terminal"),
      msg("The terminal used to open folders"),
      msg("ghostty iterm alacritty warp kitty shell console"),
    ],
    [
      msg("Terminal command"),
      msg("Type parallax in a terminal to open Parallax there"),
      msg("cli path shell install"),
    ],
  ]),
  ...entries("general", msg("Notifications"), [
    [
      msg("System notifications"),
      msg("An alert from your computer when a thread finishes, fails, or needs you"),
      msg("alerts notify os banner sound"),
    ],
    [
      msg("In-app notifications"),
      msg("A toast when a thread finishes, fails, or needs you"),
      msg("alerts toast popup"),
    ],
  ]),
  ...entries("general", msg("Preferences"), [
    [
      msg("Time format"),
      msg("System default follows your OS clock"),
      msg("clock 12-hour 24-hour am pm hours"),
    ],
    [
      msg("Send shortcut"),
      msg("What sends a message, and what starts a new line"),
      msg("enter submit cmd ctrl newline keyboard"),
    ],
  ]),
  ...entries("general", msg("Updates"), [
    [
      msg("Download updates automatically"),
      msg("Download a new Parallax release as soon as it's out"),
      msg("auto update upgrade release"),
    ],
    [
      msg("Check for provider updates"),
      msg("Check Claude Code and Codex for new releases"),
      msg("claude codex cli version"),
    ],
    [
      msg("Update providers automatically"),
      msg("Update Claude Code and Codex when a release is found"),
      msg("auto upgrade claude codex"),
    ],
  ]),
  // Threads
  ...entries("threads", msg("New threads"), [
    [
      msg("Computer"),
      msg("The computer a new thread starts on"),
      msg("host machine remote ssh device default"),
    ],
    [
      msg("Model"),
      msg("The model a new thread starts on"),
      msg("default model claude gpt opus sonnet codex"),
    ],
    [
      msg("Reasoning"),
      msg("How hard it thinks, its context window, and fast mode"),
      msg("effort thinking context window fast mode"),
    ],
    [
      msg("Permissions"),
      msg("What a new thread may do without asking"),
      msg("access approve ask sandbox edit yolo full"),
    ],
    [msg("Legacy Plan mode"), msg("List Plan in the Access picker"), msg("plan access picker")],
  ]),
  ...entries("threads", msg("Text generation"), [
    [
      msg("Naming model"),
      msg("Names a new thread and its branch"),
      msg("title rename branch name auto"),
    ],
    [
      msg("Thread title instructions"),
      msg("Added to the prompt that names a new thread"),
      msg("title naming prompt custom rules rename"),
    ],
    [
      msg("Response streaming"),
      msg("When a reply's text appears while the agent writes it"),
      msg("stream paragraphs wait full response typing live text"),
    ],
  ]),
  ...entries("threads", msg("Resuming threads"), [
    [
      msg("Resume after a usage limit"),
      msg("Continue once the limit resets"),
      msg("rate limit auto resume quota retry"),
    ],
    [
      msg("Continue threads after restarts"),
      msg("Continue after plxd restarts"),
      msg("restart plxd update crash interrupted"),
    ],
  ]),
  ...entries("threads", msg("Import"), [
    [
      msg("Import sessions"),
      msg("Continue Claude, Codex, and Cursor sessions as threads"),
      msg("import history past migrate desktop app claude codex cursor chats remote control rc"),
    ],
    [
      msg("Import chats"),
      msg("Bring in chats from a ChatGPT or Claude export"),
      msg("import chatgpt openai claude.ai export zip conversations history"),
    ],
  ]),
  // Appearance
  ...entries("appearance", msg("Theme"), [
    [
      msg("Color scheme"),
      msg("Which theme shows. System follows your OS"),
      msg("dark mode light mode night system theme"),
    ],
    [msg("Light theme"), msg("Shown in light mode"), msg("theme colors vs code")],
    [msg("Dark theme"), msg("Shown in dark mode"), msg("theme colors vs code")],
    [
      msg("Installed themes"),
      msg("VS Code themes from Open VSX"),
      msg("open vsx vscode extensions add theme"),
    ],
  ]),
  ...entries("appearance", undefined, [
    [
      msg("Colors"),
      msg("Change the shown theme's colors"),
      msg("accent palette custom json customize"),
    ],
  ]),
  ...entries("appearance", msg("Window"), [
    [
      msg("Background"),
      msg("Clear or blurred, where the desktop shows through"),
      msg("transparent blur vibrancy opaque frosted glass"),
    ],
    [
      msg("Background opacity"),
      msg("How much of the theme covers what shows through"),
      msg("transparency translucent"),
    ],
  ]),
  ...entries("appearance", msg("Text"), [
    [
      msg("Interface font"),
      msg("Menus, chat, and everything outside code"),
      msg("font family size typography ui"),
    ],
    [
      msg("Code font"),
      msg("Code blocks, diffs, file previews, and the terminal"),
      msg("monospace mono font size typography terminal"),
    ],
    [msg("Word wrap"), msg("Wrap long lines in code by default"), msg("wrap lines long")],
  ]),
  ...entries("appearance", msg("Chat"), [
    [
      msg("Rich text composer"),
      msg("Format Markdown as you type"),
      msg("markdown formatting plain prompt box editor bold lists"),
    ],
    [
      msg("Render math"),
      msg("Typeset LaTeX in messages"),
      msg("latex katex tex equations formulas"),
    ],
    [
      msg("Tool calls"),
      msg("The commands, edits, and searches a thread shows"),
      msg("zen hide successful failed thinking activity work steps focus quiet"),
    ],
  ]),
  ...entries("appearance", msg("Sidebar"), [
    [
      msg("Layout"),
      msg("Inbox, by activity, or Traditional, in a folder per repo"),
      msg("sidebar inbox traditional classic beta folders repos group nav pinned projects"),
    ],
    [msg("Projects"), msg("In the sidebar's head, or under More"), msg("sidebar nav pages edit")],
    [
      msg("Pull requests"),
      msg("In the sidebar's head, or under More"),
      msg("sidebar nav pages edit prs"),
    ],
    [
      msg("Usage"),
      msg("In the sidebar's head, or under More"),
      msg("sidebar nav pages edit limits"),
    ],
    [
      msg("Working section"),
      msg("List working threads under Working"),
      msg("sidebar running active busy list"),
    ],
    [
      msg("Archive pages"),
      msg("Show archived threads a page at a time"),
      msg("archived show more pagination"),
    ],
  ]),
  // Browser (PLX-974)
  ...entries("browser", msg("Appearance"), [
    [
      msg("Theme"),
      msg("Parallax's own colors, or Helium's and Chrome's"),
      msg("color colour palette dark light"),
    ],
    [
      msg("Show bookmarks bar"),
      msg("Under the toolbar, while there are bookmarks"),
      msg("favorites"),
    ],
    [msg("Page size"), msg("Desktop lays a page out as on a monitor"), msg("zoom fit monitor")],
  ]),
  ...entries("browser", msg("Search engine"), [
    [
      msg("Search engine"),
      msg("What the address bar searches with"),
      msg("google duckduckgo bing brave kagi"),
    ],
  ]),
  ...entries("browser", msg("On startup"), [
    [
      msg("Continue where you left off"),
      msg("Each side panel opens the browser tabs it had"),
      msg("restore session tabs"),
    ],
  ]),
  ...entries("browser", msg("Home button"), [
    [msg("Show home button"), msg("In the toolbar, beside Reload"), msg("homepage")],
    [msg("Home page"), msg("Empty opens a new tab"), msg("homepage start page url")],
  ]),
  ...entries("browser", msg("Downloads"), [
    [msg("Location"), msg("Where downloads go"), msg("downloads folder save path")],
    [
      msg("Ask where to save each file before downloading"),
      msg("Off, each file goes straight to the location"),
      msg("downloads save dialog prompt"),
    ],
  ]),
  ...entries("browser", msg("Privacy"), [
    [
      msg("Clear browsing data"),
      msg("Browsing history, cookies and other site data, cached images and files"),
      msg("cache cookies history delete privacy"),
    ],
  ]),
  ...entries("browser", undefined, [
    [
      msg("Extensions"),
      msg("Installed extensions, and Load unpacked"),
      msg("chrome web store add-ons plugins load unpacked"),
    ],
  ]),
  // Keybindings
  ...entries("keybinds", undefined, [
    [
      msg("Shortcuts"),
      msg("Shortcuts for the whole app"),
      msg("hotkeys keyboard bindings rebind reset"),
    ],
  ]),
  ...commands.map((c): SettingEntry => ({
    section: "keybinds",
    group: c.category,
    title: c.name,
    keywords: msg("shortcut keybind hotkey"),
  })),
  ...entries("keybinds", msg("Built in"), [
    [msg("Open a sidebar row"), msg("The first nine threads in the sidebar"), msg("number jump")],
    [msg("Send a message"), undefined, msg("enter submit")],
    [msg("Steer an agent now"), undefined, msg("interrupt")],
    [msg("Start a new thread and stay here"), undefined, msg("background")],
    [msg("New line in a message"), undefined, msg("newline shift enter")],
  ]),
  // Providers
  ...entries("providers", undefined, [
    [
      msg("Status"),
      msg("Sign in to a provider, or re-authenticate"),
      msg("account sign in login authenticate reauthenticate subscription plan install"),
    ],
    [msg("Display name"), msg("How threads and model menus name a provider"), msg("rename")],
    [msg("Labels"), msg("Tags to tell your providers apart"), msg("tag filter group")],
    [msg("Binary path"), msg("The binary a provider runs"), msg("program executable path cli")],
    [msg("Launch arguments"), msg("Arguments passed on session start"), msg("args flags cli")],
    [
      msg("Environment"),
      msg("API keys, base URLs, and other variables"),
      msg("env variables api key base url secret"),
    ],
    [msg("Models"), msg("The models a provider offers"), msg("custom model add model")],
    [
      msg("Hubs"),
      msg("Run Claude Code and Codex through a CLIProxyAPI hub"),
      msg("cliproxyapi proxy accounts"),
    ],
    [
      msg("Link providers across computers"),
      msg("Use the same providers on every computer"),
      msg("sync share same hosts machines"),
    ],
  ]),
  {
    section: "providers",
    title: msg("API keys"),
    description: msg("Keys kept in the host's keychain"),
    keywords: msg("anthropic openai key"),
    // Claude Code's pane is the one shown first.
    anchor: "anthropic-api-keys",
  },
  // Usage, Schedules, Source control
  ...entries("schedules", undefined, [
    [
      msg("Scheduled tasks"),
      msg("Prompts on a timer or webhook"),
      msg("cron timer webhook recurring automation pause"),
    ],
  ]),
  ...entries("sourceControl", undefined, [
    [
      msg("Hosting"),
      msg("The GitHub CLI on each host"),
      msg("github gh cli pull requests sign in git"),
    ],
  ]),
  ...entries("computerUse", undefined, [
    [
      msg("Permissions"),
      msg("Accessibility and Screen Recording for plxd"),
      msg("accessibility screen recording privacy macos grant"),
    ],
    [
      msg("Always allowed"),
      msg("Apps every thread may use without asking"),
      msg("apps allow remove"),
    ],
  ]),
  ...entries("projects", undefined, [
    [
      msg("Project icon"),
      msg("The icon the sidebar shows"),
      msg("image logo glyph color picture upload"),
    ],
    [
      msg("New thread defaults"),
      msg("A repository's own model, reasoning, permissions, workspace, and base branch"),
      msg("per repo model effort permission workspace base branch override"),
    ],
    [
      msg("Scripts"),
      msg("Setup and settle scripts in a thread's worktree"),
      msg("setup settle worktree commands"),
    ],
    [
      msg("From parallax.json"),
      msg("Scripts a repository defines"),
      msg("parallax json import config"),
    ],
    ["Git", msg("A repository's remote, and its current and default branches"), msg("origin url")],
    [
      msg("Instructions"),
      msg("What every thread in a Project is told"),
      msg("project system prompt"),
    ],
  ]),
  ...entries("worktrees", msg("New worktrees"), [
    [
      msg("Workspace"),
      msg("Where a thread in a repository works"),
      msg("checkout current default"),
    ],
    [
      msg("Start from"),
      msg("The branch a new worktree starts from"),
      msg("base default current origin"),
    ],
  ]),
  ...entries("worktrees", msg("Branches"), [
    [
      msg("Branch prefix"),
      msg("What a new thread's branch starts with"),
      msg("name parallax namespace"),
    ],
  ]),
  ...entries("worktrees", msg("Cleanup"), [
    [
      msg("Delete worktrees with deleted threads"),
      msg("Whether deleting a thread deletes its worktree and branch"),
      msg("remove keep on disk"),
    ],
    [
      msg("Delete merged worktrees"),
      msg("Delete a worktree and branch once its pull request merges"),
      msg("remove clean up"),
    ],
    [
      msg("Delete inactive worktrees"),
      msg("Delete a worktree once its thread has had no activity for a number of days"),
      msg("remove old stale unused idle days retention disk space"),
    ],
    [
      msg("Delete archived worktrees"),
      msg("Delete an archived thread's worktree folder, keeping the thread and branch"),
      msg("remove archive days retention disk space"),
    ],
    [
      msg("Delete unchanged worktrees"),
      msg("Delete a worktree with no commits beyond the default branch"),
      msg("remove empty untouched advanced"),
    ],
    [
      msg("Keep worktrees with"),
      msg("Which local files stop a rule from deleting a worktree"),
      msg("local changes uncommitted untracked ignored env node_modules advanced"),
    ],
  ]),
  ...entries("sourceControl", msg("Pull requests"), [
    [
      msg("Open pull requests in"),
      msg("Your system browser, or the side panel's"),
      msg("browser github pr links"),
    ],
    [msg("Click a pull request link to"), msg("Open it in Parallax, or on GitHub"), msg("pr link")],
    [msg("Merge method"), msg("What the merge box starts on"), msg("squash rebase merge commit")],
    [msg("Delete branch on merge"), msg("Whether a merge deletes the branch"), msg("cleanup")],
  ]),
  ...entries("orchestrators", msg("New orchestrators"), [
    [
      msg("Full access"),
      msg("A new orchestrator starts with full access"),
      msg("bypass permission"),
    ],
    [msg("Autonomy"), msg("Who answers a new orchestrator's questions"), msg("ask routine full")],
  ]),
  ...entries("orchestrators", undefined, [
    [msg("Base branch"), msg("What its integration branch is cut from"), msg("integration target")],
    [
      msg("Land automatically"),
      msg("Its children land without your approval"),
      msg("auto land merge"),
    ],
    [
      msg("Children at once"),
      msg("How many of its children run together"),
      msg("max parallel concurrency"),
    ],
    [msg("Allow API keys"), msg("Whether its children may run on an API key"), msg("account")],
    [msg("Checks"), msg("The command run after each landing"), msg("test ci verify")],
  ]),
  ...entries("devices", undefined, [
    [msg("Device hub"), msg("What streams a device to the Device panel"), msg("install setup")],
    [msg("Agents can use devices"), msg("Agents open and drive these devices"), msg("tools")],
    [
      msg("Local simulators"),
      msg("Whether this computer can run them"),
      msg("ios android xcode iphone simctl studio sdk adb avd emulators apple"),
    ],
    [
      msg("Simulators and emulators"),
      msg("The devices on this computer"),
      msg("boot start stop power"),
    ],
  ]),
  ...entries("about", undefined, [
    [msg("Version"), msg("This copy of Parallax, to copy"), msg("about build release number")],
    [
      msg("Check for updates"),
      msg("Ask now whether a newer Parallax is out"),
      msg("updater upgrade download install latest new version release"),
    ],
    [
      msg("Get involved"),
      msg("Report a bug, share an idea, star the repo, or support on Ko-fi"),
      msg("feedback issue discussion github kofi donate"),
    ],
    [
      msg("This computer"),
      msg("The plxd, Electron, and Chromium this copy runs on"),
      msg("operating system os"),
    ],
    [
      msg("Open source"),
      msg("Parallax's license and source code"),
      msg("apache repository github"),
    ],
    [
      msg("Licenses and credits"),
      msg("The code, fonts, logos, and models Parallax uses"),
      msg("third party notices legal attribution dependencies"),
    ],
  ]),
  ...entries("accessibility", msg("Vision"), [
    [msg("Contrast"), msg("Stronger text and borders"), msg("high contrast")],
    [msg("Interface text size"), msg("How large the app's text is"), msg("font zoom big small")],
    [
      msg("Focus rings"),
      msg("A thicker outline on what has keyboard focus"),
      msg("keyboard navigation outline"),
    ],
    [msg("Underline links"), msg("Links stay underlined"), msg("color")],
  ]),
  ...entries("accessibility", msg("Motion"), [
    [msg("Reduce motion"), msg("Stops animations"), msg("animation vestibular")],
  ]),
  ...entries("accessibility", msg("Diffs"), [
    [
      msg("Diff colors"),
      msg("What marks added and removed lines"),
      msg("red green blue orange color blind custom"),
    ],
    [
      msg("Line tint"),
      msg("How strongly a changed line's background shows"),
      msg("intensity contrast legibility"),
    ],
  ]),
  // Computers (PLX-1492). Titles that aren't on the page any more, such as SSH hosts, still find
  // the card that holds them.
  ...[
    [
      msg("Add computer"),
      msg("With Parallax Connect, on this network, or over SSH"),
      msg("add computer devices hosts machines new"),
    ],
    [
      msg("Computers on this network"),
      msg("Pair a computer with a code"),
      msg("lan nearby devices pair computer"),
    ],
    [
      msg("SSH hosts"),
      msg("Machines you reach over SSH"),
      msg("ssh remote server add host install plxd"),
    ],
    [
      msg("Routes"),
      msg("How this app reaches a computer"),
      msg("route address order reorder drag relay tailscale network"),
    ],
    [
      msg("Agents can work on a computer"),
      msg("In each computer's card, opened"),
      msg("agent work delegate remote peer other computer showing access for"),
    ],
  ].map(([title, description, keywords]) => ({
    section: "connections" as const,
    title: title!,
    description,
    keywords,
    anchor: "computers",
  })),
  ...entries("connections", undefined, [
    [
      msg("Load Balancer"),
      msg("Start new threads on the computer with the most room"),
      msg("auto balance load busy cpu memory new thread computers weight prefer"),
    ],
  ]),
  // Sharing & access (PLX-1492): how this computer is reached, and the devices that reach it.
  ...entries("sharing", undefined, [
    [msg("This computer"), msg("Its name and icon"), msg("rename computer name local icon")],
    [
      "Parallax Connect",
      msg("Reach this computer from anywhere"),
      msg("relay reach from anywhere internet remote account check connection"),
    ],
    [
      msg("Setup code"),
      msg("A code for another computer that's adding this one"),
      msg("show setup code add this computer account"),
    ],
    [
      "SSH",
      msg("How another computer adds this one over SSH"),
      msg("ssh remote login sshd server"),
    ],
    [
      msg("Pair on this network"),
      msg("With a one-time code, no account needed"),
      msg("lan pair wifi same network local pair computers"),
    ],
    [
      msg("Open in a browser"),
      msg("Use Parallax from a browser on this network"),
      msg("web phone mobile certificate"),
    ],
    [
      msg("Agents can work here"),
      msg("Agents on your other computers can run commands on this one"),
      msg("agent work delegate remote peer"),
    ],
    [
      msg("Devices with access"),
      msg("What's paired with or signed in to this computer"),
      msg("revoke read-only phone browser paired sessions"),
    ],
    [
      msg("Version"),
      msg("The installed Parallax version"),
      msg("daemon status version plxd update"),
    ],
  ]),
  {
    section: "sharing",
    title: msg("Reach from anywhere"),
    description: "Parallax Connect",
    keywords: msg("relay internet remote"),
    anchor: "parallax-connect",
  },
  {
    section: "sharing",
    title: msg("Same network"),
    description: msg("Pair on this network"),
    keywords: msg("lan local network wifi"),
    anchor: "pair-on-this-network",
  },
  ...entries("sharing", msg("Devices with access"), [
    [msg("Pair a device"), msg("With a pairing code"), msg("pairing code phone")],
  ]),
  // Storage
  ...entries("storage", undefined, [
    [
      msg("On this computer"),
      msg("What Parallax keeps, and its size"),
      msg("disk space size cache logs"),
    ],
  ]),
  ...entries("storage", undefined, [
    [
      msg("Archived threads"),
      msg("Delete a host's archived threads"),
      msg("delete archived clear history"),
    ],
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

// Letters and digits in any script, so a search in the app's language finds its words.
const wordsOf = (text = "") => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

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

/**
 * A section as search sees it: its name as shown, then in English, so a search in either language
 * finds it.
 */
const sectionFields = (s: (typeof settingsSections)[number]): Searchable => ({
  result: { section: s.id, title: t(s.name) },
  fields: [
    [t(s.name), 10],
    [s.name, 10],
    [s.keywords && t(s.keywords), 6],
    [s.keywords, 6],
  ],
});

/**
 * A setting as search sees it, shown in the app's language. Its title and group are the ones its
 * page shows, so `t` finds them there. Its anchor stays the English title's.
 */
const settingFields = (e: SettingEntry): Searchable => {
  const name = settingsSections.find((s) => s.id === e.section)!.name;
  return {
    result: {
      section: e.section,
      title: t(e.title),
      place: e.group && e.group !== e.title ? `${t(name)} › ${t(e.group)}` : t(name),
      anchor: e.anchor ?? anchorOf(e.title),
    },
    fields: [
      [t(e.title), 10],
      [e.title, 10],
      [e.keywords && t(e.keywords), 6],
      [e.keywords, 6],
      [e.group && t(e.group), 3],
      [e.group, 3],
      [t(name), 3],
      [name, 3],
      [e.description && t(e.description), 2],
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
