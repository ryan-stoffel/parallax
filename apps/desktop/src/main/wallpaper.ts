import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Finds a display's wallpaper through the Objective-C bridge. It sends no Apple events, so macOS
// asks for no permission.
const wallpaperPath = `
ObjC.import("AppKit");
function run(argv) {
  for (const screen of ObjC.unwrap($.NSScreen.screens)) {
    if (ObjC.unwrap(screen.deviceDescription.objectForKey("NSScreenNumber")) === Number(argv[0]))
      return ObjC.unwrap($.NSWorkspace.sharedWorkspace.desktopImageURLForScreen(screen).path);
  }
  return "";
}`;

/**
 * The macOS wallpaper of the display `displayId`, as a JPEG at most `longestSide` pixels long, or
 * null if it can't be read. A moving wallpaper gives its still.
 */
export async function wallpaperJpeg(
  displayId: number,
  longestSide: number,
): Promise<Buffer | null> {
  let folder: string | undefined;
  try {
    folder = await mkdtemp(path.join(tmpdir(), "parallax-wallpaper-"));
    const { stdout } = await run("/usr/bin/osascript", [
      "-l",
      "JavaScript",
      "-e",
      wallpaperPath,
      String(displayId),
    ]);
    const source = stdout.trim();
    if (!source) return null;
    // sips, since Chromium can't show the HEIC most wallpapers are.
    const out = path.join(folder, "wallpaper.jpg");
    await run("/usr/bin/sips", [
      "-s",
      "format",
      "jpeg",
      "-Z",
      String(longestSide),
      source,
      "--out",
      out,
    ]);
    return await readFile(out);
  } catch {
    return null;
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true });
  }
}
