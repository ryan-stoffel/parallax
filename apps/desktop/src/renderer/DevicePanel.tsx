import {
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleAlert,
  House,
  LayoutGrid,
  LoaderCircle,
  Plus,
  Power,
  RotateCw,
  Triangle,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type {
  DeviceChrome,
  DeviceInfo,
  DevicePlatform,
  DeviceStateResult,
} from "../protocol/generated/protocol";
import {
  createDeviceStream,
  type DeviceScreen,
  type DeviceStream,
  type DeviceStreamStatus,
} from "./deviceStream";
import { IconButton } from "./ui";

/** How often the device list refreshes while it shows, or while the hub installs. */
const REFRESH_MS = 3_000;

/**
 * The device each thread last watched, by host and thread, so coming back shows it again. An
 * empty id means the list was chosen over the device the panel would otherwise open.
 */
const watched = new Map<string, string>();
/** Each host's last `device/state`, so the view draws at once and refreshes behind it. */
const states = new Map<string, DeviceStateResult>();
/** Each simulator's Xcode artwork, by host and device, or null where there's none. */
const chromes = new Map<string, DeviceChrome | null>();

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
  const [state, setState] = useState<DeviceStateResult | { error: string } | undefined>(() =>
    states.get(hostId),
  );
  const [selected, setSelected] = useState(() => watched.get(key));
  // Devices starting or stopping, by id, and the AVD whose emulator is starting under it.
  const [busy, setBusy] = useState<Record<string, "start" | "stop">>({});
  const [failure, setFailure] = useState<string>();
  const [seenKey, setSeenKey] = useState(key);
  if (key !== seenKey) {
    setSeenKey(key);
    setSelected(watched.get(key));
    setState(states.get(hostId));
    setFailure(undefined);
  }
  const select = (id: string) => {
    watched.set(key, id);
    setSelected(id);
    setFailure(undefined);
  };

  const refresh = async () => {
    const answer = await window.parallax.request(hostId, "device/state", runId ? { runId } : {});
    if ("error" in answer) {
      setState({
        error:
          answer.error.code === -32601
            ? "Update Parallax on this host to use devices."
            : answer.error.message,
      });
      return;
    }
    states.set(hostId, answer.result);
    setState(answer.result);
  };

  const [requested, setRequested] = useState(request);
  if (request !== requested) {
    setRequested(request);
    if (request?.deviceId) select(request.deviceId);
  }

  const result = state && !("error" in state) ? state : undefined;
  // With nothing chosen yet, the one running device opens by itself.
  const running = result?.devices.filter((d) => d.booted) ?? [];
  const chosen = selected ?? (running.length === 1 ? running[0]!.id : undefined);
  const device = result?.devices.find((d) => d.id === chosen);
  const live = !!device?.booted && !!result?.hub.installed;
  useEffect(() => {
    if (!shown) return;
    void refresh();
    if (live) return;
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, hostId, runId, live, request]);

  const act = async (
    id: string,
    kind: "start" | "stop",
    run: () => Promise<string | undefined>,
  ) => {
    setBusy((all) => ({ ...all, [id]: kind }));
    setFailure(undefined);
    const error = await run();
    setBusy((all) => Object.fromEntries(Object.entries(all).filter(([each]) => each !== id)));
    if (error) setFailure(error);
    await refresh();
  };
  // Opens the device at once; it boots in its frame.
  const start = (target: DeviceInfo) => {
    select(target.id);
    void act(target.id, "start", async () => {
      const answer = await window.parallax.request(hostId, "device/boot", {
        deviceId: target.id,
        platform: target.platform,
      });
      if ("error" in answer) return answer.error.message;
      // An AVD boots as an emulator, under a serial of its own.
      select(answer.result.device.id);
      return undefined;
    });
  };
  const create = () =>
    act("new", "start", async () => {
      const answer = await window.parallax.request(hostId, "device/create", {});
      if ("error" in answer) return answer.error.message;
      await refresh();
      start(answer.result.device);
      return undefined;
    });
  const powerOff = (target: DeviceInfo) =>
    act(target.id, "stop", async () => {
      select("");
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

  if (!state) return <Skeleton />;
  if ("error" in state) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 px-8 pb-16 text-[13px]">
        <CircleAlert aria-hidden className="size-4 shrink-0 text-danger" />
        {state.error}
      </div>
    );
  }
  if (device) {
    return (
      <Viewer
        key={`${hostId}/${device.id}`}
        hostId={hostId}
        device={device}
        shown={shown}
        hub={state.hub}
        booting={busy[device.id] === "start" || !device.booted}
        stopping={busy[device.id] === "stop"}
        failure={failure}
        onSetUp={() => void setUp()}
        onBack={() => select("")}
        onPowerOff={() => void powerOff(device)}
      />
    );
  }
  return (
    <Picker
      state={state}
      busy={busy}
      failure={failure}
      onOpen={(target) => (target.booted ? select(target.id) : start(target))}
      onCreate={() => void create()}
    />
  );
}

