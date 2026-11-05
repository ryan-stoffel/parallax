import { isDeviceAddress, isSshUser } from "./connect";

// Open in on another computer (PLX-1343): the parts that need no Electron. Editors reach it with
// their Remote SSH, and terminals with an ssh session started in the thread's folder.

/** The account whose home holds `folder`: `me` for /Users/me/x, /home/me/x, or C:\Users\me\x. */
export function folderUser(folder: string): string | undefined {
  const user = /^(?:\/Users\/|\/home\/|[a-z]:\\Users\\)([^/\\]+)/i.exec(folder)?.[1];
  return isSshUser(user) ? user : undefined;
}

/**
 * The ssh destination for a computer with no saved one. An alias in the user's ssh config that
 * matches one of `names` wins, since it brings its own user, key, and port. Otherwise `address`,
 * as the user who owns `folder`, since this computer's user name may not be the one there.
 * Undefined with neither, for the user to set.
 */
export function deriveDestination({
  names,
  aliases,
  address,
  folder,
}: {
  names: (string | undefined)[];
  aliases: string[];
  address?: string;
  folder: string;
}): string | undefined {
  const known = new Map(aliases.map((alias) => [alias.toLowerCase(), alias]));
  for (const name of names) {
    const alias = name && known.get(name.toLowerCase());
    if (alias) return alias;
  }
  if (!isDeviceAddress(address)) return undefined;
  const user = folderUser(folder);
  return user ? `${user}@${address}` : address;
}

const posixQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** What the host runs to start the user's shell in `folder`, by the kind of path it is. */
export const shellInFolder = (folder: string) =>
  folder.startsWith("/")
    ? `cd ${posixQuote(folder)} && exec "$SHELL" -l`
    : `powershell -NoExit -Command "Set-Location -LiteralPath '${folder.replaceAll("'", "''")}'"`;

/** The ssh command that opens a shell in `folder` on `destination`, which can prompt here. */
export const sshShellCommand = (ssh: string, destination: string, folder: string): string[] => [
  ssh,
  "-t",
  "--",
  destination,
  shellInFolder(folder),
];

/**
 * A script that removes itself and runs `command`, for a macOS terminal app, which `open` can only
 * hand a file.
 */
export const selfDeletingScript = (command: string[]) =>
  `#!/bin/sh\nrm -f "$0"\nexec ${command.map(posixQuote).join(" ")}\n`;
