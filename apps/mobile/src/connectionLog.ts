// This phone's connection log: the lines `protocol/connectionLog.ts` documents, kept in a private
// file out of backups, as Settings > About > Connection log shows and copies them. It holds the
// last `MAX_LINES`, so it can't grow. Logging never gets in a connection's way, so a failed write
// is dropped.
import { File } from "expo-file-system";

import { logLine, type LogFields } from "../../desktop/src/protocol/connectionLog";
import { privateFile } from "../modules/pinned-tls";

const MAX_LINES = 1000;
const file = new File(privateFile("connection-log.txt"));

let lines: string[] = (() => {
  try {
    return file.exists ? file.textSync().split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
})();

export function writeConnectionLine(line: string): void {
  lines = [...lines, line].slice(-MAX_LINES);
  try {
    file.write(lines.join("\n"));
  } catch {
    // See above.
  }
}

/** A line about the app itself, such as going to the background, which explains the next drop. */
export const logAppEvent = (event: string, fields: LogFields) =>
  writeConnectionLine(logLine(Date.now(), event, fields));

/** The log, oldest first. */
export const connectionLogText = () => lines.join("\n");
