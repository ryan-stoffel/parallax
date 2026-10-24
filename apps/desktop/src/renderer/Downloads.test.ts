import { expect, test } from "vite-plus/test";

import type { DownloadInfo } from "../preload/bridge";
import { downloadStatus, downloadSummary } from "./Downloads";

const download = (patch: Partial<DownloadInfo>): DownloadInfo => ({
  id: "1",
  name: "a.zip",
  url: "https://example.com/a.zip",
  state: "progressing",
  received: 0,
  total: 0,
  ...patch,
});

test("the downloads button sums the running downloads' progress, when every size is known", () => {
  expect(
    downloadSummary([
      download({ received: 25, total: 100 }),
      download({ received: 75, total: 100 }),
      download({ state: "completed", received: 10, total: 10 }),
    ]),
  ).toEqual({ running: 2, progress: 0.5 });
  expect(downloadSummary([download({ received: 5 })])).toEqual({ running: 1, progress: undefined });
  expect(downloadSummary([])).toEqual({ running: 0, progress: undefined });
});

test("a download's line reads its progress, its size, or what became of it", () => {
  expect(downloadStatus(download({ received: 1536, total: 2048 }))).toBe("1.5 KB of 2.0 KB");
  expect(downloadStatus(download({ paused: true }))).toBe("Paused");
  expect(downloadStatus(download({ state: "completed", total: 2048 }))).toBe("2.0 KB");
  expect(downloadStatus(download({ state: "cancelled" }))).toBe("Cancelled");
  expect(downloadStatus(download({ state: "interrupted" }))).toBe("Failed");
});
