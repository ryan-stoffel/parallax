import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { Editor } from "../preload/bridge";

export type { Editor };

/**
 * How Open finds each editor: its name for people, its macOS app bundles, its CLIs on PATH
 * elsewhere, the Remote SSH CLI inside its macOS bundle (only editors that open an SSH host's
 * folder), and on Windows its app next to its `.cmd` on PATH, which Node can't run without a
 * shell. In the order Open lists them.
 */
const editors: Record<
  Editor,
  { name: string; mac: string[]; cli: string[]; remote?: string; windows?: string }
> = {
  vscode: {
    name: "VS Code",
    mac: ["Visual Studio Code.app"],
    cli: ["code"],
    remote: "Contents/Resources/app/bin/code",
    windows: "../Code.exe",
  },
  vscodeInsiders: {
    name: "VS Code Insiders",
    mac: ["Visual Studio Code - Insiders.app"],
    cli: ["code-insiders"],
    remote: "Contents/Resources/app/bin/code-insiders",
    windows: "../Code - Insiders.exe",
  },
  vscodium: {
    name: "VSCodium",
    mac: ["VSCodium.app"],
    cli: ["codium"],
    remote: "Contents/Resources/app/bin/codium",
    windows: "../VSCodium.exe",
  },
  cursor: {
    name: "Cursor",
    mac: ["Cursor.app"],
    cli: ["cursor"],
    remote: "Contents/Resources/app/bin/cursor",
    windows: "../../../Cursor.exe",
  },
  windsurf: {
    name: "Windsurf",
    mac: ["Windsurf.app"],
    cli: ["windsurf"],
    remote: "Contents/Resources/app/bin/windsurf",
    windows: "../Windsurf.exe",
  },
  zed: { name: "Zed", mac: ["Zed.app", "Zed Preview.app"], cli: ["zed", "zeditor"] },
  sublime: { name: "Sublime Text", mac: ["Sublime Text.app"], cli: ["subl"] },
  nova: { name: "Nova", mac: ["Nova.app"], cli: [] },
  xcode: { name: "Xcode", mac: ["Xcode.app"], cli: [] },
  intellij: {
    name: "IntelliJ IDEA",
    mac: ["IntelliJ IDEA.app", "IntelliJ IDEA Ultimate.app", "IntelliJ IDEA CE.app"],
    cli: ["idea"],
  },
  webstorm: { name: "WebStorm", mac: ["WebStorm.app"], cli: ["webstorm"] },
  pycharm: {
    name: "PyCharm",
    mac: ["PyCharm.app", "PyCharm Professional Edition.app", "PyCharm CE.app"],
    cli: ["pycharm"],
  },
  goland: { name: "GoLand", mac: ["GoLand.app"], cli: ["goland"] },
  rustrover: { name: "RustRover", mac: ["RustRover.app"], cli: ["rustrover"] },
  clion: { name: "CLion", mac: ["CLion.app"], cli: ["clion"] },
  phpstorm: { name: "PhpStorm", mac: ["PhpStorm.app"], cli: ["phpstorm"] },
  rider: { name: "Rider", mac: ["Rider.app"], cli: ["rider"] },
  rubymine: { name: "RubyMine", mac: ["RubyMine.app"], cli: ["rubymine"] },
  androidStudio: { name: "Android Studio", mac: ["Android Studio.app"], cli: ["studio"] },
  fleet: { name: "Fleet", mac: ["Fleet.app"], cli: ["fleet"] },
};

export const editorName = (editor: Editor): string => editors[editor].name;

/** An installed editor: what opens a folder here, and what opens an SSH host's, if it can. */
export type FoundEditor = { program: string; remote?: string };

/**
 * Each installed editor, in Open's order. macOS looks for its app bundle in the app folders,
 * not PATH: a Finder-launched app gets launchd's short PATH, and `cursor` on PATH may be Cursor
 * Agent's shim. Windows runs the editor's own exe, found from its `.cmd` on PATH, and lists only
 * editors with one. Linux runs its CLI on PATH.
 */
export function detectEditors(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean = existsSync,
): Partial<Record<Editor, FoundEditor>> {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dirs = (env["PATH"] ?? env["Path"] ?? "").split(p.delimiter).filter(Boolean);
  const apps = ["/Applications", ...(env["HOME"] ? [p.join(env["HOME"], "Applications")] : [])];
  const found: Partial<Record<Editor, FoundEditor>> = {};
  for (const [editor, where] of Object.entries(editors) as [Editor, typeof editors.vscode][]) {
    if (platform === "darwin") {
      const bundle = where.mac.flatMap((name) => apps.map((dir) => p.join(dir, name))).find(exists);
      if (!bundle) continue;
      const remote = where.remote && p.join(bundle, where.remote);
      found[editor] = { program: bundle, remote: remote && exists(remote) ? remote : undefined };
    } else if (platform === "win32") {
      const program =
        where.windows &&
        dirs
          .filter((dir) => where.cli.some((cli) => exists(p.join(dir, `${cli}.cmd`))))
          .map((dir) => p.resolve(dir, where.windows!))
          .find(exists);
      if (program) found[editor] = { program, remote: where.remote && program };
    } else {
      const program = where.cli.flatMap((cli) => dirs.map((d) => p.join(d, cli))).find(exists);
      if (program) found[editor] = { program, remote: where.remote && program };
    }
  }
  return found;
}

/** The macOS `.app` bundle `program` is in or is, following symlinks, or undefined. */
export const appBundle = (
  program: string,
  realpath: (file: string) => string = realpathSync,
): string | undefined => /^(.*?\.app)(?:\/|$)/.exec(realpath(program))?.[1];

/**
 * The argv that opens `folder` with an installed editor: on an SSH host through its Remote SSH
 * CLI with the host's saved destination, here with `open -a` on macOS, else its program.
 */
export function editorCommand(
  platform: NodeJS.Platform,
  editor: FoundEditor,
  folder: string,
  destination?: string,
): { file: string; args: string[] } {
  if (destination)
    return { file: editor.remote!, args: ["--remote", `ssh-remote+${destination}`, folder] };
  if (platform === "darwin") return { file: "/usr/bin/open", args: ["-a", editor.program, folder] };
  return { file: editor.program, args: [folder] };
}

/** An absolute folder path, on a POSIX or Windows host, with no control characters. */
export const isFolderPath = (value: unknown): value is string =>
  typeof value === "string" &&
  (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) &&
  !/\p{Cc}/u.test(value);

/** Whether `folder` is a directory on this computer, and not a file that opening would run. */
export const isDirectory = (folder: string): boolean =>
  statSync(folder, { throwIfNoEntry: false })?.isDirectory() ?? false;

/**
 * Starts `command` on its own, in `cwd` if given, without a shell. Resolves to an error for
 * people, or undefined.
 */
export function launch({
  file,
  args,
  cwd,
}: {
  file: string;
  args: string[];
  cwd?: string;
}): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, detached: true, stdio: "ignore", shell: false });
    child.once("error", (error) => resolve(`The app didn't start: ${error.message}`));
    child.once("spawn", () => {
      child.unref();
      resolve(undefined);
    });
  });
}