/** Rows while the first list loads, where it will be. */
function Skeleton() {
  return (
    <div aria-busy className="flex flex-col gap-1 p-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex h-11 items-center gap-3 px-2">
          <div className="size-7 animate-pulse rounded-lg bg-selected" />
          <div
            className="h-3 animate-pulse rounded-full bg-selected"
            style={{ width: `${48 - i * 9}%` }}
          />
        </div>
      ))}
    </div>
  );
}

/** Apple's and Android's marks, for each device's platform. */
function PlatformMark({ platform }: { platform: DevicePlatform }) {
  return platform === "ios" ? (
    <svg viewBox="0 0 24 24" aria-hidden className="size-3.5 fill-current">
      <path d="M16.37 12.6c-.02-2.16 1.77-3.2 1.85-3.25-1-1.47-2.57-1.67-3.13-1.7-1.33-.13-2.6.79-3.28.79-.68 0-1.72-.77-2.83-.75-1.45.02-2.8.85-3.55 2.15-1.52 2.63-.39 6.52 1.09 8.66.72 1.04 1.58 2.22 2.71 2.18 1.09-.04 1.5-.7 2.82-.7 1.31 0 1.68.7 2.83.68 1.17-.02 1.91-1.06 2.62-2.11.83-1.21 1.17-2.38 1.19-2.44-.03-.01-2.28-.88-2.32-3.47ZM14.2 6.25c.6-.73 1-1.73.89-2.75-.86.04-1.9.57-2.52 1.3-.55.64-1.04 1.67-.91 2.66.96.07 1.94-.49 2.54-1.21Z" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden className="size-3.5 fill-current">
      <path d="M17.6 9.48 19.44 6.3a.38.38 0 0 0-.66-.38l-1.86 3.22a11.5 11.5 0 0 0-9.84 0L5.22 5.92a.38.38 0 0 0-.66.38L6.4 9.48A10.8 10.8 0 0 0 1 18h22a10.8 10.8 0 0 0-5.4-8.52ZM7 15.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Zm10 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Z" />
    </svg>
  );
}

/** A device's name as people write it: an AVD's `Pixel_9` as Pixel 9. */
const nameOf = (device: DeviceInfo) => device.name.replaceAll("_", " ");

const row =
  "group flex h-11 w-full items-center gap-3 rounded-xl px-2 text-left text-[13.5px] transition-[background-color,transform] duration-100 hover:bg-hover active:scale-[0.985] disabled:pointer-events-none";
const tile =
  "grid size-7 shrink-0 place-items-center rounded-lg bg-selected text-foreground transition-colors";

