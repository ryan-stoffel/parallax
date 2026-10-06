import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

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
 * The command that opens `folder` in terminal `app`. macOS hands the folder to the app with
 * `open -a`, which every terminal there takes as where to start. Elsewhere the app starts in it.
 */
export function terminalCommand(
  platform: NodeJS.Platform,
  app: string,
  folder: string,
): { file: string; args: string[]; cwd?: string } {
  return platform === "darwin"
    ? { file: "/usr/bin/open", args: ["-a", app, folder] }
    : { file: app, args: [], cwd: folder };
}
