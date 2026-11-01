// The `window.parallax` contract. The preload implements it and the renderer types
// against it, so it must not import anything from Node or Electron.
import type {
  Capabilities,
  CliKind,
  DeviceStreamParams,
  ErrorData,
  EventsEventParams,
  EventsSubscribeParams,
  LogId,
  ShellSnapshot,
  ThreadSnapshot,
  ParallaxRequests,
  ProviderKind,
  RelayHost,
  RemoteSessionsResult,
} from "../protocol/generated/protocol";

/** The Appearance setting: follow the OS, or force a theme. */
export const THEME_PREFERENCES = ["system", "dark", "light"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** An editor or IDE that Open can find on this computer (editors.ts). */
export type Editor =
  | "vscode"
  | "vscodeInsiders"
  | "vscodium"
  | "cursor"
  | "windsurf"
  | "zed"
  | "sublime"
  | "nova"
  | "xcode"
  | "intellij"
  | "webstorm"
  | "pycharm"
  | "goland"
  | "rustrover"
  | "clion"
  | "phpstorm"
  | "rider"
  | "rubymine"
  | "androidStudio"
  | "fleet";
/**
 * Where Open opens a folder: an editor, the OS's file manager, or the terminal app chosen in
 * Settings.
 */
export type OpenTarget = Editor | "files" | "terminal";
/** An Open target found on this computer, its name for people, and its app icon as a data URL. */
export type OpenApp = { target: OpenTarget; name: string; icon?: string };
/**
 * The `parallax` command at `path`: this app's (`installed`), one for a plxd that moved or changed
 * (`stale`), none (`missing`), something else named `parallax` (`other`), or none to offer from
 * this app (`unavailable`): a dev build, or one run from its disk image.
 */
export type CommandStatus = {
  state: "installed" | "stale" | "missing" | "other" | "unavailable";
  path: string;
  /** Whether its folder is on PATH. False on Linux until the session puts `~/.local/bin` there. */
  onPath: boolean;
};

/** An installed terminal app, its name for people, and its app icon as a data URL. */
export type TerminalApp = { path: string; name: string; icon?: string };

/**
 * The variable a provider instance's `home` sets, for the kinds that have one: Settings labels the
 * field with it, and a sign-in runs with it, so it signs in to that home.
 */
export const HOME_VARS: Partial<Record<ProviderKind, string>> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  antigravity: "GEMINI_HOME",
  opencode: "OPENCODE_CONFIG_DIR",
  hermes: "HERMES_HOME",
};

/** A name for a folder of its own: letters, digits, `.`, `_`, and `-`, but not `.` or `..`. */
export const isFolderName = (name: string) =>
  /^[\w.-]+$/.test(name) && name !== "." && name !== "..";

/**
 * `owner/name` from a GitHub slug, or from a GitHub link to the repository or any page under it,
 * or its HTTPS or SSH clone URL. Undefined otherwise.
 */
export function githubSlug(input: string): string | undefined {
  const text = input.trim();
  const link =
    /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/?#]+)\/([^/?#]+)/i.exec(
      text,
    );
  const [owner, name, ...rest] = link ? [link[1], link[2]] : text.replace(/\/$/, "").split("/");
  const repo = name?.replace(/\.git$/, "");
  // GitHub's owner names are letters, digits, and `-`, so a host such as `github.com` never is one.
  return owner && repo && rest.length === 0 && /^[a-z\d-]+$/i.test(owner) && isFolderName(repo)
    ? `${owner}/${repo}`
    : undefined;
}

/** A folder's subfolders, by name, or why it can't be read. */
export type FolderListing =
  | { path: string; folders: { name: string; path: string }[] }
  | { error: string };

/**
 * The kinds Install puts on a host with npm, in the background rather than in a terminal
 * (PLX-558), by their npm package.
 */
export const NPM_INSTALLS: Partial<Record<ProviderKind, string>> = {
  pi: "@earendil-works/pi-coding-agent",
  opencode: "opencode-ai",
};

/**
 * The npm command that installs `pkg`: on POSIX into `~/.local`, whose `bin` plxd searches, since
 * npm's own global prefix may be read-only (a Nix store); on Windows into npm's global prefix.
 */
export const npmInstallLine = (pkg: string, windows: boolean) =>
  windows ? `npm install -g ${pkg}` : `npm install -g --prefix "$HOME/.local" ${pkg}`;

const NO_NPM =
  "npm is not installed. Install Node.js from https://nodejs.org, which includes npm, then try again.";

/**
 * `line`, an npm install, run only when npm is found. Without it the shell exits 127 with
 * `NO_NPM` on stderr instead of its own "not found" output.
 */
export const needNpm = (line: string, windows: boolean) =>
  windows
    ? `if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { [Console]::Error.WriteLine('${NO_NPM}'); exit 127 }; ${line}`
    : `command -v npm >/dev/null || { echo '${NO_NPM}' >&2; exit 127; }; ${line}`;

