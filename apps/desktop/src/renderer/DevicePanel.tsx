import {
  ArrowUpRight,
  Camera,
  Check,
  ChevronDown,
  Circle,
  Copy,
  House,
  LayoutGrid,
  LoaderCircle,
  Plus,
  Power,
  RotateCw,
  Rotate3d,
  BookOpen,
  TriangleAlert,
  Triangle,
} from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type {
  DeviceChrome,
  DeviceInfo,
  DevicePlatform,
  DeviceStateResult,
} from "../protocol/generated/protocol";
import type { Device3d } from "./device3d";
import { appleModel, deviceStill, pixelModel } from "./deviceModels";
import { plainChrome, unproject, type Turn } from "./deviceSpace";
import {
  ORIENTATIONS,
  createDeviceStream,
  duoDisplay,
  type DeviceOrientation,
  type DeviceScreen,
  type DeviceStream,
  type DeviceStreamStatus,
} from "./deviceStream";
import { notify } from "./notifications";
import { Menu, menuItem } from "./ui";

/** How often the device list refreshes while it shows, or while the hub installs. */
const REFRESH_MS = 3_000;
/** The 3D view's perspective, in pixels: a phone held at arm's length. */
const PERSPECTIVE = 1800;

/**
 * The device each thread last watched, by host and thread, so coming back shows it again. An
 * empty id means the gallery was chosen over the device the panel would otherwise open.
 */
const watched = new Map<string, string>();
/** Each host's last `device/state`, so the view draws at once and refreshes behind it. */
const states = new Map<string, DeviceStateResult>();
/**
 * Each device's artwork from its host's Xcode or Android Studio, or null for none, by host and
 * device: its name too, since another emulator can take a stopped one's serial.
 */
const chromes = new Map<string, DeviceChrome | null>();

/**
 * Fetches device `device`'s artwork once per app: undefined while it loads, null for none. A
 * failed request isn't kept, so the next view asks again.
 */
function useChrome(hostId: string, device: DeviceInfo) {
  const key = `${hostId}/${device.id}/${device.name}`;
  const [chrome, setChrome] = useState(() => chromes.get(key));
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    setChrome(chromes.get(key));
  }
  useEffect(() => {
    if (chromes.has(key)) return;
    let live = true;
    void window.parallax
      .request(hostId, "device/chrome", { deviceId: device.id, platform: device.platform })
      .then((answer) => {
        const found = "error" in answer ? null : (answer.result.chrome ?? null);
        if (!("error" in answer)) chromes.set(key, found);
        if (live) setChrome(found);
      });
    return () => {
      live = false;
    };
  }, [key, hostId, device.id, device.platform]);
  return chrome;
}

/**
 * The Device panel (PLX-886): the host's iOS Simulators and Android Emulators, and a live,
 * touchable view of one, streamed through plxd, in its host's own Xcode or Android Studio artwork,
 * which turns in 3D. `shown` is whether it's on screen; only then does it stream. Each new
 * `request` shows its device, such as one the thread's agent opened.
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
  // Devices starting or stopping, by id, and devices being made, by platform.
  const [busy, setBusy] = useState<Record<string, "start" | "stop">>({});
  const [failure, setFailure] = useState<{ id: string; message: string }>();
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
    // Each refresh waits for the last to answer: a cold Mac's first listing can take a while.
    let on = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refresh();
      if (on && !live) timer = setTimeout(() => void tick(), REFRESH_MS);
    };
    void tick();
    return () => {
      on = false;
      clearTimeout(timer);
    };
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
    // A start that fails says why on the device's screen. A new device or a power off, from the
    // gallery, says why in a notification.
    if (error && kind === "start" && !id.startsWith("new:")) setFailure({ id, message: error });
    else if (error)
      notify({
        tone: "error",
        title: kind === "stop" ? "Couldn't power off the device" : "Couldn't make the device",
        body: error,
      });
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
  const create = (platform: DevicePlatform) =>
    act(`new:${platform}`, "start", async () => {
      const answer = await window.parallax.request(hostId, "device/create", { platform });
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
    if ("error" in answer) setFailure({ id: "hub", message: answer.error.message });
    await refresh();
  };

  if (!state) return <Skeleton />;
  if ("error" in state) {
    return (
      <Notice
        icon={<TriangleAlert className="text-warning" />}
        title="Devices aren't available"
        detail={state.error}
        action={<Pill onClick={() => void refresh()}>Try again</Pill>}
      />
    );
  }
  if (device) {
    return (
      <Viewer
        key={`${hostId}/${device.id}`}
        hostId={hostId}
        device={device}
        devices={state.devices}
        shown={shown}
        hub={state.hub}
        booting={busy[device.id] === "start" || !device.booted}
        stopping={busy[device.id] === "stop"}
        failure={failure?.id === device.id || failure?.id === "hub" ? failure.message : undefined}
        onRetry={() => (device.booted ? void refresh() : start(device))}
        onSetUp={() => void setUp()}
        onOpen={(target) => (target.booted ? select(target.id) : start(target))}
        onGallery={() => select("")}
        onPowerOff={() => void powerOff(device)}
      />
    );
  }
  return (
    <Gallery
      hostId={hostId}
      state={state}
      busy={busy}
      onOpen={(target) => (target.booted ? select(target.id) : start(target))}
      onCreate={(platform) => void create(platform)}
    />
  );
}

/** Cards where the gallery will be, while the first list loads. */
function Skeleton() {
  return (
    <div aria-busy className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3 p-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col items-center gap-3 rounded-2xl p-3">
          <div className="h-[180px] w-[86px] animate-pulse rounded-2xl bg-selected" />
          <div className="h-2.5 w-16 animate-pulse rounded-full bg-selected" />
        </div>
      ))}
    </div>
  );
}

