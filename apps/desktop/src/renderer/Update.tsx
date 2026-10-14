import {
  ArrowRight,
  Check,
  CircleAlert,
  CircleCheck,
  Download,
  LoaderCircle,
  RefreshCw,
  RotateCw,
  Server,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { UpdateState } from "../preload/bridge";
import { ClaudeLogo, CursorLogo, OpenAILogo, ParallaxMark } from "./logos";
import { notify } from "./notifications";
import { IconButton } from "./ui";
import {
  planSummary,
  restartInfo,
  selectPlans,
  unsettled,
  updateEverything,
  updatePrefs,
  updateRun,
  useUpdatePlan,
  type ItemStatus,
  type UpdateItem,
} from "./updateEverything";

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

const logos = { claude: ClaudeLogo, codex: OpenAILogo, cursor: CursorLogo };

/** An item's logo in a small tile: Parallax's mark, a server for plxd, or the provider's. */
function ItemIcon({ item }: { item: UpdateItem }) {
  const Logo = item.kind === "app" ? ParallaxMark : item.cli ? logos[item.cli] : undefined;
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-background">
      {Logo ? <Logo className="size-4" /> : <Server className="size-3.5 text-muted-foreground" />}
    </span>
  );
}

/** What the app's own row says about its download, which main reports. */
function appLine({ progress }: UpdateState, downloaded: string | undefined) {
  if (progress !== undefined) return `Downloading… ${progress}%`;
  if (downloaded) return "Downloaded. Parallax restarts to install it.";
  return undefined;
}

/**
 * One item to update: its logo, name, host when there are several, `from → to`, and how its update
 * is going. `children` go first, such as the dialog's checkbox.
 */