/** Every device as one row, running ones first, then New iPhone, then what this host can't run. */
function Picker({
  state,
  busy,
  failure,
  onOpen,
  onCreate,
}: {
  state: DeviceStateResult;
  busy: Record<string, "start" | "stop">;
  failure?: string;
  onOpen: (device: DeviceInfo) => void;
  onCreate: () => void;
}) {
  const unavailable = (platform: DevicePlatform) =>
    state.platforms.find((p) => p.platform === platform)?.unavailable;
  // A version tells same-named devices apart; otherwise the name says enough.
  const named = (d: DeviceInfo) =>
    state.devices.filter((other) => other.name === d.name).length > 1
      ? `${nameOf(d)} · ${d.version.replace(/^(iOS|Android) /, "")}`
      : nameOf(d);
  const missing = (["ios", "android"] as const).filter(unavailable);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
      {failure && (
        <p
          role="alert"
          className="mx-2 mb-1 flex items-center gap-2 py-1.5 text-[12.5px] text-danger"
        >
          <CircleAlert aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate" title={failure}>
            {failure}
          </span>
        </p>
      )}
      <ul aria-label="Devices">
        {state.devices.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              title={`${nameOf(d)}, ${d.version}${d.booted ? ", running" : ""}`}
              onClick={() => onOpen(d)}
              disabled={!!busy[d.id]}
              className={row}
            >
              <span className={`${tile} relative`}>
                <PlatformMark platform={d.platform} />
                {d.booted && (
                  <span
                    aria-hidden
                    className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-added ring-2 ring-pane"
                  />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{named(d)}</span>
              {busy[d.id] ? (
                <LoaderCircle aria-hidden className="size-4 animate-spin text-faint-foreground" />
              ) : (
                <ChevronRight
                  aria-hidden
                  className="size-4 text-faint-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                />
              )}
            </button>
          </li>
        ))}
        {!unavailable("ios") && (
          <li>
            <button type="button" onClick={onCreate} disabled={!!busy["new"]} className={row}>
              <span className={`${tile} bg-transparent ring-1 ring-border ring-inset`}>
                {busy["new"] ? (
                  <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
                ) : (
                  <Plus aria-hidden className="size-3.5" />
                )}
              </span>
              <span className="font-medium">New iPhone</span>
            </button>
          </li>
        )}
      </ul>
      {missing.length > 0 && (
        <div className="mt-auto flex flex-wrap gap-1.5 px-2 pt-4">
          {missing.map((platform) => (
            <span
              key={platform}
              title={unavailable(platform)}
              className="flex cursor-help items-center gap-1.5 rounded-full bg-selected px-2.5 py-1 text-[12px] text-muted-foreground"
            >
              <PlatformMark platform={platform} />
              {platform === "ios" ? "Needs Xcode on a Mac" : "Needs the Android SDK"}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A device in its frame: booting, waiting for streaming to be enabled, or live, where it takes
 * clicks as touches and keys while focused.
 */
function Viewer({
  hostId,
  device,
  shown,
  hub,
  booting,
  stopping,
  failure,
  onSetUp,
  onBack,
  onPowerOff,
}: {
  hostId: string;
  device: DeviceInfo;
  shown: boolean;
  hub: DeviceStateResult["hub"];
  booting: boolean;
  stopping: boolean;
  failure?: string;
  onSetUp: () => void;
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
  const streaming = shown && !booting && hub.installed;
  const chromeKey = `${hostId}/${device.id}`;
  const [chrome, setChrome] = useState(() =>
    ios ? chromes.get(chromeKey) : (null as DeviceChrome | null),
  );
  useEffect(() => {
    if (chrome !== undefined) return;
    void window.parallax
      .request(hostId, "device/chrome", { deviceId: device.id, platform: device.platform })
      .then((answer) => {
        const found = "error" in answer ? null : (answer.result.chrome ?? null);
        chromes.set(chromeKey, found);
        setChrome(found);
      });
  }, [chrome, chromeKey, hostId, device.id, device.platform]);

  useEffect(() => {
    if (!streaming || !canvas.current) return;
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
  }, [hostId, device.id, device.platform, streaming, attempt]);

  // The screen fits the panel at the device's aspect, with room for its bezel and the controls.
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
  const pad = Math.round(Math.min(width, height) * bezel * 1.6);
  // iPhones' screens round more than Android phones'.
  const radius = Math.round(Math.min(width, height) * (ios ? 0.13 : 0.08));
  // Xcode's artwork is portrait; turned sideways, the whole device turns, as in Simulator.
  const across = chrome ? (sideways ? chrome.height : chrome.width) : 0;
  const down = chrome ? (sideways ? chrome.width : chrome.height) : 0;
  const k = chrome ? Math.min(box.width / across, box.height / down) : 0;

  const point = (event: React.PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  };
  const touching = useRef(false);
  const touch = (phase: "begin" | "move" | "end") => (event: React.PointerEvent<HTMLElement>) => {
    if (phase === "begin") {
      // Until the stream shows, the screen's buttons take clicks, not the device.
      if (event.button !== 0 || !ready) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      (event.currentTarget.parentElement as HTMLElement | null)?.focus();
      touching.current = true;
    } else if (!touching.current) return;
    if (phase === "end") touching.current = false;
    const { x, y } = point(event);
    stream.current?.touch(phase, x, y);
  };

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
  const ready = streaming && status.status === "streaming";
  const why = failure ?? hub.failure;

  // What the screen shows until the stream does.
  let overlay: ReactNode = null;
  if (!hub.installed && !booting) {
    overlay = hub.installing ? (
      <LoaderCircle aria-label="Enabling streaming" className="size-5 animate-spin" />
    ) : (
      <button
        type="button"
        title={
          why ??
          "Installs Expo's device hub with npm into Parallax's tools folder on this host, once."
        }
        onClick={onSetUp}
        className="rounded-full bg-white px-4 py-2 text-[13px] font-medium text-black transition-transform hover:scale-[1.03] active:scale-95"
      >
        {why ? "Try again" : "Enable streaming"}
      </button>
    );
  } else if (booting || (streaming && status.status === "connecting")) {
    overlay = <LoaderCircle aria-label="Connecting" className="size-5 animate-spin" />;
  } else if (status.status === "error") {
    overlay = (
      <button
        type="button"
        title={status.detail}
        onClick={() => {
          setStatus({ status: "connecting" });
          setAttempt((n) => n + 1);
        }}
        className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-[12.5px] font-medium text-white transition-transform hover:bg-white/25 active:scale-95 [&_svg]:size-3.5"
      >
        <RotateCw aria-hidden />
        Reconnect
      </button>
    );
  }

  // The device takes keys while focused: typing, and pasting as typing.
  const keyboard = {
    tabIndex: 0,
    role: "application",
    "aria-label": `${device.name} screen`,
    onKeyDown: (event: React.KeyboardEvent) => {
      // ⌘V and Ctrl+V paste; other shortcuts stay the app's.
      if (event.metaKey || (event.ctrlKey && event.key.toLowerCase() === "v")) return;
      event.preventDefault();
      stream.current?.key(event.nativeEvent, "down");
    },
    onKeyUp: (event: React.KeyboardEvent) => {
      if (event.metaKey) return;
      stream.current?.key(event.nativeEvent, "up");
    },
    onPaste: (event: React.ClipboardEvent) => {
      event.preventDefault();
      stream.current?.text(event.clipboardData.getData("text/plain"));
    },
  };

  const control = (label: string, icon: ReactNode, onClick: () => void, disabled = !ready) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-full text-muted-foreground transition-[color,background-color,transform] duration-100 hover:bg-hover hover:text-foreground active:scale-90 disabled:opacity-35 [&_svg]:size-4"
    >
      {icon}
    </button>
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 px-1.5">
        <IconButton label="All devices" onClick={onBack}>
          <ChevronLeft />
        </IconButton>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] font-medium">
          <span className="text-muted-foreground">
            <PlatformMark platform={device.platform} />
          </span>
          <span className="truncate" title={`${nameOf(device)}, ${device.version}`}>
            {nameOf(device)}
          </span>
        </span>
        {!device.physical && (
          <IconButton label="Power off" disabled={stopping || booting} onClick={onPowerOff}>
            {stopping ? <LoaderCircle className="animate-spin" /> : <Power />}
          </IconButton>
        )}
      </div>
      <div
        ref={area}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-5 pt-2 pb-16"
      >
        {chrome ? (
          <div
            className="relative shrink-0 animate-[device-in_240ms_ease-out]"
            style={{ width: across * k, height: down * k }}
          >
            <div
              {...keyboard}
              style={{
                width: chrome.width * k,
                height: chrome.height * k,
                left: (across - chrome.width) * k * 0.5,
                top: (down - chrome.height) * k * 0.5,
                transform: turn ? `rotate(${turn}deg)` : undefined,
              }}
              className="absolute outline-none"
            >
              {chrome.layers.map((layer) => (
                <img
                  key={layer.name}
                  alt=""
                  draggable={false}
                  src={`data:image/png;base64,${layer.png}`}
                  title={layer.name === "power" ? "Lock" : undefined}
                  onClick={layer.name === "power" ? () => press("power") : undefined}
                  style={
                    {
                      left: layer.rect.x * k,
                      top: layer.rect.y * k,
                      width: layer.rect.width * k,
                      height: layer.rect.height * k,
                      "--pop": `${(layer.hoverX ?? 0) * k}px`,
                    } as React.CSSProperties
                  }
                  className={
                    layer.name === "bezel"
                      ? "pointer-events-none absolute drop-shadow-[0_22px_40px_rgb(0_0_0/0.35)]"
                      : "absolute transition-transform duration-150 ease-out select-none hover:translate-x-(--pop)"
                  }
                />
              ))}
              <div
                className="absolute touch-none overflow-hidden bg-black select-none"
                style={{
                  left: chrome.screen.x * k,
                  top: chrome.screen.y * k,
                  width: chrome.screen.width * k,
                  height: chrome.screen.height * k,
                  maskImage: `url(data:image/png;base64,${chrome.mask})`,
                  maskSize: "100% 100%",
                }}
                onPointerDown={touch("begin")}
                onPointerMove={touch("move")}
                onPointerUp={touch("end")}
                onPointerCancel={touch("end")}
              >
                <canvas
                  ref={canvas}
                  className={`size-full transition-opacity duration-300 ${ready ? "opacity-100" : "opacity-30"}`}
                />
                {overlay && (
                  <div
                    className="absolute inset-0 flex items-center justify-center text-white/80"
                    style={turn ? { transform: `rotate(${-turn}deg)` } : undefined}
                  >
                    {overlay}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : chrome === undefined ? null : (
          <div
            {...keyboard}
            style={{
              padding: pad,
              borderRadius: radius + pad,
              width: width + pad * 2,
              height: height + pad * 2,
            }}
            className="relative shrink-0 bg-linear-to-b from-[#2a2a2d] via-[#121214] to-[#1d1d20] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1),0_0_0_1px_rgb(0_0_0/0.35),0_24px_60px_-18px_rgb(0_0_0/0.55)] outline-none focus-visible:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1),0_0_0_2px_var(--ring),0_24px_60px_-18px_rgb(0_0_0/0.55)]"
          >
            <div
              className="relative size-full touch-none overflow-hidden bg-black select-none"
              style={{ borderRadius: radius }}
              onPointerDown={touch("begin")}
              onPointerMove={touch("move")}
              onPointerUp={touch("end")}
              onPointerCancel={touch("end")}
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
                className={`absolute top-0 left-0 transition-opacity duration-300 ${ready ? "opacity-100" : "opacity-30"}`}
              />
              {overlay && (
                <div className="absolute inset-0 flex items-center justify-center text-white/80">
                  {overlay}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
        <div
          role="toolbar"
          aria-label="Device controls"
          className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-border bg-surface/90 p-1 shadow-[0_8px_24px_-10px_rgb(0_0_0/0.3)] backdrop-blur"
        >
          {ios ? (
            <>
              {control("Home", <House />, () => press("home"))}
              {control("App switcher", <LayoutGrid />, () => press("appSwitcher"))}
              {control("Rotate", <RotateCw />, () => stream.current?.rotate())}
            </>
          ) : (
            <>
              {control("Back", <Triangle className="-rotate-90" />, () => press("back"))}
              {control("Home", <Circle />, () => press("home"))}
              {control("Recents", <LayoutGrid />, () => press("recents"))}
            </>
          )}
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          {control(
            copied ? "Copied screenshot" : "Copy screenshot",
            copied ? <Check /> : <Camera />,
            () => void screenshot(),
            booting || !device.booted,
          )}
        </div>
      </div>
    </div>
  );
}
