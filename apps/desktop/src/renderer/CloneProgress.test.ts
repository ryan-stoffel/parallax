import { expect, test } from "vite-plus/test";

import { parseProgress } from "./CloneProgress";

test("git's progress line reads as its phase, percent, and speed", () => {
  expect(parseProgress("Receiving objects:  42% (420/1000), 12.40 MiB | 6.20 MiB/s")).toEqual({
    phase: "Receiving objects",
    percent: 42,
    detail: "12.40 MiB · 6.20 MiB/s",
  });
  expect(parseProgress("remote: Counting objects: 100% (12/12), done.")).toEqual({
    phase: "Counting objects",
    percent: 100,
  });
  expect(parseProgress("Cloning into 'app'...")).toEqual({ phase: "Cloning into 'app'..." });
});
