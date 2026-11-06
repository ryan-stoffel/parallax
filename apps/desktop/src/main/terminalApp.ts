import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { TerminalApp } from "../preload/bridge";

/**
 * The terminal app the Open menu opens a folder in, chosen in Settings > General: its path, kept
 * in `file` as `{ "app": path }`. Undefined until chosen, or when the file can't be read.
 */
export function readTerminalApp(file: string): string | undefined {
  try {
    const { app } = JSON.parse(readFileSync(file, "utf8")) as { app?: unknown };
    return typeof app === "string" && path.isAbsolute(app) ? app : undefined;
  } catch {
    return undefined;
  }
}

export const writeTerminalApp = (file: string, app: string): void =>
  writeFileSync(file, `${JSON.stringify({ app })}\n`);

/** The app's name for people: its file name without `.app` or `.exe`, from any OS's path. */
export const terminalName = (app: string): string =>
  path.win32.basename(app).replace(/\.(app|exe)$/i, "");

/**
 * The flags that start each known terminal in a folder elsewhere than macOS. Some, such as
 * Windows Terminal, ignore the directory they're started in, so the folder is passed too.
 */
const folderFlags: Record<string, (folder: string) => string[]> = {
  "wt.exe": (folder) => ["-d", folder],
  "windowsterminal.exe": (folder) => ["-d", folder],
  "wezterm-gui.exe": (folder) => ["start", "--cwd", folder],
  wezterm: (folder) => ["start", "--cwd", folder],
  "alacritty.exe": (folder) => ["--working-directory", folder],
  alacritty: (folder) => ["--working-directory", folder],
  "gnome-terminal": (folder) => [`--working-directory=${folder}`],
  "xfce4-terminal": (folder) => [`--working-directory=${folder}`],
  konsole: (folder) => ["--workdir", folder],
  kitty: (folder) => ["--directory", folder],
  ghostty: (folder) => [`--working-directory=${folder}`],
};

/**
 * The command that opens `folder` in terminal `app`. macOS hands the folder to the app with
 * `open -a`, which every terminal there takes as where to start. Elsewhere the app starts in it,
 * with the folder flag of a known terminal as well.
 */
export function terminalCommand(
  platform: NodeJS.Platform,
  app: string,
  folder: string,
): { file: string; args: string[]; cwd?: string } {
  if (platform === "darwin") return { file: "/usr/bin/open", args: ["-a", app, folder] };
  const name = (platform === "win32" ? path.win32 : path.posix).basename(app).toLowerCase();
  return { file: app, args: folderFlags[name]?.(folder) ?? [], cwd: folder };
}

/**
 * What precedes a command for each known terminal to run it elsewhere than macOS. `-e` is for the
 * others, as most terminals take it.
 */
const commandFlags: Record<string, string[]> = {
  "wt.exe": [],
  "windowsterminal.exe": [],
  "wezterm-gui.exe": ["start", "--"],
  wezterm: ["start", "--"],
  "gnome-terminal": ["--"],
  "xfce4-terminal": ["-x"],
  kitty: [],
};

/** macOS terminals that `open -a` starts in a file's folder rather than running the file. */
const macEFlag = new Set(["ghostty.app", "alacritty.app", "rio.app"]);

/**
 * The command that runs `command` in terminal `app`. macOS's `open` can only pass a file to most
 * apps, so it gets `script`, an executable file that runs the command. Elsewhere the app gets the
 * command itself.
 */
export function terminalRunCommand(
  platform: NodeJS.Platform,
  app: string,
  command: string[],
  script: string,
): { file: string; args: string[] } {
  const name = (platform === "win32" ? path.win32 : path.posix).basename(app).toLowerCase();
  if (platform === "darwin")
    return {
      file: "/usr/bin/open",
      args: macEFlag.has(name) ? ["-na", app, "--args", "-e", script] : ["-a", app, script],
    };
  // Windows Terminal reads `;` as the start of its next command, even inside an argument, so a
  // folder's name could otherwise run something here.
  const windowsTerminal = name === "wt.exe" || name === "windowsterminal.exe";
  const args = windowsTerminal ? command.map((arg) => arg.replaceAll(";", "\\;")) : command;
  return { file: app, args: [...(commandFlags[name] ?? ["-e"]), ...args] };
}

/** Known terminal apps only, found in the platform's app folders and PATH. */
export function detectTerminalApps(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  saved?: string,
  exists: (file: string) => boolean = existsSync,
): TerminalApp[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dirs = (env["PATH"] ?? env["Path"] ?? "").split(p.delimiter).filter(Boolean);
  const names =
    platform === "darwin"
      ? [
          "Ghostty.app",
          "iTerm.app",
          "Terminal.app",
          "WezTerm.app",
          "Alacritty.app",
          "kitty.app",
          "Warp.app",
          "Hyper.app",
          "Tabby.app",
          "Rio.app",
        ]
      : platform === "win32"
        ? ["wt.exe", "wezterm-gui.exe", "alacritty.exe", "WindowsTerminal.exe"]
        : [
            "ghostty",
            "kitty",
            "wezterm",
            "alacritty",
            "gnome-terminal",
            "konsole",
            "xfce4-terminal",
            "xterm",
          ];
  const apps: TerminalApp[] = [];
  for (const name of names) {
    const locations =
      platform === "darwin"
        ? [
            "/Applications",
            "/System/Applications/Utilities",
            ...(env["HOME"] ? [p.join(env["HOME"], "Applications")] : []),
          ]
        : platform === "win32"
          ? [
              ...dirs,
              ...(env["LOCALAPPDATA"]
                ? [p.join(env["LOCALAPPDATA"], "Microsoft", "WindowsApps")]
                : []),
              ...(env["ProgramFiles"]
                ? [p.join(env["ProgramFiles"], "WezTerm"), p.join(env["ProgramFiles"], "Alacritty")]
                : []),
            ]
          : dirs;
    const program = [
      ...(saved && p.basename(saved).toLowerCase() === name.toLowerCase() ? [saved] : []),
      ...locations.map((dir) => p.join(dir, name)),
    ].find(exists);
    if (!program) continue;
    const label =
      name === "wt.exe" || name === "WindowsTerminal.exe"
        ? "Windows Terminal"
        : name === "wezterm-gui.exe" || name === "wezterm"
          ? "WezTerm"
          : name === "iTerm.app"
            ? "iTerm"
            : terminalName(program);
    if (!apps.some((app) => app.name === label)) apps.push({ path: program, name: label });
  }
  return apps;
}