function ItemRow({
  item,
  status,
  line,
  showHost,
  children,
}: {
  item: UpdateItem;
  status?: ItemStatus;
  /** A line of its own about it, such as the app's download. */
  line?: string;
  showHost: boolean;
  children?: ReactNode;
}) {
  const running = status?.state === "running";
  return (
    <li className="flex items-center gap-2.5 py-1.5">
      {children}
      <ItemIcon item={item} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 text-[13px]">
          <span className="font-medium">{item.name}</span>
          {showHost && (
            <span className="truncate text-[12px] text-muted-foreground">{item.host}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center font-mono text-[11.5px] break-all text-muted-foreground">
          {item.from && (
            <>
              <span>{item.from}</span>
              <ArrowRight aria-label="to" className="mx-1 size-3 shrink-0" />
            </>
          )}
          <span className="text-foreground">
            {status?.state === "done" ? (status.version ?? item.to) : item.to}
          </span>
        </div>
        {status?.state === "failed" ? (
          <p role="alert" className="mt-0.5 text-[12px] break-words text-danger">
            {status.error}
          </p>
        ) : (
          line && <p className="mt-0.5 text-[12px] text-muted-foreground">{line}</p>
        )}
      </div>
      <span className="grid size-4 shrink-0 place-items-center" aria-live="polite">
        {running ? (
          <LoaderCircle
            aria-label="Updating"
            className="size-4 animate-spin text-muted-foreground"
          />
        ) : status?.state === "done" ? (
          <CircleCheck aria-label="Updated" className="size-4 text-added" />
        ) : status?.state === "failed" ? (
          <CircleAlert aria-label="Failed" className="size-4 text-danger" />
        ) : null}
      </span>
    </li>
  );
}

/** A release's notes, scrolling past a few lines, with a link to its page. */
function Changelog({ available }: { available: NonNullable<UpdateState["available"]> }) {
  return (
    <div className="mt-2 rounded-md border border-border bg-background/60 p-2.5">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h3 className="text-[12px] font-medium">What's new in Parallax</h3>
        <a href={available.url} className="shrink-0 text-[12px] text-accent hover:underline">
          Full changelog
        </a>
      </div>
      <p className="max-h-40 overflow-y-auto text-[12.5px] whitespace-pre-line text-muted-foreground">
        {available.notes || "No notes for this release."}
      </p>
    </div>
  );
}

/**
 * The sidebar footer's Update button, for an `updatable` app (PLX-746, PLX-783). Anything to
 * update, a packaged app's newer release, a remote host's older plxd, or a host's outdated Claude
 * Code or Codex, shows as a download icon with a dot. Hovering it opens a card above the button
 * listing each with its logo and `from → to`, and the release's notes, which stays open while the
 * pointer is on the button or the card. A click opens a dialog to review them: each has a
 * checkbox, and Update all, or Update selected, runs them, each row showing how it's going, and
 * restarts Parallax last when its release was chosen. Once the release has downloaded, the icon
 * is a restart icon with a check (`useUpdateAlarms` says so). `updatePrefs` can download releases
 * and update providers as soon as they're found. Under `pnpm dev` it offers the commits main has,
 * a click takes them, and the card shows the answer. Its label carries the updater's note, such
 * as an error.
 */
export function UpdateButton() {
  const id = useId();
  const card = useRef<HTMLDivElement>(null);
  const confirm = useRef<HTMLDialogElement>(null);
  const state = useUpdateState();
  const prefs = updatePrefs.use();
  // Under `pnpm dev`, "Updating…" while Update runs, then its answer until the next click.
  const [answer, setAnswer] = useState<string>();
  const updating = answer === "Updating…";
  const { available, progress, note } = state;
  // What's on offer is being taken while it updates.
  const ready = updating ? undefined : state.ready;
  const downloaded = downloadedVersion(state);
  const downloading = progress !== undefined;
  const { plans, items, upgraded } = useUpdatePlan(state);
  // Each item's update by key, the items the last Update took, and those unticked in the dialog.
  const { statuses, taken, tried } = updateRun.use();
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const busy = Object.values(statuses).some(unsettled);
  // Running threads the confirmed update cuts off, whether they go on after it as the hosts have
  // it, and as the user chose, which alone is saved to the hosts.
  const [restart, setRestart] = useState<{
    running: Record<string, number>;
    continueThreads: boolean;
  }>({ running: {}, continueThreads: true });
  const [continueThreads, setContinueThreads] = useState<boolean>();

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
  const hoverable = items.length > 0;

  // Each release and provider version runs once on its own, so a failed one isn't retried on
  // every check.
  const offered = items.map((item) => `${item.key}@${item.to}`).join(" ");
  useEffect(() => {
    const fresh = items.filter(
      (item) =>
        !tried.has(`${item.key}@${item.to}`) &&
        (item.kind === "app"
          ? prefs.autoDownload && !downloaded && !downloading
          : item.kind === "provider" && prefs.autoProviders),
    );
    if (fresh.length === 0) return;
    updateRun.set({ tried: new Set([...tried, ...fresh.map((item) => `${item.key}@${item.to}`)]) });
    // A release only downloads here; Update restarts into it.
    if (fresh.some((item) => item.kind === "app")) void window.parallax.update();
    const keys = new Set(fresh.filter((item) => item.kind === "provider").map((item) => item.key));
    if (keys.size > 0)
      void updateEverything(selectPlans(plans, keys), undefined, true, upgraded, updateRun.report);
    // `offered` stands for `items` and `plans`.
  }, [prefs.autoDownload, prefs.autoProviders, offered, downloaded, downloading]);

  const chosen = items.filter((item) => !unticked.has(item.key));
  const rows = taken ?? items;
  const settled = taken !== undefined && !busy;
  // Running threads on the hosts a chosen update restarts.
  const running = [
    ...new Set(chosen.filter((item) => item.kind !== "provider").map((item) => item.hostId)),
  ].reduce((n, hostId) => n + (restart.running[hostId] ?? 0), 0);

  const click = async (source: HTMLElement) => {
    if (items.length > 0 || busy) {
      card.current?.togglePopover(false);
      confirm.current?.showModal();
      if (busy) return;
      setUnticked(new Set());
      setRestart({ running: {}, continueThreads: true });
      setContinueThreads(undefined);
      setRestart(await restartInfo(plans));
      return;
    }
    open(source);
    setAnswer("Updating…");
    setAnswer(await window.parallax.update());
  };
  const start = () => {
    const keys = new Set(chosen.map((item) => item.key));
    updateRun.set({ statuses: {}, taken: chosen });
    const appReady = downloaded !== undefined;
    void updateEverything(
      selectPlans(plans, keys),
      continueThreads,
      appReady,
      upgraded,
      updateRun.report,
    );
  };
  const tick = (key: string, on: boolean) =>
    setUnticked((old) => {
      const next = new Set(old);
      if (on) next.delete(key);
      else next.add(key);
      return next;
    });

  const onlyApp = items.length === 1 && items[0]!.kind === "app";
  const label = downloading
    ? `Downloading Parallax ${available?.version}: ${progress}%`
    : busy
      ? "Updating…"
      : onlyApp && downloaded
        ? `Restart to install Parallax ${downloaded}`
        : onlyApp
          ? `Update available: Parallax ${available?.version}`
          : items.length > 0
            ? `Update ${planSummary(plans)}`
            : ready
              ? `Update ready: ${ready}`
              : (note ?? "Update Parallax");
  const showHost = new Set(rows.map((item) => item.hostId)).size > 1;
  const line = (item: UpdateItem) => (item.kind === "app" ? appLine(state, downloaded) : undefined);
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
        {busy ? (
          <LoaderCircle className="animate-spin" />
        ) : onlyApp && downloaded ? (
          <span className="relative grid">
            <RotateCw />
            <span
              aria-hidden
              className="absolute -right-1 -bottom-1 grid size-2.5 place-items-center rounded-full bg-foreground text-sidebar"
            >
              <Check strokeWidth={4} className="size-2!" />
            </span>
          </span>
        ) : items.length > 0 || ready ? (
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
        className="inset-auto m-0 mb-2 w-[22rem] rounded-lg border border-border bg-surface p-3 text-foreground shadow-composer [position-area:top] [position-try-fallbacks:flip-block]"
      >
        {items.length > 0 ? (
          <>
            <h2 className="text-[13.5px] font-medium">
              {busy
                ? "Updating…"
                : `${items.length} ${items.length === 1 ? "update" : "updates"} available`}
            </h2>
            <ul className="mt-1">
              {items.map((item) => (
                <ItemRow
                  key={item.key}
                  item={item}
                  status={statuses[item.key]}
                  line={line(item)}
                  showHost={new Set(items.map((i) => i.hostId)).size > 1}
                />
              ))}
            </ul>
            {available && <Changelog available={available} />}
            {downloading && (
              <div
                role="progressbar"
                aria-label="Download"
                aria-valuenow={progress}
                className="mt-2 h-1 overflow-hidden rounded-full bg-selected"
              >
                <div
                  className="h-full rounded-full bg-accent transition-[width]"
                  style={{ width: `${progress}%` }}
                />
              </div>
            )}
            {note && !downloading && (
              <p role="alert" className="mt-2 text-[12.5px] text-danger">
                {note}
              </p>
            )}
            <p className="mt-2 text-[12px] text-muted-foreground">Click to review and update.</p>
          </>
        ) : (
          <p role="status" className="text-[12.5px] text-muted-foreground">
            {answer ?? note ?? "Up to date"}
          </p>
        )}
      </div>
      <dialog
        ref={confirm}
        // A finished run is cleared, so the next click reviews what's on offer then.
        onClose={() => !busy && updateRun.set({ statuses: {}, taken: undefined })}
        aria-labelledby={`${id}-confirm`}
        className="m-auto w-[30rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
      >
        <div className="px-5 pt-4 pb-3">
          <h2 id={`${id}-confirm`} className="text-[15px] font-semibold">
            {settled ? "Updates finished" : busy ? "Updating…" : "Updates available"}
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {settled
              ? Object.values(statuses).some((s) => s.state === "failed")
                ? "Some updates failed. Try them again from Update."
                : "Everything you chose is up to date."
              : taken
                ? "You can close this; updates keep going."
                : "Choose what to update. Parallax restarts last, if it's chosen."}
          </p>
          <ul className="mt-2 divide-y divide-border">
            {rows.map((item) => (
              <ItemRow
                key={item.key}
                item={item}
                status={statuses[item.key]}
                line={
                  line(item) ?? (statuses[item.key]?.state === "waiting" ? "Waiting…" : undefined)
                }
                showHost={showHost}
              >
                {!taken && (
                  <input
                    type="checkbox"
                    aria-label={`Update ${item.name}${showHost ? ` on ${item.host}` : ""}`}
                    checked={!unticked.has(item.key)}
                    onChange={(e) => tick(item.key, e.target.checked)}
                  />
                )}
              </ItemRow>
            ))}
          </ul>
          {available && rows.some((item) => item.kind === "app") && (
            <Changelog available={available} />
          )}
          {!taken && running > 0 && (
            <>
              <p className="mt-4 text-[13px]">
                {running} running {running === 1 ? "thread" : "threads"} will be interrupted.
              </p>
              <label className="mt-2 flex items-center gap-2 text-[13px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={continueThreads ?? restart.continueThreads}
                  onChange={(e) => setContinueThreads(e.target.checked)}
                />
                Continue threads after restarts
              </label>
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          {!settled && (
            <button
              type="button"
              value="cancel"
              onClick={() => confirm.current?.close()}
              className="rounded-md px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              {taken ? "Close" : "Cancel"}
            </button>
          )}
          <button
            type="button"
            value="confirm"
            autoFocus
            disabled={busy || (!taken && chosen.length === 0)}
            onClick={() => (taken ? confirm.current?.close() : start())}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy && <LoaderCircle className="size-3.5 animate-spin" />}
            {settled
              ? "Done"
              : busy
                ? "Updating…"
                : chosen.length === items.length
                  ? "Update all"
                  : `Update ${chosen.length} selected`}
          </button>
        </div>
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