/** A centered message, for the whole panel. */
function Notice({
  icon,
  title,
  detail,
  action,
}: {
  icon: ReactNode;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-10 pb-16 text-center [&>svg]:size-5">
      {icon}
      <p className="text-body font-medium">{title}</p>
      {detail && <p className="max-w-80 text-body text-muted-foreground">{detail}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

function Pill({
  children,
  onClick,
  href,
  dark,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  dark?: boolean;
  title?: string;
}) {
  const look = `inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-body font-medium transition-[transform,background-color] duration-100 active:scale-95 [&_svg]:size-3.5 ${
    dark ? "bg-white text-black hover:bg-white/90" : "bg-selected text-foreground hover:bg-hover"
  }`;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" title={title} className={look}>
      {children}
    </a>
  ) : (
    <button type="button" title={title} onClick={onClick} className={look}>
      {children}
    </button>
  );
}

/** Apple's and Android's marks, for each device's platform. */
function PlatformMark({
  platform,
  className = "size-3.5",
}: {
  platform: DevicePlatform;
  className?: string;
}) {
  return platform === "ios" ? (
    <svg viewBox="0 0 24 24" aria-hidden className={`${className} fill-current`}>
      <path d="M16.37 12.6c-.02-2.16 1.77-3.2 1.85-3.25-1-1.47-2.57-1.67-3.13-1.7-1.33-.13-2.6.79-3.28.79-.68 0-1.72-.77-2.83-.75-1.45.02-2.8.85-3.55 2.15-1.52 2.63-.39 6.52 1.09 8.66.72 1.04 1.58 2.22 2.71 2.18 1.09-.04 1.5-.7 2.82-.7 1.31 0 1.68.7 2.83.68 1.17-.02 1.91-1.06 2.62-2.11.83-1.21 1.17-2.38 1.19-2.44-.03-.01-2.28-.88-2.32-3.47ZM14.2 6.25c.6-.73 1-1.73.89-2.75-.86.04-1.9.57-2.52 1.3-.55.64-1.04 1.67-.91 2.66.96.07 1.94-.49 2.54-1.21Z" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden className={`${className} fill-current`}>
      <path d="M17.6 9.48 19.44 6.3a.38.38 0 0 0-.66-.38l-1.86 3.22a11.5 11.5 0 0 0-9.84 0L5.22 5.92a.38.38 0 0 0-.66.38L6.4 9.48A10.8 10.8 0 0 0 1 18h22a10.8 10.8 0 0 0-5.4-8.52ZM7 15.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Zm10 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Z" />
    </svg>
  );
}

/** A device's name as people write it: an AVD's `Pixel_9` as Pixel 9. */
const nameOf = (device: DeviceInfo) => device.name.replaceAll("_", " ");

/** Where to get what a platform is missing, and how to say it short. */
function missingOf(platform: DevicePlatform, why: string) {
  if (platform === "ios") {
    return why.includes("macOS")
      ? {
          title: "iPhone needs a Mac",
          detail: "Pair a Mac running Parallax to use its simulators.",
        }
      : {
          title: "Get Xcode for iPhone",
          href: "https://apps.apple.com/app/xcode/id497799835",
          link: "Get Xcode",
        };
  }
  return {
    title: why.startsWith("Android SDK was not found") ? "Get Android Studio for Android" : why,
    href: "https://developer.android.com/studio",
    link: "Android Studio",
  };
}

/**
 * The host's devices as their own artwork, running ones first, then a new iPhone or Pixel where
 * the host can make one, then what it's missing.
 */
function Gallery({
  hostId,
  state,
  busy,
  onOpen,
  onCreate,
}: {
  hostId: string;
  state: DeviceStateResult;
  busy: Record<string, "start" | "stop">;
  onOpen: (device: DeviceInfo) => void;
  onCreate: (platform: DevicePlatform) => void;
}) {
  const platform = (p: DevicePlatform) => state.platforms.find((each) => each.platform === p);
  // A version tells same-named devices apart; otherwise the name says enough.
  const named = (d: DeviceInfo) =>
    state.devices.filter((other) => other.name === d.name).length > 1
      ? `${nameOf(d)} · ${d.version.replace(/^(iOS|Android) /, "")}`
      : nameOf(d);
  const makes = (["ios", "android"] as const).filter((p) => platform(p)?.canCreate);
  const missing = (["ios", "android"] as const).flatMap((p) => {
    const why = platform(p)?.unavailable;
    return why ? [{ platform: p, why, ...missingOf(p, why) }] : [];
  });
  const warnings = state.platforms.flatMap((p) => (p.warning ? [p.warning] : []));
  const empty = state.devices.length === 0 && makes.length === 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {warnings.map((warning) => (
        <Warning key={warning} text={warning} />
      ))}
      {empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 px-8 pb-16">
          <EmptyPhone />
          <div className="flex flex-col items-center gap-3">
            {missing.map((m) => (
              <Missing key={m.platform} {...m} />
            ))}
          </div>
        </div>
      ) : (
        <>
          <ul
            aria-label="Devices"
            className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-2 p-4"
          >
            {state.devices.map((d) => {
              const still = deviceStill(d.platform, d.name);
              return (
                <li key={d.id}>
                  <Card
                    label={named(d)}
                    title={`${nameOf(d)}, ${d.version}${d.booted ? ", running" : ""}`}
                    running={d.booted}
                    busy={!!busy[d.id]}
                    turned={!!still}
                    onClick={() => onOpen(d)}
                  >
                    {still ? (
                      <img
                        alt=""
                        draggable={false}
                        src={still}
                        className="h-[180px] w-auto max-w-none select-none"
                      />
                    ) : (
                      <Thumbnail hostId={hostId} device={d} />
                    )}
                  </Card>
                </li>
              );
            })}
            {makes.map((p) => (
              <li key={`new:${p}`}>
                <Card
                  label={p === "ios" ? "New iPhone" : "New Pixel"}
                  busy={!!busy[`new:${p}`]}
                  onClick={() => onCreate(p)}
                >
                  <div className="grid h-[180px] w-[86px] place-items-center rounded-2xl border-[1.5px] border-dashed border-border text-muted-foreground transition-colors group-hover:border-faint-foreground group-hover:text-foreground">
                    <Plus aria-hidden className="size-5" />
                  </div>
                </Card>
              </li>
            ))}
          </ul>
          {missing.length > 0 && (
            <div className="mt-auto flex flex-wrap justify-center gap-2 px-4 pt-2 pb-6">
              {missing.map((m) => (
                <Missing key={m.platform} {...m} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** A phone outline, for a host with no devices. */
function EmptyPhone() {
  return (
    <div className="relative h-[132px] w-[64px] rounded-2xl border-[1.5px] border-border">
      <div className="absolute top-2 left-1/2 h-1.5 w-5 -translate-x-1/2 rounded-full bg-border" />
    </div>
  );
}

/** A platform this host can't run yet, and where to get what it needs. */
function Missing({
  platform,
  why,
  title,
  detail,
  href,
  link,
}: {
  platform: DevicePlatform;
  why: string;
  title: string;
  detail?: string;
  href?: string;
  link?: string;
}) {
  return (
    <div
      title={why}
      className="flex items-center gap-2.5 rounded-full bg-selected py-1 pr-1 pl-3 text-body"
    >
      <PlatformMark platform={platform} />
      <span className="font-medium">{title}</span>
      {detail && <span className="text-muted-foreground">{detail}</span>}
      {href && link ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-full bg-pane px-2.5 py-1 font-medium hover:bg-hover [&_svg]:size-3"
        >
          {link}
          <ArrowUpRight aria-hidden />
        </a>
      ) : (
        <span className="pr-2" />
      )}
    </div>
  );
}

/** What a platform can run but not show yet, with its fix to copy. */
function Warning({ text }: { text: string }) {
  const command = /`([^`]+)`/.exec(text)?.[1];
  const [copied, setCopied] = useState(false);
  return (
    <div className="mx-4 mt-4 flex items-center gap-2.5 rounded-xl bg-warning/10 py-2 pr-2 pl-3 text-body">
      <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-warning" />
      <span className="min-w-0 flex-1">{text.replace(/ Install it with.*$/, "")}</span>
      {command && (
        <button
          type="button"
          title={`Copy ${command}`}
          onClick={() => {
            void navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1_500);
          }}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-pane px-2 py-1 font-mono text-meta hover:bg-hover [&_svg]:size-3"
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {command}
        </button>
      )}
    </div>
  );
}

/**
 * One gallery card: a device's picture, and its name, with a dot while it runs. A picture that's
 * flat is turned a little, and faces front on hover; one already `turned`, a model's still, lifts.
 */
function Card({
  label,
  title,
  running,
  busy,
  turned,
  onClick,
  children,
}: {
  label: string;
  title?: string;
  running?: boolean;
  busy: boolean;
  turned?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={busy}
      className="group flex w-full flex-col items-center gap-3 rounded-2xl px-2 pt-4 pb-3 outline-none transition-colors hover:bg-hover focus-visible:bg-hover disabled:pointer-events-none"
    >
      <div className="relative grid h-[196px] place-items-center [perspective:900px]">
        <div
          className={`transition-transform duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)] [transform-style:preserve-3d] ${turned ? "group-hover:-translate-y-[3px]" : "[transform:rotateY(-24deg)_rotateX(6deg)] group-hover:[transform:rotateY(0deg)_rotateX(0deg)_translateY(-3px)]"}`}
        >
          {children}
        </div>
        {busy && (
          <div className="absolute inset-0 grid place-items-center">
            <LoaderCircle aria-hidden className="size-5 animate-spin text-white drop-shadow" />
          </div>
        )}
      </div>
      <span className="flex max-w-full items-center gap-1.5 text-body font-medium">
        {running && (
          <span aria-label="Running" className="size-1.5 shrink-0 rounded-full bg-added" />
        )}
        <span className="truncate">{label}</span>
      </span>
    </button>
  );
}

/** A device's own artwork, small, with its screen dark, for a device with no model's still. */
function Thumbnail({ hostId, device }: { hostId: string; device: DeviceInfo }) {
  const chrome = useChrome(hostId, device);
  if (chrome === undefined) {
    return <div className="h-[180px] w-[86px] animate-pulse rounded-2xl bg-selected" />;
  }
  const art =
    chrome ??
    plainChrome(device.platform === "ios" ? 1206 / 2622 : 1080 / 2400, device.platform === "ios");
  const k = 180 / art.height;
  const ios = device.platform === "ios";
  return (
    <div
      className="relative"
      style={{ width: art.width * k, height: art.height * k, transformStyle: "preserve-3d" }}
    >
      <Body chrome={art} k={k} depth={art.height * k * 0.058} ios={ios} />
      <Art
        chrome={art}
        k={k}
        screen={
          // A dark screen with a little light on it, as a phone looks off.
          <div
            className={`size-full ${ios ? "bg-[radial-gradient(120%_70%_at_30%_10%,#2a3346_0%,#0b0d12_60%)]" : "bg-[radial-gradient(120%_70%_at_70%_15%,#24302b_0%,#0a0c0b_60%)]"}`}
          />
        }
      />
    </div>
  );
}

/**
 * Artwork `chrome` at `k` pixels a unit: its layers under the screen, `screen` in the screen's
 * shape, then its layers over it. With no layers, a plain slab.
 */
function Art({
  chrome,
  k,
  screen,
  screenProps,
  onPower,
}: {
  chrome: DeviceChrome;
  k: number;
  screen: ReactNode;
  screenProps?: React.HTMLAttributes<HTMLDivElement>;
  onPower?: () => void;
}) {
  const layer = (l: DeviceChrome["layers"][number]) => (
    <img
      key={l.name}
      alt=""
      draggable={false}
      src={l.image}
      title={l.name === "power" && onPower ? "Lock" : undefined}
      onClick={l.name === "power" ? onPower : undefined}
      style={
        {
          left: l.rect.x * k,
          top: l.rect.y * k,
          width: l.rect.width * k,
          height: l.rect.height * k,
          "--pop": `${(l.hoverX ?? 0) * k}px`,
        } as React.CSSProperties
      }
      className={
        l.above || l.name === "bezel" || l.name === "back"
          ? "pointer-events-none absolute select-none [backface-visibility:hidden]"
          : "absolute transition-transform duration-150 ease-out select-none [backface-visibility:hidden] hover:translate-x-(--pop)"
      }
    />
  );
  const plain = chrome.layers.length === 0;
  return (
    <>
      {plain && (
        <div
          className="absolute inset-0 bg-linear-to-b from-[#2b2b2e] via-[#141416] to-[#1f1f22] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)] [backface-visibility:hidden]"
          style={{ borderRadius: ((chrome.cornerRadius ?? 0) + chrome.screen.x) * k }}
        />
      )}
      {chrome.layers.filter((l) => !l.above).map(layer)}
      <div
        {...screenProps}
        className={`absolute overflow-hidden bg-black select-none [backface-visibility:hidden] ${screenProps?.className ?? ""}`}
        style={{
          left: chrome.screen.x * k,
          top: chrome.screen.y * k,
          width: chrome.screen.width * k,
          height: chrome.screen.height * k,
          ...(chrome.mask
            ? { maskImage: `url(${chrome.mask})`, maskSize: "100% 100%" }
            : { borderRadius: (chrome.cornerRadius ?? 0) * k }),
        }}
      >
        {screen}
      </div>
      {chrome.layers.filter((l) => l.above).map(layer)}
    </>
  );
}

/**
 * The device's body behind its face, for the 3D view: slices of its outline stacked `depth` deep,
 * and a back with a camera.
 */
function Body({
  chrome,
  k,
  depth,
  ios,
}: {
  chrome: DeviceChrome;
  k: number;
  depth: number;
  ios: boolean;
}) {
  // The outline is the bezel's, or for a plain frame, a rounded rectangle.
  const outline = chrome.layers.find((l) => l.name === "bezel" || l.name === "back");
  const rect = outline?.rect ?? { x: 0, y: 0, width: chrome.width, height: chrome.height };
  // An emulator's frame is clear where its screen goes, so the screen's area fills it in, in the
  // screen's own shape: a square one pokes out past a thin bezel's rounded corners.
  const screenArea = [
    (chrome.screen.x - rect.x) * k,
    (chrome.screen.y - rect.y) * k,
    chrome.screen.width * k,
    chrome.screen.height * k,
  ];
  const screenShape = chrome.mask
    ? `url(${chrome.mask})`
    : `url("data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${chrome.screen.width}" height="${chrome.screen.height}"><rect width="100%" height="100%" rx="${chrome.cornerRadius ?? 0}"/></svg>`,
      )}")`;
  const shape: React.CSSProperties = outline
    ? {
        maskImage: `url(${outline.image}), ${screenShape}`,
        maskSize: `100% 100%, ${screenArea[2]}px ${screenArea[3]}px`,
        maskPosition: `0 0, ${screenArea[0]}px ${screenArea[1]}px`,
        maskRepeat: "no-repeat",
      }
    : { borderRadius: ((chrome.cornerRadius ?? 0) + chrome.screen.x) * k };
  const box = {
    left: rect.x * k,
    top: rect.y * k,
    width: rect.width * k,
    height: rect.height * k,
  };
  const slices = 14;
  return (
    <>
      {Array.from({ length: slices }, (_, i) => {
        const t = (i + 1) / (slices + 1);
        // A brushed band: lighter in the middle of the edge, as light catches the frame.
        const light = Math.round(54 + 26 * Math.sin(t * Math.PI));
        return (
          <div
            key={i}
            aria-hidden
            className="pointer-events-none absolute"
            style={{
              ...box,
              ...shape,
              background: `rgb(${light} ${light} ${light + 3})`,
              transform: `translateZ(${-t * depth}px)`,
            }}
          />
        );
      })}
      <div
        aria-hidden
        className="pointer-events-none absolute [backface-visibility:hidden]"
        style={{
          ...box,
          ...shape,
          background: ios
            ? "linear-gradient(160deg, #3b3a38 0%, #262524 55%, #1d1c1b 100%)"
            : "linear-gradient(160deg, #2a2c30 0%, #1b1c1f 60%, #141518 100%)",
          transform: `translateZ(${-depth}px) rotateY(180deg)`,
        }}
      >
        {ios ? (
          <div
            className="absolute rounded-[22%] bg-linear-to-br from-[#4a4946] to-[#2b2a28] shadow-[0_1px_0_rgb(255_255_255/0.12)_inset]"
            style={{ right: "7%", top: "3.5%", width: "44%", aspectRatio: "1" }}
          >
            {[
              ["14%", "14%"],
              ["14%", "56%"],
              ["56%", "35%"],
            ].map(([left, top]) => (
              <div
                key={`${left}${top}`}
                className="absolute rounded-full bg-[#0b0b0c] ring-[3px] ring-[#57554f]"
                style={{ left, top, width: "30%", aspectRatio: "1" }}
              />
            ))}
          </div>
        ) : (
          <div
            className="absolute flex items-center gap-[4%] rounded-full bg-linear-to-b from-[#3a3c41] to-[#1f2023] px-[6%]"
            style={{ left: "7%", right: "7%", top: "8%", height: "9%" }}
          >
            {[0, 1].map((i) => (
              <div
                key={i}
                className="h-[62%] rounded-full bg-[#09090a] ring-2 ring-[#4b4d52]"
                style={{ aspectRatio: "1" }}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * A device in its artwork: booting, waiting for streaming to be enabled, or live, where it takes
 * clicks as touches and keys while focused. Dragging around it turns it in 3D; double-clicking
 * there turns it back.
 */
function Viewer({
  hostId,
  device,
  devices,
  shown,
  hub,
  booting,
  stopping,
  failure,
  onRetry,
  onSetUp,
  onOpen,
  onGallery,
  onPowerOff,
}: {
  hostId: string;
  device: DeviceInfo;
  devices: DeviceInfo[];
  shown: boolean;
  hub: DeviceStateResult["hub"];
  booting: boolean;
  stopping: boolean;
  failure?: string;
  onRetry: () => void;
  onSetUp: () => void;
  onOpen: (device: DeviceInfo) => void;
  onGallery: () => void;
  onPowerOff: () => void;
}) {
  const ios = device.platform === "ios";
  // State, not a ref: the canvas appears once the artwork has loaded, and the stream waits for it.
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const area = useRef<HTMLDivElement>(null);
  // The flat artwork's stage, which its touches are measured from.
  const flat = useRef<HTMLDivElement>(null);
  const stream = useRef<DeviceStream>(null);
  const [status, setStatus] = useState<{ status: DeviceStreamStatus; detail?: string }>({
    status: "connecting",
  });
  const [screen, setScreen] = useState<DeviceScreen>();
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [box, setBox] = useState({ width: 0, height: 0 });
  // Which way the device faces, as Rotate turned it, and how the user has turned it in 3D.
  const [facing, setFacing] = useState<DeviceOrientation>("portrait");
  const [orbit, setOrbit] = useState({ pitch: 0, yaw: 0 });
  const [dragging, setDragging] = useState(false);
  // The 3D model: loaded once the stream is live, so it's ready before the first turn, and shown
  // while the device is turned or dragged. Facing front, and with no model, the flat artwork shows
  // and turns instead. The folding iPhone Duo is always 3D: its artwork is only its cover.
  const duo = /^iphone duo$/i.test(device.name);
  // serve-sim reports a Duo's hinge only once it changes. Until then, the display it streams says
  // whether it's shut on its cover or open.
  const live = screen ? duoDisplay(screen.width, screen.height) : 1;
  const fold = screen?.fold ?? (duo ? { display: live, angle: live === 3 ? 180 : 0 } : undefined);
  const [gl, setGl] = useState<HTMLCanvasElement | null>(null);
  const model = useRef<Device3d>(null);
  // The model on screen, once it has loaded: a rebuilt one is new, so it gets the turn again.
  const [modelShown, setModelShown] = useState<Device3d | null>(null);
  const streaming = shown && !booting && hub.installed;
  const found = useChrome(hostId, device);

  useEffect(() => {
    if (!streaming || !canvas) return;
    const live = createDeviceStream(
      { hostId, deviceId: device.id, platform: device.platform },
      canvas,
      {
        onStatus: (next, detail) => setStatus({ status: next, detail }),
        onScreen: setScreen,
        onFrame: () => modelVisible.current && model.current?.frame(),
        onInput: () => {},
      },
    );
    stream.current = live;
    live.start();
    return () => {
      live.stop();
      if (stream.current === live) stream.current = null;
    };
  }, [hostId, device.id, device.platform, streaming, attempt, canvas]);

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

  // The artwork is portrait. A device with none gets a plain frame at its screen's shape.
  const long = screen ? Math.max(screen.width, screen.height) : ios ? 2622 : 2400;
  const short = screen ? Math.min(screen.width, screen.height) : ios ? 1206 : 1080;
  const chrome = found === undefined ? undefined : (found ?? plainChrome(short / long, ios));
  const roll = { portrait: 0, landscape_left: 90, portrait_upside_down: 180, landscape_right: -90 }[
    facing
  ];
  const sideways = roll === 90 || roll === -90;
  const across = chrome ? (sideways ? chrome.height : chrome.width) : 0;
  const down = chrome ? (sideways ? chrome.width : chrome.height) : 0;
  const k = chrome ? Math.min(box.width / across, box.height / down) : 0;
  // A phone is about 6% as thick as it is tall.
  const depth = chrome ? Math.max(chrome.width, chrome.height) * k * 0.058 : 0;
  const turn: Turn = { pitch: orbit.pitch, yaw: orbit.yaw, roll };
  // Facing front after a whole turn is no turn.
  const turned = orbit.pitch !== 0 || orbit.yaw % 360 !== 0;

  // An Android phone's model depends on its screen's shape, so it's chosen again if that changes.
  const pixelAspect = ios ? 0 : short / long;
  const modelUrl = ios ? appleModel(device.name) : pixelModel(device.name, pixelAspect);
  const ready = streaming && status.status === "streaming";
  const load3d = !!modelUrl && (streaming || duo);
  useEffect(() => {
    if (!load3d || !modelUrl || !gl || !canvas) return;
    let live = true;
    let made: Device3d | undefined;
    void import("./device3d").then(({ createDevice3d }) => {
      if (!live) return;
      try {
        made = createDevice3d({ canvas: gl, source: canvas, url: modelUrl, duo });
      } catch {
        return;
      }
      const loaded = made;
      model.current = loaded;
      loaded.resize(gl.clientWidth, gl.clientHeight, window.devicePixelRatio);
      loaded.ready.then(
        () => live && setModelShown(loaded),
        () => {},
      );
    });
    return () => {
      live = false;
      made?.dispose();
      model.current = null;
      setModelShown(null);
    };
  }, [load3d, modelUrl, duo, gl, canvas]);
  useLayoutEffect(() => {
    model.current?.setPose(orbit.pitch, orbit.yaw, roll);
  }, [orbit, roll, modelShown]);
  useEffect(() => {
    if (fold) model.current?.fold(fold.display, fold.angle);
  }, [fold?.display, fold?.angle, modelShown]);
  useEffect(() => {
    if (gl) model.current?.resize(gl.clientWidth, gl.clientHeight, window.devicePixelRatio);
  }, [box, gl, modelShown]);

  // The model, loaded while the device streams, stands in for the artwork once the stream is
  // live: until then the artwork shows
  // what the device is waiting on, and its buttons, such as Try again. Facing front, the two match,
  // so a drag starts on the model with no jump.
  const modelOn = !!modelShown && ready && (turned || dragging || duo);
  // The hidden model draws no frames; shown, it catches up on the latest.
  const modelVisible = useRef(false);
  useLayoutEffect(() => {
    modelVisible.current = modelOn;
    if (modelOn) model.current?.frame();
  }, [modelOn]);
  // The touch on the flat artwork's screen, where it last was: it ends there if let go where the
  // screen can't be traced back.
  const touching = useRef<{ x: number; y: number }>(null);
  // A touch on the screen, traced back through the device's turn onto the screen's own pixels.
  const touch =
    (phase: "begin" | "move" | "end") => (event: React.PointerEvent<HTMLDivElement>) => {
      if (phase === "begin") {
        if (event.button !== 0 || !ready || !chrome) return;
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        (area.current?.querySelector('[role="application"]') as HTMLElement | null)?.focus();
      } else if (!touching.current) return;
      event.stopPropagation();
      const last = touching.current;
      if (phase === "end") touching.current = null;
      const stage = flat.current?.getBoundingClientRect();
      const hit =
        stage &&
        chrome &&
        unproject(
          turn,
          PERSPECTIVE,
          event.clientX - (stage.left + stage.width / 2),
          event.clientY - (stage.top + stage.height / 2),
        );
      const clamp = (v: number) => Math.min(1, Math.max(0, v));
      const point =
        hit && chrome
          ? {
              x: clamp(
                (hit[0] - (chrome.screen.x - chrome.width / 2) * k) / (chrome.screen.width * k),
              ),
              y: clamp(
                (hit[1] - (chrome.screen.y - chrome.height / 2) * k) / (chrome.screen.height * k),
              ),
            }
          : phase === "end"
            ? last
            : null;
      if (!point) return;
      if (phase !== "end") touching.current = point;
      stream.current?.touchRaw(phase, point.x, point.y);
    };

  // Dragging turns the device as if held by the point under the pointer: across its width is half a
  // turn around, and down its height half a turn back, so its edge follows the pointer. Each move
  // turns the model at once, and letting go glides on at the pointer's last speed.
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; t: number }>(null);
  const glide = useRef(0);
  const pose = useRef(orbit);
  // The device's size on screen and orientation as last drawn, for a glide that outlives a render.
  const view = useRef({ across: 1, down: 1, roll });
  useLayoutEffect(() => {
    view.current = { across: Math.max(1, across * k), down: Math.max(1, down * k), roll };
  });
  const turnBy = (dx: number, dy: number) => {
    const o = pose.current;
    turnTo3d({
      yaw: o.yaw + (dx * 180) / view.current.across,
      pitch: Math.max(-65, Math.min(65, o.pitch - (dy * 180) / view.current.down)),
    });
  };
  const turnTo3d = (next: { pitch: number; yaw: number }) => {
    pose.current = next;
    model.current?.setPose(next.pitch, next.yaw, view.current.roll);
    setOrbit(next);
  };
  // In the 3D model, a touch is wherever the pointer meets its screen. It ends where it last did,
  // when let go off the screen.
  const touching3d = useRef<{ x: number; y: number }>(null);
  const modelPoint = (event: React.PointerEvent, captured: boolean) => {
    const rect = gl?.getBoundingClientRect();
    if (!rect || !model.current || !modelOn) return null;
    return model.current.screenPoint(
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height,
      captured,
    );
  };
  const onStageDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !chrome) return;
    cancelAnimationFrame(glide.current);
    event.currentTarget.setPointerCapture(event.pointerId);
    const hit = ready ? modelPoint(event, false) : null;
    if (hit) {
      touching3d.current = hit;
      (area.current?.querySelector('[role="application"]') as HTMLElement | null)?.focus();
      stream.current?.touchRaw("begin", hit.x, hit.y);
      return;
    }
    pose.current = orbit;
    drag.current = { x: event.clientX, y: event.clientY, vx: 0, vy: 0, t: performance.now() };
    setDragging(true);
  };
  const onStageMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (touching3d.current) {
      const hit = modelPoint(event, true);
      if (hit) {
        touching3d.current = hit;
        stream.current?.touchRaw("move", hit.x, hit.y);
      }
      return;
    }
    const d = drag.current;
    if (!d) return;
    const now = performance.now();
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    const dt = Math.max(1, now - d.t);
    // The speed, smoothed over the last few moves, so one uneven move doesn't fling it.
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      vx: d.vx * 0.5 + (dx / dt) * 0.5,
      vy: d.vy * 0.5 + (dy / dt) * 0.5,
      t: now,
    };
    turnBy(dx, dy);
  };
  const onStageUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (touching3d.current) {
      const last = modelPoint(event, true) ?? touching3d.current;
      touching3d.current = null;
      stream.current?.touchRaw("end", last.x, last.y);
      return;
    }
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    // A pointer held still before letting go doesn't glide.
    if (!d || performance.now() - d.t > 60) return;
    let { vx, vy } = d;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(50, now - last);
      last = now;
      // Slows by about a tenth each 16ms frame, whatever the display's frame rate.
      const slow = 0.9 ** (dt / 16);
      vx *= slow;
      vy *= slow;
      if (Math.abs(vx) + Math.abs(vy) < 0.02) return;
      turnBy(vx * dt, vy * dt);
      glide.current = requestAnimationFrame(step);
    };
    glide.current = requestAnimationFrame(step);
  };
  // Turns the device to `to`. Facing front, at a whole number of turns, the flat artwork shows
  // again, at that yaw, so it doesn't ease back around.
  const turnTo = (to: { pitch: number; yaw: number }) => {
    cancelAnimationFrame(glide.current);
    const from = orbit;
    const start = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / 450);
      const eased = 1 - (1 - t) ** 3;
      turnTo3d(
        t < 1
          ? {
              pitch: from.pitch + (to.pitch - from.pitch) * eased,
              yaw: from.yaw + (to.yaw - from.yaw) * eased,
            }
          : to,
      );
      if (t < 1) glide.current = requestAnimationFrame(step);
    };
    glide.current = requestAnimationFrame(step);
  };
  // Back to facing front the shortest way.
  const faceFront = () => turnTo({ pitch: 0, yaw: Math.round(orbit.yaw / 360) * 360 });
  useEffect(() => () => cancelAnimationFrame(glide.current), []);

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
  const why = failure ?? hub.failure;

  // What the screen shows until the stream does.
  let overlay: ReactNode = null;
  const message = (text: string, action: ReactNode) => (
    <div className="flex max-w-[78%] flex-col items-center gap-3 text-center">
      <TriangleAlert aria-hidden className="size-5 text-white/70" />
      <p className="line-clamp-4 text-body leading-snug text-white/85">{text}</p>
      {action}
    </div>
  );
  if (failure && booting) {
    overlay = message(
      failure,
      <Pill dark onClick={onRetry}>
        Try again
      </Pill>,
    );
  } else if (!hub.installed && !booting) {
    overlay = hub.installing ? (
      <LoaderCircle aria-label="Enabling streaming" className="size-5 animate-spin" />
    ) : why ? (
      message(
        why,
        <Pill dark onClick={onSetUp}>
          Try again
        </Pill>,
      )
    ) : (
      <Pill
        dark
        onClick={onSetUp}
        title="Installs Expo's device hub with npm into Parallax's tools folder on this host, once."
      >
        Enable streaming
      </Pill>
    );
  } else if (booting || (streaming && status.status === "connecting")) {
    overlay = <LoaderCircle aria-label="Connecting" className="size-5 animate-spin" />;
  } else if (status.status === "error") {
    overlay = message(
      status.detail ?? "The stream stopped.",
      <Pill
        dark
        onClick={() => {
          setStatus({ status: "connecting" });
          setAttempt((n) => n + 1);
        }}
      >
        Reconnect
      </Pill>,
    );
  }

  // The device takes keys while focused: typing, and pasting as typing.
  const keyboard = {
    tabIndex: 0,
    role: "application",
    "aria-label": `${nameOf(device)} screen`,
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

  const control = (
    label: string,
    icon: ReactNode,
    onClick: () => void,
    disabled = !ready,
    pressed?: boolean,
  ) => (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-full text-muted-foreground transition-[color,background-color,transform] duration-100 hover:bg-hover hover:text-foreground active:scale-90 disabled:opacity-35 aria-pressed:bg-hover aria-pressed:text-foreground [&_svg]:size-4"
    >
      {icon}
    </button>
  );
  const menuId = useId();
  const foldMenuId = useId();

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={area}
        onPointerDown={onStageDown}
        onPointerMove={onStageMove}
        onPointerUp={onStageUp}
        onPointerCancel={onStageUp}
        onDoubleClick={faceFront}
        className={`relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden px-6 pt-6 pb-20 select-none ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
      >
        {load3d && (
          <canvas
            // A new model takes a new canvas: the last one's context is gone with it.
            key={pixelAspect}
            ref={setGl}
            aria-hidden
            className={`absolute inset-x-0 top-0 bottom-16 size-auto ${modelOn ? "" : "opacity-0"}`}
            style={{ width: "100%", height: "calc(100% - 4rem)" }}
          />
        )}
        {chrome && (
          <div
            ref={flat}
            className={`relative shrink-0 animate-[device-in_240ms_ease-out] ${modelOn ? "pointer-events-none opacity-0" : ""}`}
            style={{ width: across * k, height: down * k, perspective: PERSPECTIVE }}
          >
            <div
              {...keyboard}
              style={{
                width: chrome.width * k,
                height: chrome.height * k,
                left: (across - chrome.width) * k * 0.5,
                top: (down - chrome.height) * k * 0.5,
                transform: `rotateX(${turn.pitch}deg) rotateY(${turn.yaw}deg) rotateZ(${roll}deg)`,
                transformStyle: "preserve-3d",
              }}
              // Eased only for a new orientation: a drag, glide, or turn already moves it each frame.
              className={`absolute outline-none ${dragging || turned ? "" : "transition-transform duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)]"}`}
            >
              {/* The device's shadow on the stage, under its face. */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-[6%] rounded-[12%] bg-black/30 blur-2xl"
                style={{ transform: `translateZ(${-depth - 1}px)` }}
              />
              <Body chrome={chrome} k={k} depth={depth} ios={ios} />
              <Art
                chrome={chrome}
                k={k}
                onPower={() => press("power")}
                screenProps={{
                  className: "touch-none cursor-default",
                  onPointerDown: touch("begin"),
                  onPointerMove: touch("move"),
                  onPointerUp: touch("end"),
                  onPointerCancel: touch("end"),
                }}
                screen={
                  <>
                    <canvas
                      ref={setCanvas}
                      className={`size-full transition-opacity duration-300 ${ready ? "opacity-100" : "opacity-30"}`}
                    />
                    {overlay && (
                      <div
                        className="absolute inset-0 flex items-center justify-center text-white/80"
                        style={roll ? { transform: `rotate(${-roll}deg)` } : undefined}
                        onPointerDown={(event) => event.stopPropagation()}
                      >
                        {overlay}
                      </div>
                    )}
                  </>
                }
              />
            </div>
          </div>
        )}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3">
        <div
          role="toolbar"
          aria-label="Device controls"
          className="pointer-events-auto flex max-w-full items-center gap-0.5 rounded-full border border-border bg-surface/90 p-1 shadow-[0_10px_30px_-12px_rgb(0_0_0/0.35)] backdrop-blur-xl"
        >
          <button
            type="button"
            popoverTarget={menuId}
            className="flex min-w-0 items-center gap-1.5 rounded-full py-1.5 pr-2 pl-2.5 text-body font-medium transition-colors hover:bg-hover [&_svg]:size-3.5 [&_svg]:shrink-0"
          >
            <span className="relative text-muted-foreground">
              <PlatformMark platform={device.platform} />
            </span>
            <span className="max-w-32 truncate">{nameOf(device)}</span>
            <ChevronDown aria-hidden className="text-faint-foreground" />
          </button>
          <Menu id={menuId} label="Devices" align="center" className="mb-2 w-56 p-1">
            {devices.map((d) => (
              <button
                key={d.id}
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={() => {
                  document.getElementById(menuId)?.hidePopover();
                  if (d.id !== device.id) onOpen(d);
                }}
              >
                <PlatformMark platform={d.platform} />
                <span className="min-w-0 flex-1 truncate">{nameOf(d)}</span>
                {d.id === device.id ? (
                  <Check aria-label="Showing" />
                ) : (
                  d.booted && (
                    <span aria-label="Running" className="size-1.5 rounded-full bg-added" />
                  )
                )}
              </button>
            ))}
            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              onClick={() => {
                document.getElementById(menuId)?.hidePopover();
                onGallery();
              }}
            >
              <LayoutGrid aria-hidden />
              All devices
            </button>
            {!device.physical && (
              <button
                type="button"
                role="menuitem"
                disabled={stopping || booting}
                className={`${menuItem} text-danger disabled:opacity-50`}
                onClick={() => {
                  document.getElementById(menuId)?.hidePopover();
                  onPowerOff();
                }}
              >
                <Power aria-hidden />
                Power off
              </button>
            )}
          </Menu>
          <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
          {ios ? (
            <>
              {control("Home", <House />, () => press("home"))}
              {control("App switcher", <LayoutGrid />, () => press("appSwitcher"))}
              {control("Rotate", <RotateCw />, () => {
                const next =
                  ORIENTATIONS[(ORIENTATIONS.indexOf(facing) + 1) % ORIENTATIONS.length]!;
                setFacing(next);
                stream.current?.orient(next);
              })}
              {fold && (
                <>
                  <button
                    type="button"
                    aria-label="Fold"
                    title="Fold"
                    disabled={!ready}
                    popoverTarget={foldMenuId}
                    className="grid size-8 place-items-center rounded-full text-muted-foreground transition-[color,background-color,transform] duration-100 hover:bg-hover hover:text-foreground active:scale-90 disabled:opacity-35 [&_svg]:size-4"
                  >
                    <BookOpen />
                  </button>
                  <Menu
                    id={foldMenuId}
                    label="Fold"
                    align="center"
                    focus='[aria-checked="true"]'
                    className="mb-2 w-36 p-1"
                  >
                    {(
                      [
                        ["closed", "Closed", fold.angle === 0],
                        ["book", "Book", fold.angle > 0 && fold.angle < 180],
                        ["open", "Open", fold.angle === 180],
                      ] as const
                    ).map(([pose, label, current]) => (
                      <button
                        key={pose}
                        type="button"
                        role="menuitemradio"
                        aria-checked={current}
                        className={menuItem}
                        onClick={() => {
                          document.getElementById(foldMenuId)?.hidePopover();
                          stream.current?.fold(pose);
                        }}
                      >
                        <span className="flex-1">{label}</span>
                        {current && <Check aria-hidden />}
                      </button>
                    ))}
                  </Menu>
                </>
              )}
            </>
          ) : (
            <>
              {control("Back", <Triangle className="-rotate-90" />, () => press("back"))}
              {control("Home", <Circle />, () => press("home"))}
              {control("Recents", <LayoutGrid />, () => press("recents"))}
            </>
          )}
          {control(
            copied ? "Copied screenshot" : "Copy screenshot",
            copied ? <Check /> : <Camera />,
            () => void screenshot(),
            booting || !device.booted,
          )}
          {turned
            ? control("Face front", <Rotate3d />, faceFront, false)
            : control(
                "Turn in 3D",
                <Rotate3d />,
                () => turnTo({ pitch: 12, yaw: Math.round(orbit.yaw / 360) * 360 - 32 }),
                false,
              )}
          {stopping && (
            <LoaderCircle
              aria-label="Powering off"
              className="mx-2 size-4 animate-spin text-muted-foreground"
            />
          )}
        </div>
      </div>
    </div>
  );
}
