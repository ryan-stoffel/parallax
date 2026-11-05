import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { startConnectionLog, writeConnectionLine } from "./connectionLogFile";

test("appends lines, and past 1 MiB rotates, keeping two old files", () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "connection-log-")), "logs");
  const file = path.join(dir, "connection.log");
  try {
    startConnectionLog(dir);
    writeConnectionLine("first");
    writeConnectionLine("second");
    expect(readFileSync(file, "utf8")).toBe("first\nsecond\n");

    const full = "x".repeat(1024 * 1024);
    for (const name of ["one", "two", "three"]) {
      writeConnectionLine(full);
      writeConnectionLine(name);
    }
    const first = (at: string) => readFileSync(at, "utf8").split("\n")[0];
    expect(first(file)).toBe("three");
    expect(first(`${file}.1`)).toBe("two");
    expect(first(`${file}.2`)).toBe("one");
    expect(existsSync(`${file}.3`)).toBe(false);
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});