/** Whether version `a` is older than `b` (0030): by number, then a nightly before its release. */
export function olderVersion(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(v));
  if (!x || !y) return false;
  for (const i of [1, 2, 3]) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]);
  return x[4] !== undefined && y[4] === undefined;
}

/**
 * `tag` in canonical form if `Intl` accepts it, else undefined (the default locale). Linux can
 * report tags that make every formatter throw, such as "c" for LANG=C.UTF-8 or "ca-ES@valencia".
 */
export function validLocale(tag: string | undefined): string | undefined {
  try {
    return tag ? Intl.getCanonicalLocales(tag)[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a window can blur the desktop behind it: macOS's vibrancy, Windows 11 22H2's (build
 * 22621) acrylic, or on Linux, the compositor's blur of a see-through window, as Hyprland's and
 * KDE's are. `version` is `process.getSystemVersion()`.
 */
export function blurSupported(platform: string, version: string): boolean {
  if (platform === "darwin" || platform === "linux") return true;
  return platform === "win32" && Number(version.split(".")[2]) >= 22621;
}

/**
 * Whether `material` needs the window created see-through: clear everywhere, and blurred on
 * Linux, where the compositor blurs what a see-through window shows, and on macOS, where vibrancy
 * behind a window created opaque leaves old frames showing under the page (PLX-1117).
 */
export const needsTransparentWindow = (material: WindowMaterial, platform: string) =>
  material === "clear" || (material === "blur" && platform !== "win32");

/** A window's background: Settings > Appearance's Window. */
export type WindowMaterial = "opaque" | "clear" | "blur";

export type VoiceKey = "down" | "up" | "cancel";

export interface ParallaxBridge {
  /** Focused-thread Fn hold support on macOS. Voice recording itself stays in the renderer. */
  voiceHotkey?(enabled: boolean, owner: string): Promise<{ available: boolean; error?: string }>;
  /** Native Fn transitions, and cancellation when the app loses focus. */
  onVoiceKey?(listener: (key: VoiceKey) => void): () => void;
  /** Node's `process.platform`, e.g. "darwin", "win32", "linux". */
  platform: string;
  /** The app's version. */
  version(): Promise<string>;
  /** Sets Electron's `nativeTheme.themeSource`, so native UI matches the app's theme. */
  setThemeSource(preference: ThemePreference): void;
  /** Zooms this window's page, 1 being 100%: Settings > Appearance's text size. */
  setZoom(factor: number): void;
  /** Tells main the page's zoom changed, so Windows' window buttons match the top row (frame.ts). */
  zoomed(): void;
  /**
   * Calls `listener` with whether this window is full screen, now and on every change. Returns the
   * unsubscribe function.
   */
  onFullScreen(listener: (full: boolean) => void): () => void;
  /**
   * This window's background, Settings > Appearance's Window: opaque, clear, or blurred where
   * `canBlur`. A material that needs a see-through window (needsTransparentWindow: clear, and
   * blurred outside Windows) shows only where `transparent`, so from the next launch. Not on the
   * web.
   */
  setWindowLook?(look: { material: WindowMaterial }): void;
  /** Whether `setWindowLook` can blur: `blurSupported` here. */
  canBlur?: boolean;
  /**
   * Whether this window was created see-through, so a clear background, or a blurred one outside
   * Windows, shows the desktop.
   */
  transparent?: boolean;
  /** Restarts Parallax. Not on the web. */
  relaunch?(): void;
  /** Opens the OS folder picker over this window. Resolves to the folder's path, or null if cancelled. */
  pickFolder(): Promise<string | null>;
  /** The folders in a folder on this computer, whose path may start with `~`. */
  listFolders(path: string): Promise<FolderListing>;
  /**
   * Makes `~/.parallax/projects/<name>` a git repository with an empty first commit. Resolves to
   * its path, or an error for people.
   */
  createRepo(name: string): Promise<{ path: string } | { error: string }>;
  /** Copies a picture of this window's `rect`, in CSS pixels, to the clipboard. Rejects for an empty or invalid one. */
  copyPicture(rect: { x: number; y: number; width: number; height: number }): Promise<void>;
  /**
   * Calls `listener` with what a side panel browser's page asks of the tab that shows it, by its
   * webview's `getWebContentsId()` (Browser.tsx). Returns the unsubscribe function.
   */
  onBrowser(listener: (webContentsId: number, action: BrowserAction) => void): () => void;
  /** The side panel browser's Chrome extensions (PLX-888). */
  extensions(): Promise<ExtensionInfo[]>;
  /** Installs an extension from a Chrome Web Store link or id. Resolves to it or an error. */
  installExtension(text: string): Promise<ExtensionInfo | string>;
  /** Asks for an unpacked extension's folder and loads it: it, an error, or undefined if canceled. */
  loadUnpackedExtension(): Promise<ExtensionInfo | string | undefined>;
  removeExtension(id: string): Promise<void>;
  /**
   * Calls `listener` when an extension is added or removed outside the toolbar's menu, such as
   * from the Chrome Web Store's own button (PLX-962). Returns the unsubscribe function.
   */
  onExtensionsChanged(listener: () => void): () => void;
  /** The browser's downloads, the newest first (PLX-975). */
  downloads(): Promise<DownloadInfo[]>;
  /** Calls `listener` with the downloads as they change. Returns the unsubscribe function. */
  onDownloads(listener: (downloads: DownloadInfo[]) => void): () => void;
  /**
   * The favicon of `page`'s site, its /favicon.ico, as a data url, or undefined for none. An
   * agent's tab, whose page is in plxd's browser, and a transcript's link show it (siteIcons.ts).
   */
  siteIcon(page: string): Promise<string | undefined>;
  /** The Google account signed in to the browser, for its profile button (PLX-981). */
  googleAccount(): Promise<GoogleAccount | undefined>;
  /** Calls `listener` with the account as it signs in or out. Returns the unsubscribe function. */
  onGoogleAccount(listener: (account: GoogleAccount | undefined) => void): () => void;
  /** Opens a download, shows it in its folder, or cancels it; or, without an id, clears the finished. */
  downloadAction(id: string | undefined, action: "open" | "show" | "cancel" | "clear"): void;
  /** Where downloads go, the OS's folder when empty, and whether to ask each time. */
  setDownloadPrefs(prefs: { dir: string; ask: boolean }): void;
  /** Clears the browser's site data, its cache, or both, keeping extensions' own (PLX-974). */
  clearBrowsingData(what: { siteData: boolean; cache: boolean }): Promise<void>;
  /** Tells extensions which browser tab is shown, by its webview's webContents id. */
  selectBrowserTab(webContentsId: number): void;
  /**
   * Whether `update` can run: in a packaged app, which installs releases (PLX-68), or under
   * `pnpm dev`, from a checkout (PLX-204).
   */
  updatable: boolean;
  /**
   * Whether this launch is a fresh install's, which onboards (PLX-806): main found no earlier
   * localStorage or plxd database. Never on the web, or with PLX_SKIP_ONBOARDING set.
   */
  firstRun: boolean;
  /** The OS's locale, such as "de-DE", for `src/renderer/locale.ts`. Undefined when invalid. */
  locale: string | undefined;
  /**
   * Packaged: installs the downloaded release and relaunches, else downloads the available one,
   * else checks now. A packaged app follows its own build's channel (0028): a nightly follows
   * nightly releases, any other build Latest. Under `pnpm dev`: moves the checkout to main and
   * rebuilds what changed; the app then reloads itself. Resolves to one line for people, such as
   * "Up to date" or why it failed.
   */
  update(): Promise<string>;
  /**
   * Calls `listener` with what the Update button shows, now and on every change. Only changes
   * while `updatable`. Returns the unsubscribe function.
   */
  onUpdateState(listener: (state: UpdateState) => void): () => void;

  /**
   * Calls a plxd method on a host. Resolves to its result or its error, also for an unknown
   * host or method; never rejects.
   */
  request<M extends RendererMethod>(
    hostId: string,
    method: M,
    params: ParallaxRequests[M]["params"],
  ): Promise<HostResponse<ParallaxRequests[M]["result"]>>;
  /**
   * Streams a host's events after `params.after`, surviving reconnects. Ends with a `resync`
   * message when the events are gone, or at once if the host's log isn't `params.logId`
   * anymore: reload the snapshot, then subscribe again from its `seq`.
   * Returns the unsubscribe function.
   */
  subscribe(
    hostId: string,
    params: SubscribeParams,
    listener: (message: SubscriptionMessage) => void,
  ): () => void;
  /**
   * A host's shell (`{shell: true}`) or one thread (`{threadId}`), kept live (0059): a snapshot,
   * then the events after its `seq`. It stays open while the host is disconnected: a reconnect,
   * or a lagging subscription, resumes after the last `seq` delivered, and plxd replays the gap,
   * or sends a fresh snapshot, which replaces the last, when the gap is too long. Ends only with
   * an `error`. Returns the function that ends it.
   */
  watch(
    hostId: string,
    params: { shell: true },
    listener: (message: WatchMessage<ShellSnapshot>) => void,
  ): () => void;
  watch(
    hostId: string,
    params: { threadId: string },
    listener: (message: WatchMessage<ThreadSnapshot>) => void,
  ): () => void;
  /** A host's connection state now. Rejects for an unknown host id, as `retry` does. */
  connectionState(hostId: string): Promise<ConnectionState>;
  /** Every later connection state change, for every host. Returns the unsubscribe function. */
  onConnectionState(listener: (hostId: string, state: ConnectionState) => void): () => void;
  /** Reconnects a failed host now, including one that stopped retrying. */
  retry(hostId: string): Promise<void>;
  /**
   * Each time main updated a remote host's plxd to the app's version, or couldn't (PLX-700).
   * Returns the unsubscribe function.
   */
  onHostUpdate(listener: (event: HostUpdateEvent) => void): () => void;
  /** Tries again to update a host's plxd that couldn't be updated. */
  retryHostUpdate(hostId: string): Promise<void>;
  /**
   * Updates a remote host's plxd to the app's next release, or its own version without one, and
   * restarts it now, cutting off running turns (PLX-746). Resolves once plxd answers; how it went
   * comes through `onHostUpdate`.
   */
  updateHostNow(hostId: string): Promise<void>;

  /**
   * The saved SSH hosts, oldest first, then the computers paired on the LAN. This computer is
   * host `local`, which isn't one of them.
   */
  hosts(): Promise<SavedHost[]>;
  /** Every later change to the saved hosts. Returns the unsubscribe function. */
  onHosts(listener: (hosts: SavedHost[]) => void): () => void;
  /**
   * The hosts ssh already knows here, to suggest in Add host (PLX-580): the aliases in the user's
   * ssh config, then the plain names in known_hosts.
   */
  sshSuggestions(): Promise<string[]>;
  /**
   * This computer's name in Parallax: the one the user gave it, else the computer's own, such as
   * "macbook". Calls `listener` now and on every change. Returns the unsubscribe function.
   */
  onLocalName(listener: (name: string) => void): () => void;
  /** Renames this computer in Parallax; an empty name puts the computer's own back. */
  renameLocal(name: string): Promise<string | undefined>;
  /** Adds a host, or edits the one with `id`. Resolves to an error for people, or undefined. */
  saveHost(host: HostInput, id?: string): Promise<string | undefined>;
  /**
   * Forgets a host, SSH or LAN, and disconnects from it. Nothing on the host changes. Resolves to
   * an error for people, or undefined.
   */
  removeHost(id: string): Promise<string | undefined>;
  /**
   * Installs this app's plxd release in `~/.parallax-plxd` on an SSH host, checked against the
   * release's SHA256 for it, then reconnects to it, from then on (PLX-642). Resolves to an error
   * for people, or undefined.
   */
  installPlxd(id: string): Promise<string | undefined>;
  /**
   * The computers on this network showing a pairing code (PLX-641), found over mDNS, by name.
   * Resolves to an error for people when mDNS can't run.
   */
  discoverLan(): Promise<{ id: string; name: string }[] | string>;
  /**
   * Pairs with a computer `discoverLan` found, by its id, or at an address typed in, with the code
   * it shows (PLX-641, 0065); saves it with its routes, and connects. Resolves to an error for
   * people, or undefined.
   */
  pairLan(
    target: { found: string } | { address: string },
    code: string,
  ): Promise<string | undefined>;
  /**
   * Registers this computer's plxd with Parallax Relay under the signed-in account (PLX-652).
   * Main sends the account's token to plxd itself. Resolves to an error for people, or undefined.
   */
  registerRelay(): Promise<string | undefined>;
  /**
   * The signed-in account's hosts on Parallax Relay (PLX-652), or why not, for people. Main sends
   * the token to plxd, which asks the relay.
   */
  relayHosts(): Promise<RelayHost[] | string>;
  /** Removes one of the account's hosts from the relay, freeing its place, and answers the rest. */
  removeRelayHost(hostId: string): Promise<RelayHost[] | string>;

  /** Parallax Connect here (0056). Calls `listener` now and on every change. Returns the unsubscribe function. */
  onConnect(listener: (state: ConnectState) => void): () => void;
  /**
   * Turns Parallax Connect on or off: the local plxd's `connect`, which makes it listen on its
   * Tailscale address, and this app's connections to the other devices. Resolves to an error for
   * people, or undefined.
   */
  setConnect(on: boolean): Promise<string | undefined>;
  /** The Connect devices, by name. Calls `listener` now and on every change. Returns the unsubscribe function. */
  onDevices(listener: (devices: DeviceHost[]) => void): () => void;
  /**
   * Renames a device or changes its icon on its own plxd, so every computer shows the same; an
   * empty name puts its host name back. `local` is this computer. Resolves to an error for people.
   */
  saveDevice(
    hostId: string,
    look: { name?: string; icon?: DeviceIcon },
  ): Promise<string | undefined>;
  /**
   * Turns a device on or off in this app: off drops its connection and its threads here, and
   * nothing on the device changes. On also brings back a removed device, or looks for one that
   * hasn't been found yet.
   */
  setDeviceEnabled(hostId: string, enabled: boolean): Promise<void>;
  /**
   * Removes a device from this app's list until it's added again from Add computer. Nothing on
   * the device changes, and other computers still reach it.
   */
  removeDevice(hostId: string): Promise<void>;
  /**
   * Asks the account for its computers now (0091), as Settings > Connections and Add computer do
   * when they open, and starts again any connection to one that stopped retrying.
   */
  discoverAccount(): Promise<void>;
  /**
   * Pairs with new account computer `hostId` with the 6-digit code `plx connect` shows there
   * (0091). Each code is good for one try. Resolves to an error for people, or undefined.
   */
  enterSetupCode(hostId: string, code: string): Promise<string | undefined>;
  /** Asks account computer `hostId` again to approve this device, after a denial or a lapse. */
  askAgain(hostId: string): Promise<void>;
  /**
   * New devices asking to sign in to the user's computers, each with the code it shows (0091).
   * Calls `listener` now and on every change. Returns the unsubscribe function.
   */
  onAccessRequests(listener: (requests: AccessPrompt[]) => void): () => void;
  /** Allows or denies a new device's request. Resolves to an error for people, or undefined. */
  answerAccess(id: string, allow: boolean): Promise<string | undefined>;
  /**
   * Revokes session `id` on this computer. A device signed in with the account also loses its key
   * here and on every other computer this app reaches (0091). Resolves to this computer's sessions,
   * or an error for people.
   */
  revokeDevice(id: string): Promise<RemoteSessionsResult | string>;
  /**
   * Turns on Reach from anywhere on `tailnet:` device `hostId` the user kept on Tailscale only,
   * registered under the signed-in account, so it's reached through the account before the
   * Tailscale-only path goes (0091). Resolves to an error for people, or undefined.
   */
  turnOnReach(hostId: string): Promise<string | undefined>;

  /**
   * The agents in the ACP Registry, fetched once while the app runs. Resolves to an error for
   * people when it can't be read.
   */
  acpRegistry(): Promise<RegistryAgent[] | string>;

  /**
   * Opens this window's terminal `id` in plxd (PLX-637), in place of any terminal it had with that
   * id: `cli`'s own sign-in on a host (0004), a provider instance's (its `ProviderInfo.login`, on
   * a plxd with `providers`), or the user's login shell in a host's folder. A shell's `id` names
   * it on its host, so opening it again, from any window or after a restart, attaches to it and
   * replays what it printed. Resolves to an error for people, or undefined once it runs. The app
   * only passes on what's typed and printed; it never reads or keeps it. When a window reloads or
   * closes, its shells keep running and its other terminals end.
   */
  openTerminal(
    id: string,
    target: TerminalTarget,
    cols: number,
    rows: number,
  ): Promise<string | undefined>;
  /**
   * Installs an agent of `kind` (one of `NPM_INSTALLS`) on a host with npm, in the background.
   * Resolves to an error for people, with the end of npm's output, or undefined once it's done.
   */
  install(hostId: string, kind: ProviderKind): Promise<string | undefined>;
  /** Types into terminal `id`, or runs a command in it with a trailing "\r". */
  terminalInput(id: string, data: string): void;
  /** Resizes terminal `id`, in character cells. */
  resizeTerminal(id: string, cols: number, rows: number): void;
  /** Ends terminal `id`, killing what runs in it. */
  closeTerminal(id: string): void;
  /** What terminal `id` prints, then its exit. Returns the unsubscribe function. */
  onTerminal(id: string, listener: (message: TerminalMessage) => void): () => void;

  /**
   * Opens this window's device stream `params.streamId` on a host (PLX-886), in place of any it
   * had with that id: plxd connects to its device hub and relays the stream, whose messages go to
   * `listener` until it ends or `closeDeviceStream`. Resolves to an error for people, or undefined
   * once it's open. A window's streams close when it reloads or closes.
   */
  openDeviceStream(
    hostId: string,
    params: DeviceStreamParams,
    listener: (message: DeviceStreamMessage) => void,
  ): Promise<string | undefined>;
  /** Sends bytes, or a text message, on device stream `streamId`. */
  sendDeviceStream(streamId: string, data: Uint8Array | string): void;
  /** Closes device stream `streamId`. */
  closeDeviceStream(streamId: string): void;

  /**
   * Where `openFolder` can open a folder on a host, with their icons where main could read them:
   * the editors this computer has (only those with Remote SSH for an SSH host), and the file
   * manager and chosen terminal for this computer's own folders. Empty for an unknown host.
   */
  openTargets(hostId: string): Promise<OpenApp[]>;
  /**
   * Opens a host's folder with `target`. For `terminal`, `terminal` names one of `terminalApps`
   * to use instead of the chosen one. Main shows a dialog when it can't.
   */
  openFolder(hostId: string, target: OpenTarget, folder: string, terminal?: string): Promise<void>;
  /**
   * Selects a file on this computer in Finder or Explorer, given as an absolute path or one from
   * the home folder (`~/`). Resolves to why it couldn't, or undefined.
   */
  showFile(path: string): Promise<string | undefined>;
  /** The name of the terminal app Open uses, or null until one is chosen. */
  terminalApp(): Promise<string | null>;
  /** Installed known terminal apps on this computer, with their icons where main could read them. */
  terminalApps(): Promise<TerminalApp[]>;
  /** Selects an installed terminal. Unknown paths are rejected. */
  selectTerminalApp(path: string): Promise<string | null>;
  /** The `parallax` command that opens Parallax in a terminal (PLX-750), and where it goes. */
  command(): Promise<CommandStatus>;
  /** Installs or reinstalls the command. Null when done, or why it couldn't. */
  installCommand(): Promise<string | null>;
  /** Removes the command. Null when done, or why it couldn't. */
  removeCommand(): Promise<string | null>;

  /**
   * Calls `listener` with the signed-in Parallax account (0067), or null, now and on every
   * change. Returns the unsubscribe function.
   */
  onProfile(listener: (profile: Profile | null) => void): () => void;
  /**
   * Opens Clerk's sign-in page in the system browser, or its sign-up page if `create`. Settles once
   * the browser signs the app in, another sign-in replaces it, or it times out. Resolves to an
   * error for people, or undefined.
   */
  signIn(create: boolean): Promise<string | undefined>;
  /**
   * Opens the account's page on Clerk in the system browser, where its name and picture change,
   * or with `security`, its Security page: password, passkeys, devices, and deleting the account.
   * `onProfile` hears the change once the app's window is focused again.
   */
  editProfile(page?: "security"): Promise<void>;
  /** Signs out on this computer. */
  signOut(): Promise<void>;

  /** What Parallax keeps on this computer, with sizes. Takes a moment: it walks the folders. */
  storage(): Promise<StorageItem[]>;
  /** Opens a storage item's folder in the file manager. */
  showFolder(id: StorageItemId): Promise<void>;
  /** Clears the app's web cache. Nothing the user made is in it. */
  clearCache(): Promise<void>;
}

export type StorageItemId = "history" | "worktrees" | "logs" | "app" | "cache";
/** Something Parallax keeps on this computer: its folder, and its size in bytes. */
export type StorageItem = { id: StorageItemId; name: string; folder: string; bytes: number };

/**
 * The signed-in Parallax account, as the app shows it. `name` is the first and last name joined,
 * or empty. `picture` is a data: URL.
 */
export type Profile = {
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  picture?: string;
};

/** What the sidebar's Update button shows. */
export type UpdateState = {
  /**
   * A packaged app's newer release: its version, its notes as plain lines, and its GitHub page.
   * `update` downloads it.
   */
  available?: { version: string; notes: string; url: string };
  /** The download's percent, 0 to 100, while it runs. */
  progress?: number;
  /** What `update` would install, such as "3 commits to apply"; undefined while nothing is. */
  ready?: string;
  /** One line on the button about the last check, such as a download or an error. */
  note?: string;
};

/**
 * What a terminal runs: an SSH host's login, for a password or 2FA (`login`), a CLI's sign-in on a
 * host, a provider instance's sign-in by its id, the install of an agent of a provider kind, or a
 * shell in a folder on a host, which its thread's archive or delete ends.
 */
export type TerminalTarget =
  | { hostId: string; login: true }
  | { hostId: string; cli: CliKind }
  | { hostId: string; provider: string }
  | { hostId: string; install: ProviderKind }
  /**
   * A shell in `path`, or with `terminalId`, the thread's plxd terminal of that id, such as a setup
   * script's `setup-<id>` (PLX-650), which `id` then only names in this window.
   */
  | { hostId: string; path: string; threadId?: string; terminalId?: string }
  | { hostId: string; connect: ConnectAdd };

/**
 * What Add computer sets up with `plx add` (0056): a Tailscale IP, an ssh user, and with
 * `headless`, plxd alone, without the app.
 */
type ConnectAdd = { device: string; user?: string; headless?: boolean };

/** How an ACP Registry agent is run with `npx` or `uvx`: a package, pinned to its version. */
type RegistryPackage = { package: string; args?: string[]; env?: Record<string, string> };

/**
 * An agent in the ACP Registry (cdn.agentclientprotocol.com/registry/v1), as main passes it on.
 * `binary` is by platform, such as `darwin-aarch64`, each with the command in its archive.
 */
export type RegistryAgent = {
  id: string;
  name: string;
  version: string;
  description: string;
  /** An SVG drawn in `currentColor`. */
  icon?: string;
  repository?: string;
  website?: string;
  distribution: {
    npx?: RegistryPackage;
    uvx?: RegistryPackage;
    binary?: Record<string, { cmd: string; args?: string[]; env?: Record<string, string> }>;
  };
};

/**
 * A device stream's message (PLX-886): bytes, or a socket's text message, then its end, with why
 * when it failed.
 */
export type DeviceStreamMessage =
  | { type: "data"; data: Uint8Array | string }
  | { type: "end"; error?: string };

/** What a terminal printed, all it kept so far (`replay`, which replaces what's shown), or its exit. */
export type TerminalMessage =
  | { type: "data" | "replay"; data: string }
  | { type: "exit"; exitCode: number };

/** A host the user added, reached with `ssh <destination> plxd attach` (0022). */
export type SshHost = {
  id: string;
  name: string;
  destination: string;
  /** Parallax installed plxd there (PLX-642), so it connects through that one from the start. */
  plxdInstalled?: true;
};

/**
 * A computer paired on the LAN (PLX-641), by host id `lan:<its certificate fingerprint>`, reached
 * with `plxd dial --remote` over its routes in order: the one it paired over, then the ones it
 * reported.
 */
export type LanHost = { id: string; name: string; routes: string[] };

/** A host saved in this app. */
export type SavedHost = SshHost | LanHost;

/** What the Hosts settings edit. The main process checks it and picks the id. */
export type HostInput = { name: string; destination: string };

/** A Parallax Connect device's icon (0056), as its plxd's `deviceIcon` names it. */
export const DEVICE_ICONS = ["laptop", "desktop", "mini", "server"] as const;
export type DeviceIcon = (typeof DEVICE_ICONS)[number];

/**
 * The icon a host name suggests (0056): a mini PC for `mini`, a server for `server`, a PC for
 * `desktop`, `pc`, `tower`, or `gaming` (Windows names a new PC `DESKTOP-…`), else a laptop.
 */
export function iconFor(hostName: string): DeviceIcon {
  const name = hostName.toLowerCase();
  if (name.includes("mini")) return "mini";
  if (name.includes("server")) return "server";
  if (/desktop|tower|gaming|(^|[^a-z])pc([^a-z]|$)/.test(name)) return "desktop";
  return "laptop";
}

/**
 * A computer Parallax Connect reaches: one on the signed-in account (0091), by host id
 * `account:<relay id>`, or one on the tailnet with `plxd dial <ip>` (0056), by `tailnet:<node id>`.
 * Its name and icon are its plxd's, else what its host name suggests.
 */
export type DeviceHost = {
  id: string;
  name: string;
  icon: DeviceIcon;
  /** Its Tailscale host name, such as "mac-mini"; an account computer's name. */
  hostName: string;
  /** Its Tailscale IPv4. An account computer has none. */
  ip?: string;
  /** Its OS as Tailscale names it: "macOS", "windows", or "linux". An account computer has none. */
  os?: string;
  /** The icon its host name suggests, which a chosen one replaces. */
  detected: DeviceIcon;
  /** Whether this app uses it. Off, it's still listed here, with no connection or threads. */
  enabled: boolean;
  /** An account computer's sign-in, while it needs the user or is under way. */
  access?: AccountAccess;
};

/**
 * Where this device's access to an account computer stands (0091), while it has no session there:
 * a new computer needs the code `plx connect` shows; a known one signs in, and may wait for one of
 * the user's devices to allow this one, showing the same code; a denied or lapsed request waits
 * for the user to ask again.
 */
export type AccountAccess =
  /**
   * `offline` while the computer is offline or doesn't answer, as a leftover from an old install
   * would: no dialog asks for its code then, unless the user picks Enter code.
   */
  | { step: "needsCode"; error?: string; offline?: true }
  | { step: "pairing" }
  | { step: "signingIn" }
  | { step: "pending"; code: string }
  | { step: "ask"; why: string };

/** A new device asking to sign in to the user's computers (0091), as "Allow <name>?" shows it. */
export type AccessPrompt = {
  /** The request's id. */
  id: string;
  /** The device's name. */
  name: string;
  /** The 6 digits it shows. */
  code: string;
  /** The computer it asked, by name. */
  host: string;
};

/** Parallax Connect on this computer (0056). */
export type ConnectState = {
  /** The local plxd's `connect`; undefined while it isn't connected, or doesn't have Connect. */
  on?: boolean;
  /** This computer's icon. */
  icon: DeviceIcon;
  /** The channel `plx add` installs: this app's own (0028). */
  channel: "stable" | "nightly";
};

/**
 * The methods the renderer may not call. Main owns the handshake, event subscriptions, and
 * terminals (it decides what they run), and the rest are plxd's for its MCP tools, which the app
 * never sends.
 */
export const withheldMethods = [
  "initialize",
  "events/subscribe",
  "events/unsubscribe",
  "agent/accept",
  "agent/diff",
  "agent/requestChanges",
  "agent/wait",
  "context/write",
  "host/update",
  "land/approve",
  "land/queue",
  "land/sendBack",
  "memory/propose",
  // Another plxd's, which pulls You memory with them (0082).
  "memory/syncList",
  "memory/syncRead",
  "pr/link",
  "pr/unlink",
  // `pr/unwatch` stays callable: the waiting bar's Stop ends a watch (PLX-777).
  "pr/watch",
  "pr/watches",
  "orchestrator/fromThreads",
  "question/ask",
  "question/escalate",
  // Carry the account's token, which only main may send (PLX-652): see `registerRelay`. Only
  // main signs in a computer with `relay/sign` too (PLX-1146).
  "relay/register",
  "relay/sign",
  "relay/hosts",
  "relay/remove",
  // Who may sign in to the user's computers (0091): only main approves, merges, and pairs, from
  // the prompts it shows, so a renderer can't let a device in.
  "relay/id",
  "access/get",
  "access/merge",
  "access/approve",
  "access/deny",
  "access/remove",
  "access/setupCode",
  // Revoking goes through `revokeDevice`, which also removes the device's key everywhere (0091).
  "remote/revoke",
  "terminal/open",
  "terminal/close",
  // A window's device streams go through `openDeviceStream`, which routes what plxd relays.
  "device/stream",
] as const satisfies readonly (keyof ParallaxRequests)[];

/** The methods the renderer may call: every request but `withheldMethods`. */
export type RendererMethod = Exclude<keyof ParallaxRequests, (typeof withheldMethods)[number]>;

/** A JSON-RPC error. A Parallax error (code -32000) carries `data.kind`. */
export type RpcError = { code: number; message: string; data?: ErrorData };

export type RpcResponse<R> = { result: R } | { error: RpcError };

/**
 * A host's answer. A result carries the `logId` of the event log it was read under (0007),
 * for `subscribe` to check a `seq` from it against.
 */
export type HostResponse<R> = { result: R; logId: LogId } | { error: RpcError };

/** `events/subscribe`'s params, plus the `logId` of the response `after` came from. */
export type SubscribeParams = EventsSubscribeParams & { logId: LogId };

/** What `watch` follows: a host's shell, or one thread. */
export type WatchParams = { shell: true } | { threadId: string };

export type WatchMessage<S = ShellSnapshot | ThreadSnapshot> =
  /** Where it stands now. It replaces anything shown before. */
  | { type: "snapshot"; snapshot: S }
  | { type: "event"; event: EventsEventParams }
  /** It ended with an error, such as `runNotFound`. */
  | { type: "error"; error: RpcError };

export type SubscriptionMessage =
  | { type: "event"; event: EventsEventParams }
  /** The subscription ended because plxd can't replay what was missed. */
  | { type: "resync" }
  /** The subscription ended with an error, such as `orchestratorNotFound`. */
  | { type: "error"; error: RpcError };

/** How updating a remote host's plxd to the app's version went (PLX-700). */
export type HostUpdateEvent =
  /** It reconnected on `version`. */
  | { hostId: string; status: "updated"; version: string }
  /** `error` says why, for people. */
  | { hostId: string; status: "failed"; error: string };

export type ConnectionState =
  | { status: "connecting" }
  /** `capabilities` are what plxd's `initialize` advertised, such as `runOptions`. */
  | { status: "connected"; plxd: string; protocol: number; capabilities: Capabilities }
  /** `retrying` is false once only `retry` can bring it back. */
  | { status: "failed"; error: ConnectionError; retrying: boolean };

export type ConnectionError = {
  /**
   * `sshSetup`: the host needs the user, such as to accept its host key, so it isn't retried.
   * `refused`: a LAN computer doesn't know this one anymore, so it needs pairing again.
   */
  reason:
    | "notFound"
    | "incompatibleProtocol"
    | "exited"
    | "unresponsive"
    | "protocolError"
    | "sshSetup"
    | "refused";
  /** For people: what went wrong and how to fix it. */
  message: string;
  /** plxd's version, when it refused the handshake. */
  plxd?: string;
  /** How `plxd attach` exited, or ssh for a host. */
  exitCode?: number | null;
  /** The end of attach's stderr, and ssh's for a host, if they wrote any. */
  stderr?: string;
};

/**
 * What a side panel browser's page asks of its tab, from main: open a page in a new tab (a popup,
 * "Open Link in New Tab", or an extension's), show its favicon, as a data url the app's CSP
 * allows, a Chrome shortcut pressed in the page (links.ts), or be shown or closed for an extension.
 */
export type BrowserAction =
  | { kind: "open"; url: string }
  | { kind: "icon"; url: string }
  | {
      kind:
        | "select"
        | "address"
        | "newTab"
        | "closeTab"
        | "reopenTab"
        | "nextTab"
        | "previousTab"
        | "lastTab"
        | "find"
        | "findNext"
        | "findPrevious"
        | "bookmark"
        | "history"
        | "zoomIn"
        | "zoomOut"
        | "resetZoom";
    }
  // Cmd/Ctrl+1 to 8's tab, from 0 (PLX-969).
  | { kind: "tab"; index: number };

/** A Google account signed in to the browser (googleAccount.ts in main); `picture` is inline. */
export interface GoogleAccount {
  name: string;
  email: string;
  picture?: string;
}

/** One of the browser's downloads (PLX-975), as main tracks it (downloads.ts). */
export interface DownloadInfo {
  id: string;
  /** Its file's name, once saved; the server's until then. */
  name: string;
  url: string;
  /** Where it saves, once known. */
  path?: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  received: number;
  /** Its size in bytes, or 0 when the server doesn't say. */
  total: number;
  paused?: boolean;
}

/**
 * A Chrome extension in the side panel's browser: its name, its toolbar icon as a data url, and
 * its popup's page, if it has one.
 */
export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  icon?: string;
  popup?: string;
}
