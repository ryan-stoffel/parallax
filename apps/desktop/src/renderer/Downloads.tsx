import { useEffect, useId } from "react";

import type { DownloadInfo } from "../preload/bridge";
import { memory } from "./stored";
import { Close, Download, FolderOpen } from "./symbols";
import { formatBytes } from "./settings/parts";
import { IconButton, Menu, menuHeading } from "./ui";

// The browser's downloads (PLX-975): main saves and tracks them (downloads.ts), and every
// toolbar shows them.

const downloads = memory<DownloadInfo[]>([]);
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  void window.parallax.downloads().then((list) => downloads.set(list));
  window.parallax.onDownloads((list) => downloads.set(list));
}

/** How many downloads are running, and how far along they are together, 0 to 1 when known. */
export function downloadSummary(list: readonly DownloadInfo[]) {
  const running = list.filter((d) => d.state === "progressing");
  const total = running.reduce((n, d) => n + d.total, 0);
  const received = running.reduce((n, d) => n + d.received, 0);
  return {
    running: running.length,
    progress:
      running.length && total > 0 && running.every((d) => d.total > 0)
        ? received / total
        : undefined,
  };
}

/** A download's line under its name: its progress, its size, or what became of it. */
export function downloadStatus(d: DownloadInfo): string {
  if (d.state === "progressing")
    return d.paused
      ? "Paused"
      : d.total > 0
        ? `${formatBytes(d.received)} of ${formatBytes(d.total)}`
        : formatBytes(d.received);
  if (d.state === "completed") return formatBytes(d.total || d.received);
  return d.state === "cancelled" ? "Cancelled" : "Failed";
}

/**
 * The toolbar's downloads button, as Chrome's: there once there's a download, ringed with the
 * running ones' progress, and opening their list, the newest first, where a finished one opens
 * on a click or shows in its folder, a running one cancels, and Clear forgets the finished.
 */
export function DownloadsButton() {
  const list = downloads.use();
  useEffect(listen, []);
  const id = useId();
  if (!list.length) return null;
  const { running, progress } = downloadSummary(list);
  const ring = 2 * Math.PI * 10;
  return (
    <>
      <IconButton
        label={running ? `Downloads, ${running} running` : "Downloads"}
        popoverTarget={id}
        aria-haspopup="menu"
      >
        <span className="relative grid place-items-center">
          <Download />
          {running > 0 && (
            <svg aria-hidden viewBox="0 0 24 24" className="absolute size-6! -rotate-90">
              <circle
                cx="12"
                cy="12"
                r="10"
                fill="none"
                strokeWidth="2"
                className="stroke-border"
              />
              <circle
                cx="12"
                cy="12"
                r="10"
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={ring}
                strokeDashoffset={ring * (1 - (progress ?? 0.25))}
                className={`stroke-accent ${progress === undefined ? "origin-center animate-spin" : ""}`}
              />
            </svg>
          )}
        </span>
      </IconButton>
      <Menu id={id} label="Downloads" align="end" className="max-h-96 w-80 overflow-y-auto p-1">
        <div className="flex items-center justify-between pr-1">
          <p className={menuHeading}>Downloads</p>
          <button
            type="button"
            role="menuitem"
            onClick={() => window.parallax.downloadAction(undefined, "clear")}
            className="rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            Clear
          </button>
        </div>
        {list.map((d) => (
          <div
            key={d.id}
            className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover"
          >
            {/* Every row's name is a menu item the arrow keys reach, opening only a finished file. */}
            <button
              type="button"
              role="menuitem"
              aria-disabled={d.state !== "completed"}
              title={d.state === "completed" ? `Open ${d.name}` : d.url}
              onClick={() =>
                d.state === "completed" && window.parallax.downloadAction(d.id, "open")
              }
              className="flex min-w-0 flex-1 flex-col text-left"
            >
              <span
                className={`truncate text-[13px] ${d.state === "cancelled" || d.state === "interrupted" ? "text-muted-foreground line-through" : ""}`}
              >
                {d.name}
              </span>
              <span className="text-[11.5px] text-muted-foreground">{downloadStatus(d)}</span>
              {d.state === "progressing" && d.total > 0 && (
                <span className="mt-1 h-1 overflow-hidden rounded-full bg-border">
                  <span
                    className="block h-full rounded-full bg-accent"
                    style={{ width: `${Math.round((d.received / d.total) * 100)}%` }}
                  />
                </span>
              )}
            </button>
            {d.state === "progressing" ? (
              <IconButton
                role="menuitem"
                label={`Cancel ${d.name}`}
                onClick={() => window.parallax.downloadAction(d.id, "cancel")}
              >
                <Close />
              </IconButton>
            ) : (
              d.path &&
              d.state === "completed" && (
                <IconButton
                  role="menuitem"
                  label={`Show ${d.name} in folder`}
                  onClick={() => window.parallax.downloadAction(d.id, "show")}
                >
                  <FolderOpen />
                </IconButton>
              )
            )}
          </div>
        ))}
      </Menu>
    </>
  );
}
