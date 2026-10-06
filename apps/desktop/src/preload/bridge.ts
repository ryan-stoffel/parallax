// The `window.parallax` contract. The preload implements it and the renderer types
// against it, so it must not import anything from Node or Electron.
import type {
  Capabilities,
  CliKind,
  ErrorData,
  EventsEventParams,
  EventsSubscribeParams,
  LogId,
  ParallaxRequests,
  ProviderKind,
} from "../protocol/generated/protocol";

/** The Appearance setting: follow the OS, or force a theme. */
export const THEME_PREFERENCES = ["system", "dark", "light"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/**
 * Where the top bar's Open button opens a folder: an editor, the OS's file manager, or the
 * terminal app chosen in Settings.
 */
export const OPEN_TARGETS = ["cursor", "vscode", "files", "terminal"] as const;
export type OpenTarget = (typeof OPEN_TARGETS)[number];

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

/** `owner/name` from a GitHub slug or URL, or undefined. */
export function githubSlug(input: string): string | undefined {
  const slug = input
    .trim()
    .replace(/^(https:\/\/)?github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  const [owner, name, ...rest] = slug.split("/");
  return owner && name && rest.length === 0 && isFolderName(owner) && isFolderName(name)
    ? `${owner}/${name}`
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

export interface ParallaxBridge {
  /** Node's `process.platform`, e.g. "darwin", "win32", "linux". */
  platform: string;
  /** The app's version. */
  version(): Promise<string>;
  /** Sets Electron's `nativeTheme.themeSource`, so native UI matches the app's theme. */
  setThemeSource(preference: ThemePreference): void;
  /** Zooms this window's page, 1 being 100%: Settings > Appearance's text size. */
  setZoom(factor: number): void;
  /** Opens the OS folder picker over this window. Resolves to the folder's path, or null if cancelled. */
  pickFolder(): Promise<string | null>;
  /** The folders in a folder on this computer, whose path may start with `~`. */
  listFolders(path: string): Promise<FolderListing>;
  /**
   * Makes `~/.parallax/projects/<name>` a git repository with an empty first commit. Resolves to
   * its path, or an error for people.
   */
  createRepo(name: string): Promise<{ path: string } | { error: string }>;
  /**
   * Clones GitHub's `owner/name` into `dest`, which may start with `~` and must not exist.
   * Resolves to its path, or an error for people.
   */
  cloneRepo(slug: string, dest: string): Promise<{ path: string } | { error: string }>;
  /** Copies a picture of this window's `rect`, in CSS pixels, to the clipboard. Rejects for an empty or invalid one. */
  copyPicture(rect: { x: number; y: number; width: number; height: number }): Promise<void>;
  /**
   * Whether `update` can run: in a packaged app, which installs releases (PLX-68), or under
   * `pnpm dev`, from a checkout (PLX-204).
   */
  updatable: boolean;
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
   * Names a new thread from its first prompt, with a model that runs on this computer. Resolves
   * at once, from the prompt's words, while the model isn't ready. Never rejects.
   */
  nameThread(prompt: string): Promise<ThreadName>;

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
  /** A host's connection state now. Rejects for an unknown host id, as `retry` does. */
  connectionState(hostId: string): Promise<ConnectionState>;
  /** Every later connection state change, for every host. Returns the unsubscribe function. */
  onConnectionState(listener: (hostId: string, state: ConnectionState) => void): () => void;
  /** Reconnects a failed host now, including one that stopped retrying. */
  retry(hostId: string): Promise<void>;

  /** The saved SSH hosts, oldest first. This computer is host `local`, which isn't one of them. */
  hosts(): Promise<SshHost[]>;
  /** Every later change to the saved hosts. Returns the unsubscribe function. */
  onHosts(listener: (hosts: SshHost[]) => void): () => void;
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
   * Forgets a host and disconnects from it. Nothing on the host changes. Resolves to an error for
   * people, or undefined.
   */
  removeHost(id: string): Promise<string | undefined>;

  /** Parallax Connect here (0056). Calls `listener` now and on every change. Returns the unsubscribe function. */
  onConnect(listener: (state: ConnectState) => void): () => void;
  /** Installs `plx-connect` on this computer with npm. Resolves to an error for people, or undefined. */
  installConnect(): Promise<string | undefined>;
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
   * The agents in the ACP Registry, fetched once while the app runs. Resolves to an error for
   * people when it can't be read.
   */
  acpRegistry(): Promise<RegistryAgent[] | string>;

  /**
   * Opens this window's terminal `id`, in place of any terminal it had with that id: `cli`'s own
   * sign-in on a host (0004), a provider instance's (its `ProviderInfo.login`, on a plxd with
   * `providers`), or the user's login shell in a host's folder. Resolves to an error
   * for people, or undefined once it runs. The app only passes on what's typed and printed; it
   * never reads or keeps it. A window's terminals end when it reloads or closes.
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
   * Where `openFolder` can open a folder on a host: the editors this computer has, and the file
   * manager and chosen terminal for this computer's own folders. Empty for an unknown host.
   */
  openTargets(hostId: string): Promise<OpenTarget[]>;
  /** The Open targets' own app icons as data URLs: macOS only, and only those it could read. */
  openTargetIcons(): Promise<Partial<Record<OpenTarget, string>>>;
  /** Opens a host's folder with `target`. Main shows a dialog when it can't. */
  openFolder(hostId: string, target: OpenTarget, folder: string): Promise<void>;
  /** The name of the terminal app Open uses, or null until one is chosen. */
  terminalApp(): Promise<string | null>;
  /**
   * Asks for the terminal app in a file dialog that starts in Applications, and keeps it. Resolves
   * to its name, or null if canceled.
   */
  chooseTerminalApp(): Promise<string | null>;

  /**
   * Calls `listener` with the signed-in Parallax account (0037), or null, now and on every
   * change. Returns the unsubscribe function.
   */
  onProfile(listener: (profile: Profile | null) => void): () => void;
  /**
   * Opens the Parallax sign-in page in the system browser, on Create an account if `create`.
   * Settles once the page signs the app in, another sign-in replaces it, or it times out. Resolves
   * to an error for people, or undefined.
   */
  signIn(create: boolean): Promise<string | undefined>;
  /**
   * Saves the account's first and last name, trimmed. Resolves to an error for people, or undefined
   * once saved, after which `onProfile` hears the new name.
   */
  saveName(firstName: string, lastName: string): Promise<string | undefined>;
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
 * What a terminal runs: a CLI's sign-in on a host, a provider instance's sign-in by its id, the
 * install of an agent of a provider kind, or a shell in a folder on a host.
 */
export type TerminalTarget =
  | { hostId: string; cli: CliKind }
  | { hostId: string; provider: string }
  | { hostId: string; install: ProviderKind }
  | { hostId: string; path: string }
  | { hostId: string; connect: ConnectAdd };

/** What Add computer sets up with `plx-connect add` (0056): a Tailscale IP, and an ssh user. */
export type ConnectAdd = { device: string; user?: string };

/** How an ACP Registry agent is run with `npx` or `uvx`: a package, pinned to its version. */
export type RegistryPackage = { package: string; args?: string[]; env?: Record<string, string> };

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

export type TerminalMessage = { type: "data"; data: string } | { type: "exit"; exitCode: number };

/** A thread's name: a `title` for lists, and a `slug` to name its worktree branch `parallax/<slug>`. */
export type ThreadName = { title?: string; slug?: string };

/** A host the user added, reached with `ssh <destination> plxd attach` (0022). */
export type SshHost = { id: string; name: string; destination: string };

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
 * A computer Parallax Connect reaches over Tailscale with `plxd dial <ip>` (0056), by host id
 * `tailnet:<node id>`. Its name and icon are its plxd's, else what its host name suggests.
 */
export type DeviceHost = {
  id: string;
  name: string;
  icon: DeviceIcon;
  /** Its Tailscale host name, such as "mac-mini". */
  hostName: string;
  /** Its Tailscale IPv4. */
  ip: string;
  /** Its OS as Tailscale names it: "macOS", "windows", or "linux". */
  os: string;
  /** The icon its host name suggests, which a chosen one replaces. */
  detected: DeviceIcon;
  /** Whether this app uses it. Off, it's still listed here, with no connection or threads. */
  enabled: boolean;
};

/** Parallax Connect on this computer (0056). */
export type ConnectState = {
  /** Whether `plx-connect` is installed here; undefined until main has looked. */
  installed?: boolean;
  /** The local plxd's `connect`; undefined while it isn't connected, or doesn't have Connect. */
  on?: boolean;
  /** This computer's icon. */
  icon: DeviceIcon;
  /** The channel `plx-connect add` installs: this app's own (0028). */
  channel: "stable" | "nightly";
};

/** The methods the renderer may call. Main owns the handshake and event subscriptions. */
export type RendererMethod = Exclude<
  keyof ParallaxRequests,
  "initialize" | "events/subscribe" | "events/unsubscribe"
>;

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

export type SubscriptionMessage =
  | { type: "event"; event: EventsEventParams }
  /** The subscription ended because plxd can't replay what was missed. */
  | { type: "resync" }
  /** The subscription ended with an error, such as `projectNotFound`. */
  | { type: "error"; error: RpcError };

export type ConnectionState =
  | { status: "connecting" }
  /** `capabilities` are what plxd's `initialize` advertised, such as `runOptions`. */
  | { status: "connected"; plxd: string; protocol: number; capabilities: Capabilities }
  /** `retrying` is false once only `retry` can bring it back. */
  | { status: "failed"; error: ConnectionError; retrying: boolean };

export type ConnectionError = {
  /** `sshSetup`: the host needs the user, such as to accept its host key, so it isn't retried. */
  reason:
    | "notFound"
    | "incompatibleProtocol"
    | "exited"
    | "unresponsive"
    | "protocolError"
    | "sshSetup";
  /** For people: what went wrong and how to fix it. */
  message: string;
  /** plxd's version, when it refused the handshake. */
  plxd?: string;
  /** How `plxd attach` exited, or ssh for a host. */
  exitCode?: number | null;
  /** The end of attach's stderr, and ssh's for a host, if they wrote any. */
  stderr?: string;
};
