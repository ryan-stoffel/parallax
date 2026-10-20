import {
  Camera,
  Check,
  ChevronLeft,
  Circle,
  House,
  LayoutGrid,
  LoaderCircle,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Smartphone,
  Triangle,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { DeviceInfo, DevicePlatform, DeviceStateResult } from "../protocol/generated/protocol";
import {
  createDeviceStream,
  type DeviceScreen,
  type DeviceStream,
  type DeviceStreamStatus,
} from "./deviceStream";
import { IconButton } from "./ui";

const primary =
  "flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50 [&_svg]:size-3.5";
const secondary =
  "flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-[12px] font-medium text-foreground enabled:hover:bg-hover disabled:opacity-50 [&_svg]:size-3.5";

/** How often the device list refreshes while it shows, or while the hub installs. */
const REFRESH_MS = 3_000;

/** The device each thread last watched, by host and thread, so coming back shows it again. */
const watched = new Map<string, string>();

/**
 * The Device panel (PLX-886): the host's iOS Simulators and Android Emulators, and a live,
 * touchable view of one, streamed through plxd. `shown` is whether it's on screen; only then does
 * it stream. Each new `request` shows its device, such as one the thread's agent opened.
 */
export function DevicePanel({
  hostId,
  runId,
  shown,
  request,
}: {
  hostId: string;
  runId?: string;
  shown: boolean;
  request?: { deviceId?: string };
}) {
  const key = `${hostId}/${runId ?? ""}`;
  const [state, setState] = useState<DeviceStateResult | { error: string }>();
  const [selected, setSelected] = useState(() => watched.get(key));
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string>();
  const [seenKey, setSeenKey] = useState(key);
  if (key !== seenKey) {
    setSeenKey(key);
    setSelected(watched.get(key));
    setFailure(undefined);
  }
  const select = (id: string | undefined) => {
    if (id) watched.set(key, id);
    else watched.delete(key);
    setSelected(id);
    setFailure(undefined);
  };

  const refresh = async () => {
    const answer = await window.parallax.request(hostId, "device/state", runId ? { runId } : {});
    if ("error" in answer) {
      setState({
        error:
          answer.error.code === -32601
            ? "This host's plxd is too old to show devices. Update Parallax there."
            : answer.error.message,
      });
      return undefined;
    }
    setState(answer.result);
    return answer.result;
  };

  const [requested, setRequested] = useState(request);
  if (request !== requested) {
    setRequested(request);
    if (request?.deviceId) select(request.deviceId);
  }

  const result = state && !("error" in state) ? state : undefined;
  const device = result?.devices.find((d) => d.id === selected);
  const viewing = !!device?.booted && !!result?.hub.installed;
  // The list refreshes while it shows, and while the hub installs.
  useEffect(() => {
    if (!shown) return;
    void refresh();
    if (viewing && !result?.hub.installing) return;
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, hostId, runId, viewing, result?.hub.installing, request]);

  const act = async (id: string, label: string, run: () => Promise<string | undefined>) => {
    setBusy((all) => ({ ...all, [id]: label }));
    setFailure(undefined);
    const error = await run();
    setBusy((all) => Object.fromEntries(Object.entries(all).filter(([each]) => each !== id)));
    if (error) setFailure(error);
    await refresh();
  };
  const boot = (target: DeviceInfo) =>
    act(target.id, "Starting…", async () => {
      const answer = await window.parallax.request(hostId, "device/boot", {
        deviceId: target.id,
        platform: target.platform,
      });
      if ("error" in answer) return answer.error.message;
      // An AVD boots as an emulator, under a serial of its own.
      select(answer.result.device.id);
      return undefined;
    });
  const create = () =>
    act("new", "Creating…", async () => {
      const answer = await window.parallax.request(hostId, "device/create", {});
      if ("error" in answer) return answer.error.message;
      const made = answer.result.device;
      const booted = await window.parallax.request(hostId, "device/boot", {
        deviceId: made.id,
        platform: made.platform,
      });
      if ("error" in booted) return booted.error.message;
      select(made.id);
      return undefined;
    });
  const powerOff = (target: DeviceInfo) =>
    act(target.id, "Stopping…", async () => {
      select(undefined);
      const answer = await window.parallax.request(hostId, "device/shutdown", {
        deviceId: target.id,
        platform: target.platform,
      });
      return "error" in answer ? answer.error.message : undefined;
    });
  const setUp = async () => {
    setFailure(undefined);
    const answer = await window.parallax.request(hostId, "device/setup", {});
    if ("error" in answer) setFailure(answer.error.message);
    await refresh();
  };

  if (!state) {
    return (
      <Centered>
        <LoaderCircle aria-hidden className="size-5 animate-spin text-faint-foreground" />
        {/* Xcode's simulator service can take a while to start the first time. */}
        <p className="text-[12.5px] text-muted-foreground">Looking for devices…</p>
      </Centered>
    );
  }
  if ("error" in state) {
    return (
      <Centered>
        <Smartphone aria-hidden className="mb-1 size-5 text-faint-foreground" />
        <p className="text-[13px] font-medium">Devices aren't available</p>
        <p className="text-[12.5px] text-muted-foreground">{state.error}</p>
      </Centered>
    );
  }
  if (device?.booted && !state.hub.installed) {
    return (
      <Setup
        device={device}
        hub={state.hub}
        failure={failure}
        onSetUp={() => void setUp()}
        onBack={() => select(undefined)}
      />
    );
  }
  if (device?.booted) {
    return (
      <Viewer
        key={`${hostId}/${device.id}`}
        hostId={hostId}
        device={device}
        shown={shown}
        stopping={!!busy[device.id]}
        onBack={() => select(undefined)}
        onPowerOff={() => void powerOff(device)}
      />
    );
  }
  return (
    <Picker
      state={state}
      busy={busy}
      failure={failure}
      onOpen={(target) => (target.booted ? select(target.id) : void boot(target))}
      onCreate={() => void create()}
      onRefresh={() => void refresh()}
    />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 pb-16 text-center">
      {children}
    </div>
  );
}

/** The platforms' devices, booted first, with Start on each stopped one. */
function Picker({
  state,
  busy,
  failure,
  onOpen,
  onCreate,
  onRefresh,
}: {
  state: DeviceStateResult;
  busy: Record<string, string>;
  failure?: string;
  onOpen: (device: DeviceInfo) => void;
  onCreate: () => void;
  onRefresh: () => void;
}) {
  const sections: { platform: DevicePlatform; title: string }[] = [
    { platform: "ios", title: "iOS Simulators" },
    { platform: "android", title: "Android Emulators" },
  ];
  // A platform this host can't run goes last, with why.
  const ordered = sections.toSorted(
    (a, b) => Number(!!unavailable(state, a.platform)) - Number(!!unavailable(state, b.platform)),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-3 pb-6">
      <div className="mb-1 flex items-center gap-2 px-1">
        <h2 className="flex-1 text-[13px] font-medium">Devices</h2>
        <IconButton label="Refresh devices" onClick={onRefresh}>
          <RefreshCw />
        </IconButton>
      </div>
      {failure && (
        <p
          role="alert"
          className="mx-1 mb-2 rounded-md bg-danger/10 px-2.5 py-2 text-[12.5px] text-danger"
        >
          {failure}
        </p>
      )}
      {ordered.map(({ platform, title }) => {
        const why = unavailable(state, platform);
        const devices = state.devices.filter((d) => d.platform === platform);
        return (
          <section key={platform} aria-label={title} className="mt-3">
            <div className="mb-1 flex items-center gap-2 px-1">
              <h3 className="flex-1 text-[11.5px] font-medium tracking-wide text-faint-foreground uppercase">
                {title}
              </h3>
              {platform === "ios" && !why && (
                <button
                  type="button"
                  className={secondary}
                  disabled={!!busy["new"]}
                  onClick={onCreate}
                >
                  {busy["new"] ? <LoaderCircle className="animate-spin" /> : <Plus />}
                  {busy["new"] ?? "New iPhone"}
                </button>
              )}
            </div>
            {why ? (
              <p className="px-1 text-[12.5px] text-muted-foreground">{why}</p>
            ) : devices.length === 0 ? (
              <p className="px-1 text-[12.5px] text-muted-foreground">
                {platform === "ios"
                  ? "No simulators yet. New iPhone makes one."
                  : "No emulators yet. Make one in Android Studio's Device Manager."}
              </p>
            ) : (
              <ul>
                {devices.map((d) => (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(d)}
                      disabled={!!busy[d.id]}
                      className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-hover disabled:opacity-70"
                    >
                      <span className="relative grid size-7 shrink-0 place-items-center rounded-md bg-selected text-muted-foreground [&_svg]:size-3.5">
                        <Smartphone />
                        {d.booted && (
                          <span
                            aria-hidden
                            className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-added ring-2 ring-pane"
                          />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px]">{d.name}</span>
                        <span className="block truncate text-[11.5px] text-muted-foreground">
                          {d.version}
                          {d.physical ? " · Connected phone" : d.booted ? " · Running" : ""}
                        </span>
                      </span>
                      {busy[d.id] ? (
                        <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground [&_svg]:size-3.5">
                          <LoaderCircle className="animate-spin" />
                          {busy[d.id]}
                        </span>
                      ) : (
                        <span className="text-[12px] text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">
                          {d.booted ? "Open" : "Start"}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

const unavailable = (state: DeviceStateResult, platform: DevicePlatform) =>
  state.platforms.find((p) => p.platform === platform)?.unavailable;

/** Asks before installing the device hub, which streams devices to the panel. */
function Setup({
  device,
  hub,
  failure,
  onSetUp,
  onBack,
}: {
  device: DeviceInfo;
  hub: DeviceStateResult["hub"];
  failure?: string;
  onSetUp: () => void;
  onBack: () => void;
}) {
  const why = failure ?? hub.failure;
  return (
    <Centered>
      <Smartphone aria-hidden className="mb-1 size-5 text-faint-foreground" />
      <p className="text-[13px] font-medium">Show {device.name} here</p>
      <p className="max-w-72 text-[12.5px] text-muted-foreground">
        Parallax streams simulators and emulators with Expo's device hub. Setting up installs it
        with npm into Parallax's tools folder on this host, once.
      </p>
      {why && !hub.installing && (
        <p role="alert" className="max-w-72 text-[12.5px] text-danger">
          {why}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button type="button" className={secondary} onClick={onBack}>
          Back
        </button>
        <button type="button" className={primary} disabled={hub.installing} onClick={onSetUp}>
          {hub.installing && <LoaderCircle className="animate-spin" />}
          {hub.installing ? "Setting up…" : why ? "Try again" : "Set up"}
        </button>
      </div>
    </Centered>
  );
}

/** A booted device's live screen, which takes clicks as touches and keys while focused. */
function Viewer({
  hostId,
  device,
  shown,
  stopping,
  onBack,
  onPowerOff,
}: {
  hostId: string;
  device: DeviceInfo;
  shown: boolean;
  stopping: boolean;
  onBack: () => void;
  onPowerOff: () => void;
}) {
  const ios = device.platform === "ios";
  const canvas = useRef<HTMLCanvasElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const stream = useRef<DeviceStream>(null);
  const [status, setStatus] = useState<{ status: DeviceStreamStatus; detail?: string }>({
    status: "connecting",
  });
  const [screen, setScreen] = useState<DeviceScreen>();
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [box, setBox] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!shown || !canvas.current) return;
    const live = createDeviceStream(
      { hostId, deviceId: device.id, platform: device.platform },
      canvas.current,
      {
        onStatus: (next, detail) => setStatus({ status: next, detail }),
        onScreen: setScreen,
        onInput: () => {},
      },
    );
    stream.current = live;
    live.start();
    return () => {
      live.stop();
      if (stream.current === live) stream.current = null;
    };
  }, [hostId, device.id, device.platform, shown, attempt]);

  // The screen fits the panel, at the device's aspect, with room for its bezel.
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      setBox({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // serve-sim streams the simulator's framebuffer as it is, so a simulator turned sideways shows
  // its frames turned back, as T3 does.
  const sideways =
    screen?.orientation === "landscape_left" || screen?.orientation === "landscape_right";
  const turn =
    !ios || !screen || screen.width > screen.height
      ? 0
      : screen.orientation === "landscape_left"
        ? 90
        : screen.orientation === "landscape_right"
          ? -90
          : screen.orientation === "portrait_upside_down"
            ? 180
            : 0;
  const long = screen ? Math.max(screen.width, screen.height) : ios ? 2622 : 2400;
  const short = screen ? Math.min(screen.width, screen.height) : ios ? 1206 : 1080;
  const aspect = sideways ? long / short : short / long;
  const bezel = 0.035;
  const fit = Math.min(
    box.width / (aspect * (1 + bezel * 2)),
    box.height / (1 + bezel * 2 * aspect),
  );
  const width = Math.max(0, Math.floor(fit * aspect));
  const height = Math.max(0, Math.floor(fit));
  const pad = Math.round(width * bezel);
  // iPhones' screens round more than Android phones'.
  const radius = Math.round(Math.min(width, height) * (ios ? 0.13 : 0.08));

  const point = (event: React.PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  };
  const touching = useRef(false);

  const screenshot = async () => {
    const answer = await window.parallax.request(hostId, "device/screenshot", {
      deviceId: device.id,
      platform: device.platform,
    });
    if ("error" in answer) return setStatus({ status: "error", detail: answer.error.message });
    const bytes = Uint8Array.from(atob(answer.result.png), (c) => c.charCodeAt(0));
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) }),
    ]);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  };

  const press = (button: Parameters<DeviceStream["button"]>[0]) => stream.current?.button(button);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border px-1.5">
        <IconButton label="All devices" onClick={onBack}>
          <ChevronLeft />
        </IconButton>
        <div className="min-w-0 flex-1 px-1">
          <p className="truncate text-[13px] leading-tight font-medium">{device.name}</p>
          <p className="truncate text-[11px] leading-tight text-muted-foreground">
            {device.version}
          </p>
        </div>
        {ios ? (
          <>
            <IconButton label="Home" onClick={() => press("home")}>
              <House />
            </IconButton>
            <IconButton label="App switcher" onClick={() => press("appSwitcher")}>
              <LayoutGrid />
            </IconButton>
            <IconButton label="Rotate" onClick={() => stream.current?.rotate()}>
              <RotateCw />
            </IconButton>
          </>
        ) : (
          <>
            <IconButton label="Back" onClick={() => press("back")}>
              <Triangle className="-rotate-90" />
            </IconButton>
            <IconButton label="Home" onClick={() => press("home")}>
              <Circle />
            </IconButton>
            <IconButton label="Recents" onClick={() => press("recents")}>
              <LayoutGrid />
            </IconButton>
          </>
        )}
        <IconButton
          label={copied ? "Copied screenshot" : "Copy screenshot"}
          onClick={() => void screenshot()}
        >
          {copied ? <Check /> : <Camera />}
        </IconButton>
        {!device.physical && (
          <IconButton label="Power off" disabled={stopping} onClick={onPowerOff}>
            {stopping ? <LoaderCircle className="animate-spin" /> : <Power />}
          </IconButton>
        )}
      </div>
      <div
        ref={area}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4"
      >
        <div
          tabIndex={0}
          role="application"
          aria-label={`${device.name} screen`}
          onKeyDown={(event) => {
            // ⌘V and Ctrl+V paste; other shortcuts stay the app's.
            if (event.metaKey || (event.ctrlKey && event.key.toLowerCase() === "v")) return;
            event.preventDefault();
            stream.current?.key(event.nativeEvent, "down");
          }}
          onKeyUp={(event) => {
            if (event.metaKey) return;
            stream.current?.key(event.nativeEvent, "up");
          }}
          onPaste={(event) => {
            event.preventDefault();
            stream.current?.text(event.clipboardData.getData("text/plain"));
          }}
          style={{
            padding: pad,
            borderRadius: radius + pad,
            width: width + pad * 2,
            height: height + pad * 2,
          }}
          className="relative shrink-0 bg-[#0b0b0c] shadow-[0_0_0_1px_rgb(255_255_255/0.08),0_18px_50px_-12px_rgb(0_0_0/0.5)] outline-none focus-visible:shadow-[0_0_0_2px_var(--ring),0_18px_50px_-12px_rgb(0_0_0/0.5)]"
        >
          <div
            className="relative size-full touch-none overflow-hidden bg-black select-none"
            style={{ borderRadius: radius }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              (event.currentTarget.parentElement as HTMLElement | null)?.focus();
              touching.current = true;
              const { x, y } = point(event);
              stream.current?.touch("begin", x, y);
            }}
            onPointerMove={(event) => {
              if (!touching.current) return;
              const { x, y } = point(event);
              stream.current?.touch("move", x, y);
            }}
            onPointerUp={(event) => {
              if (!touching.current) return;
              touching.current = false;
              const { x, y } = point(event);
              stream.current?.touch("end", x, y);
            }}
            onPointerCancel={(event) => {
              if (!touching.current) return;
              touching.current = false;
              const { x, y } = point(event);
              stream.current?.touch("end", x, y);
            }}
          >
            <canvas
              ref={canvas}
              style={
                turn === 90 || turn === -90
                  ? {
                      width: height,
                      height: width,
                      left: (width - height) / 2,
                      top: (height - width) / 2,
                      transform: `rotate(${turn}deg)`,
                    }
                  : { width, height, transform: turn ? `rotate(${turn}deg)` : undefined }
              }
              className={`absolute top-0 left-0 ${status.status === "streaming" ? "" : "opacity-40"} transition-opacity`}
            />
            {status.status !== "streaming" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-white/80">
                {status.status === "connecting" ? (
                  <>
                    <LoaderCircle aria-hidden className="size-5 animate-spin" />
                    <p className="text-[12.5px]">
                      {status.detail ?? `Connecting to ${device.name}…`}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-[12.5px]">{status.detail}</p>
                    <button
                      type="button"
                      className="rounded-md bg-white/15 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-white/25"
                      onClick={() => {
                        setStatus({ status: "connecting" });
                        setAttempt((n) => n + 1);
                      }}
                    >
                      Reconnect
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
