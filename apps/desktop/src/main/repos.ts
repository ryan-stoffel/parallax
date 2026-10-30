import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { isFolderName, type FolderListing } from "../preload/bridge";

const run = promisify(execFile);

/** `~` or a path under it, made absolute against `home`. Anything else resolves as it is. */
function expandHome(input: string, home = homedir()): string {
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(home, input.slice(2));
  return path.resolve(input);
}

/** The folders in `input`, a folder path that may start with `~`, by name. */
export async function listFolders(input: string): Promise<FolderListing> {
  const dir = expandHome(input);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const folders = await Promise.all(
      entries.map(async (e) => {
        // A symlink counts when it points at a folder, such as a linked ~/Developer.
        const isDir =
          e.isDirectory() ||
          (e.isSymbolicLink() &&
            (await stat(path.join(dir, e.name)).then(
              (s) => s.isDirectory(),
              () => false,
            )));
        return isDir ? { name: e.name, path: path.join(dir, e.name) } : undefined;
      }),
    );
    return {
      path: dir,
      folders: folders
        .filter((f) => f !== undefined)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    };
  } catch (error) {
    return {
      error: `Can't open ${input}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
    };
  }
}

/** The last line git wrote to stderr, which says what went wrong. */
const gitError = (error: unknown) =>
  String((error as { stderr?: string }).stderr || (error as Error).message)
    .trim()
    .split("\n")
    .at(-1);

// Never waits on a prompt.
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

/**
 * New Repository: `<home>/.parallax/projects/<name>` with `git init` and an empty first commit,
 * which a thread's worktree and an orchestrator need. A failure removes the folder it
 * made. Resolves to its path, or an error for people.
 */
export async function createRepo(
  name: string,
  home = homedir(),
): Promise<{ path: string } | { error: string }> {
  if (!isFolderName(name)) return { error: "Use letters, digits, ., _, and - only" };
  const root = path.join(home, ".parallax", "projects");
  const dir = path.join(root, name);
  try {
    await mkdir(root, { recursive: true });
    await mkdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      error:
        code === "EEXIST"
          ? `~/.parallax/projects/${name} already exists`
          : `Can't create ~/.parallax/projects/${name}: ${code ?? String(error)}`,
    };
  }
  try {
    const options = { cwd: dir, env: gitEnv() };
    await run("git", ["init", "-q"], options);
    await run("git", ["commit", "-q", "--allow-empty", "-m", "Initial commit"], options);
    return { path: dir };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    return { error: gitError(error) ?? "git failed" };
  }
}
