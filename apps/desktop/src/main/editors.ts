import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { OpenTarget } from "../preload/bridge";

export type Editor = Exclude<OpenTarget, "files" | "terminal">;

/**
 * Where each editor is: its CLI's name on PATH, the CLI inside its macOS app bundle, and on
 * Windows its app next to the `.cmd` on PATH, which Node can't run without a shell.
 */
const editors: Record<Editor, { cli: string; mac: string; windows: string }> = {
  cursor: {
    cli: "cursor",
    mac: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
    windows: "../../../Cursor.exe",
  },
  vscode: {
    cli: "code",
    mac: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    windows: "../Code.exe",
  },
};

export const isEditor = (value: unknown): value is Editor =>
  typeof value === "string" && Object.hasOwn(editors, value);

/**
 * The program that opens a folder in each installed editor. macOS looks in the app bundle first:
 * a Finder-launched app gets launchd's short PATH, and `cursor` on PATH may be Cursor Agent's
 * shim. Windows runs the editor's own exe, found from its `.cmd` on PATH.
 */
export function detectEditors(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean = existsSync,
): Partial<Record<Editor, string>> {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dirs = (env["PATH"] ?? env["Path"] ?? "").split(p.delimiter).filter(Boolean);
  const found: Partial<Record<Editor, string>> = {};
  for (const [editor, where] of Object.entries(editors) as [Editor, typeof editors.cursor][]) {
    const program =
      platform === "win32"
        ? dirs
            .filter((dir) => exists(p.join(dir, `${where.cli}.cmd`)))
            .map((dir) => p.resolve(dir, where.windows))
            .find(exists)
        : [
            ...(platform === "darwin" ? [where.mac] : []),
            ...dirs.map((d) => p.join(d, where.cli)),
          ].find(exists);
    if (program) found[editor] = program;
  }
  return found;
}

/** The macOS `.app` bundle `program` is in or is, following symlinks, or undefined. */
export const appBundle = (
  program: string,
  realpath: (file: string) => string = realpathSync,
): string | undefined => /^(.*?\.app)(?:\/|$)/.exec(realpath(program))?.[1];

/**
 * The argv that opens `folder` with an editor's `program`: here, or on an SSH host through the
 * editor's Remote SSH, with the host's saved destination.
 */
export function editorCommand(
  program: string,
  folder: string,
  destination?: string,
): { file: string; args: string[] } {
  const remote = destination ? ["--remote", `ssh-remote+${destination}`] : [];
  return { file: program, args: [...remote, folder] };
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
