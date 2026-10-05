import { Check, Download, RefreshCw, RotateCw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { UpdateState } from "../preload/bridge";
import { notify } from "./notifications";
import { IconButton } from "./ui";

/** The updater's state from main, kept current, in an `updatable` app. */
function useUpdateState(): UpdateState {
  const [state, setState] = useState<UpdateState>({});
  useEffect(() => {
    if (window.parallax.updatable) return window.parallax.onUpdateState(setState);
  }, []);
  return state;
}

/** The version of a packaged app's release that finished downloading, if one has. */
const downloadedVersion = ({ available, ready }: UpdateState) =>
  available && ready !== undefined ? available.version : undefined;

/**
 * The sidebar footer's Update button, for an `updatable` app. In a packaged app, a newer release
 * shows as a download icon with a dot. Hovering it opens a card above the button with the
 * release's notes, which stays open while the pointer is on the button or the card. A click
 * opens the same card and starts the download, whose progress the card shows; the dot goes away.
 * Once downloaded, the icon is a restart icon with a check, and a click asks to confirm before it
 * installs and restarts (`useUpdateAlarms` says so). Under `pnpm dev` it offers the commits main has, a
 * click takes them, and the card shows the answer. Its label carries the updater's note, such as
 * an error.
 */
export function UpdateButton() {
  const id = useId();
  const card = useRef<HTMLDivElement>(null);
  const confirm = useRef<HTMLDialogElement>(null);
  const state = useUpdateState();
  // Under `pnpm dev`, "Updating…" while Update runs, then its answer until the next click.
  const [answer, setAnswer] = useState<string>();
  const updating = answer === "Updating…";
  const { available, progress, note } = state;
  // What's on offer is being taken while it updates.
  const ready = updating ? undefined : state.ready;
  const downloaded = downloadedVersion(state);
  const downloading = progress !== undefined;

  // The pointer crosses the gap between the button and the card before the card closes.
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const open = (source?: HTMLElement) => {
    clearTimeout(closing.current);
    card.current?.togglePopover({ force: true, source });
  };
  const close = () => {
    clearTimeout(closing.current);
    closing.current = setTimeout(() => card.current?.togglePopover(false), 150);
  };
  useEffect(() => () => clearTimeout(closing.current), []);
  useEffect(() => {
    if (downloaded) card.current?.togglePopover(false);
  }, [downloaded]);
  // Hovering shows a release's notes until it's downloaded.
  const hoverable = available !== undefined && !downloaded;

  const click = async (source: HTMLElement) => {
    if (downloaded) return confirm.current?.showModal();
    open(source);
    if (available) return void window.parallax.update();
    setAnswer("Updating…");
    setAnswer(await window.parallax.update());
  };

  const label = downloaded
    ? `Restart to install Parallax ${downloaded}`
    : available
      ? downloading
        ? `Downloading Parallax ${available.version}: ${progress}%`
        : `Update available: Parallax ${available.version}`
      : ready
        ? `Update ready: ${ready}`
        : (note ?? "Update Parallax");
  return (
    <span className="ml-auto">
      <IconButton
        label={label}
        // The card stands in for the tooltip.
        title={hoverable ? undefined : label}
        aria-haspopup="dialog"
        disabled={updating}
        onClick={(e) => void click(e.currentTarget)}
        onPointerEnter={hoverable ? (e) => open(e.currentTarget) : undefined}
        onPointerLeave={close}
        onBlur={close}
      >
        {downloaded ? (
          <span className="relative grid">
            <RotateCw />
            <span
              aria-hidden
              className="absolute -right-1 -bottom-1 grid size-2.5 place-items-center rounded-full bg-foreground text-sidebar"
            >
              <Check strokeWidth={4} className="size-2!" />
            </span>
          </span>
        ) : available || ready ? (
          <span className="relative grid">
            <Download />
            {!downloading && (
              <span
                aria-hidden
                className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-accent"
              />
            )}
          </span>
        ) : (
          <RefreshCw className={updating ? "animate-spin" : undefined} />
        )}
      </IconButton>
      <div
        ref={card}
        id={id}
        popover="manual"
        aria-label="Update"
        onPointerEnter={() => open()}
        onPointerLeave={close}
        onFocus={() => open()}
        onBlur={close}
        className="inset-auto m-0 mb-2 w-80 rounded-lg border border-border bg-surface p-3 text-foreground shadow-composer [position-area:top] [position-try-fallbacks:flip-block]"
      >
        {available ? (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-[13.5px] font-medium">Parallax {available.version}</h2>
              <a href={available.url} className="shrink-0 text-[12px] text-accent hover:underline">
                Full changelog
              </a>
            </div>
            <p className="mt-2 max-h-48 overflow-y-auto text-[12.5px] whitespace-pre-line text-muted-foreground">
              {available.notes || "No notes for this release."}
            </p>
            {downloading ? (
              <div className="mt-3">
                <div className="mb-1 flex justify-between text-[12px] text-muted-foreground">
                  <span>Downloading…</span>
                  <span>{progress}%</span>
                </div>
                <div
                  role="progressbar"
                  aria-label="Download"
                  aria-valuenow={progress}
                  className="h-1.5 overflow-hidden rounded-full bg-selected"
                >
                  <div
                    className="h-full rounded-full bg-accent transition-[width]"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            ) : (
              note && (
                <p role="alert" className="mt-3 text-[12.5px] text-danger">
                  {note}
                </p>
              )
            )}
          </>
        ) : (
          <p role="status" className="text-[12.5px] text-muted-foreground">
            {answer ?? note ?? "Up to date"}
          </p>
        )}
      </div>
      <dialog
        ref={confirm}
        aria-labelledby={`${id}-confirm`}
        className="m-auto w-[28rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
      >
        <form
          method="dialog"
          onSubmit={(e) => {
            if ((e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "confirm")
              void window.parallax.update();
          }}
        >
          <div className="px-5 pt-4 pb-4">
            <h2 id={`${id}-confirm`} className="text-[15px] font-semibold">
              Install update {downloaded} and restart Parallax?
            </h2>
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              Any running tasks will be interrupted. Make sure you're ready before continuing.
            </p>
          </div>
          <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
            <button
              type="submit"
              value="cancel"
              className="rounded-md px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              value="confirm"
              autoFocus
              className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:opacity-90"
            >
              Confirm
            </button>
          </div>
        </form>
      </dialog>
    </span>
  );
}

/**
 * Notifications for a packaged app's update: once a release has downloaded, a toast pointing to
 * the Update button's restart, with a link to the release, that stays until closed; and when a
 * download fails, or a downloaded release won't install, why.
 */
export function useUpdateAlarms() {
  const state = useUpdateState();
  const downloaded = downloadedVersion(state);
  const url = state.available?.url;
  // Whether the last state was downloading or downloaded, so a note after it is its failure, and
  // the version last announced, so a closed toast stays closed.
  const busy = useRef(false);
  const announced = useRef<string>(undefined);
  const { progress, note } = state;
  useEffect(() => {
    const wasBusy = busy.current;
    busy.current = progress !== undefined || downloaded !== undefined;
    if (downloaded !== undefined) {
      if (announced.current === downloaded) return;
      announced.current = downloaded;
      notify({
        key: "update",
        tone: "success",
        title: "Update downloaded",
        body: "Restart the app from the update button to install it.",
        action: url ? { label: "Read more", href: url } : undefined,
        sticky: true,
      });
    } else if (wasBusy && progress === undefined && note)
      notify({ key: "update", tone: "error", title: "Update failed", body: note });
  }, [downloaded, url, progress, note]);
}
