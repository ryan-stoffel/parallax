import { ArrowUpRight, Check, LoaderCircle, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";

import type { RpcError } from "../../preload/bridge";
import type {
  DeviceInfo,
  DevicePlatform,
  DevicePlatformState,
  DeviceStateResult,
} from "../../protocol/generated/protocol";
import { statusLabel, useConnection } from "../ConnectionStatus";
import { describeError } from "../errors";
import { useHosts, type Host } from "../hosts";
import { AndroidLogo, AppleLogo } from "../logos";
import { notify } from "../notifications";
import { IconButton } from "../ui";
import {
  allHosts,
  HostPicker,
  hostsOf,
  outlineButton,
  primaryButton,
  quietButton,
  Row,
  Section,
  StatusDot,
} from "./parts";

/** Each platform's names, logo, and where to get what it needs. */
const platformInfo: Record<
  DevicePlatform,
  {
    name: string;
    device: string;
    Logo: ComponentType<{ className?: string }>;
    setup: string;
    tool: string;
  }
> = {
  ios: {
    name: "iOS",
    device: "iOS device",
    Logo: AppleLogo,
    setup: "https://developer.apple.com/xcode/",
    tool: "Xcode",
  },
  android: {
    name: "Android",
    device: "Android device",
    Logo: AndroidLogo,
    setup: "https://developer.android.com/studio",
    tool: "Android Studio",
  },
};

/** How often the list refreshes while the hub installs or a device boots. */
const POLL_MS = 3000;

/** A request's refusal, for people, or nothing. */
const refused = (answer: { error: RpcError } | object) =>
  "error" in answer ? describeError(answer.error) : undefined;

/**
 * Settings > Devices: on each computer, or the one picked, the device hub that streams simulators
 * and emulators to the Device panel, whether it can run them, and its devices, each with Start or
 * Stop. Agents use the same ones.
 */
export function DeviceSettings() {
  const hosts = useHosts();
  const [scope, setScope] = useState(allHosts);
  const targets = hostsOf(hosts, scope);
  return (
    <>
      <div className="mb-8">
        <HostPicker hosts={hosts} value={scope} onChange={setScope} always all />
      </div>
      {targets.map((host) => (
        <div key={host.id}>
          {targets.length > 1 && <h2 className="mb-4 text-heading font-semibold">{host.name}</h2>}
          <HostDevices host={host} />
        </div>
      ))}
    </>
  );
}

/** A platform's logo: lit when this computer can run it, faint with why not when it can't. */
function PlatformLogo({ state }: { state: DevicePlatformState }) {
  const { name, Logo } = platformInfo[state.platform];
  const note = state.unavailable ?? state.warning ?? `${name} is ready`;
  return (
    <span
      role="img"
      aria-label={note}
      title={note}
      className={state.unavailable ? "text-faint-foreground opacity-50" : "text-foreground"}
    >
      <Logo className="size-5" />
    </span>
  );
}

/** One computer's hub, source, and devices. */
function HostDevices({ host }: { host: Host }) {
  const hostId = host.id;
  const connection = useConnection(hostId);
  const connected = connection?.status === "connected";
  const supported = connected && "devices" in connection.capabilities;
  const [state, setState] = useState<DeviceStateResult>();
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  // Devices starting or stopping, and platforms making one, by id.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setChecking(true);
    const answer = await window.parallax.request(hostId, "device/state", {});
    if (!mounted.current) return;
    setChecking(false);
    if ("error" in answer) setError(describeError(answer.error));
    else {
      setState(answer.result);
      setError(undefined);
    }
  }, [hostId]);
  useEffect(() => {
    if (supported) void load();
  }, [supported, load]);
  const installing = !!state?.hub.installing;
  useEffect(() => {
    if (!installing) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [installing, load]);

  /** Runs `request` for `id`, then lists again. `failed` titles what it says when refused. */
  const act = async (id: string, failed: string, request: () => Promise<string | undefined>) => {
    setBusy((all) => new Set(all).add(id));
    const problem = await request();
    setBusy((all) => {
      const next = new Set(all);
      next.delete(id);
      return next;
    });
    if (problem) notify({ tone: "error", title: failed, body: problem });
    await load();
  };
  const setUp = () =>
    act("hub", "Couldn't install the device hub", async () =>
      refused(await window.parallax.request(hostId, "device/setup", {})),
    );
  const create = (platform: DevicePlatform) =>
    act(platform, "Couldn't make the device", async () =>
      refused(await window.parallax.request(hostId, "device/create", { platform })),
    );
  const toggle = (device: DeviceInfo) =>
    act(device.id, `Couldn't ${device.booted ? "stop" : "start"} ${device.name}`, async () =>
      refused(
        await window.parallax.request(hostId, device.booted ? "device/shutdown" : "device/boot", {
          deviceId: device.id,
          platform: device.platform,
        }),
      ),
    );

  const note = !connected
    ? connection
      ? statusLabel(connection)
      : "Connecting…"
    : !supported
      ? "Update Parallax on this computer to use devices."
      : (error ?? (state ? undefined : "Checking…"));
  if (note || !state)
    return (
      <Section title="Devices">
        <Row title={note ?? "Checking…"} />
      </Section>
    );

  const hub = state.hub;
  const hubStatus = hub.installed ? "Installed" : hub.installing ? "Installing…" : "Not installed";
  const missing = state.platforms.filter((p) => p.unavailable);
  return (
    <>
      <Section title="Devices">
        <Row
          title="Device hub"
          description={
            hub.failure ? (
              <span role="alert" className="text-danger">
                {hub.failure}
              </span>
            ) : (
              <>
                Opens simulators and emulators in the Device panel. Hub:{" "}
                <span className="font-medium text-foreground">{hubStatus}</span>
              </>
            )
          }
        >
          {hub.installed ? (
            <Check aria-hidden className="size-4 text-added" />
          ) : (
            <button
              type="button"
              className={primaryButton}
              disabled={hub.installing}
              onClick={() => void setUp()}
            >
              {hub.failure ? "Try again" : "Install"}
            </button>
          )}
        </Row>
        <Row
          title="Agents can use devices"
          description="Agent sessions on this computer open and drive these devices with their device tools."
        >
          <span className="text-body text-muted-foreground">Always on</span>
        </Row>
      </Section>
      <Section
        title="Device sources"
        action={
          <div className="flex items-center gap-2">
            {state.platforms
              .filter((p) => p.canCreate && !p.unavailable)
              .map((p) => (
                <button
                  key={p.platform}
                  type="button"
                  className={outlineButton}
                  disabled={busy.has(p.platform)}
                  onClick={() => void create(p.platform)}
                >
                  {busy.has(p.platform) ? (
                    <LoaderCircle aria-hidden className="animate-spin" />
                  ) : (
                    <Plus aria-hidden />
                  )}
                  New {platformInfo[p.platform].device}
                </button>
              ))}
            <IconButton label="Refresh" disabled={checking} onClick={() => void load()}>
              <RefreshCw aria-hidden className={checking ? "animate-spin" : undefined} />
            </IconButton>
          </div>
        }
      >
        <Row
          title="Local simulators"
          description={
            <>
              Simulators and emulators installed on this computer.
              {missing.map((p) => (
                <span key={p.platform} className="mt-1 block">
                  {p.unavailable}{" "}
                  <a
                    href={platformInfo[p.platform].setup}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 underline hover:text-foreground"
                  >
                    Get {platformInfo[p.platform].tool}
                    <ArrowUpRight aria-hidden className="size-3" />
                  </a>
                </span>
              ))}
            </>
          }
        >
          {state.platforms.map((p) => (
            <PlatformLogo key={p.platform} state={p} />
          ))}
        </Row>
      </Section>
      <Section title="Simulators and emulators">
        {state.devices.length === 0 ? (
          <Row
            title="None yet"
            description="Make one above, or in Xcode or Android Studio, then refresh."
          />
        ) : (
          state.devices.map((d) => {
            const { Logo } = platformInfo[d.platform];
            return (
              <Row
                key={d.id}
                title={
                  <span className="flex items-center gap-2.5">
                    <Logo className="size-4 shrink-0 text-muted-foreground" />
                    {d.name}
                  </span>
                }
                description={
                  <span className="flex items-center gap-1.5">
                    {d.booted && <StatusDot tone="on" />}
                    {d.version}
                    {d.physical && " · Physical device"}
                    {d.booted && " · Running"}
                  </span>
                }
              >
                {!d.physical && (
                  <button
                    type="button"
                    className={d.booted ? quietButton : outlineButton}
                    aria-label={`${d.booted ? "Stop" : "Start"} ${d.name}`}
                    disabled={busy.has(d.id)}
                    onClick={() => void toggle(d)}
                  >
                    {busy.has(d.id) ? "Working…" : d.booted ? "Stop" : "Start"}
                  </button>
                )}
              </Row>
            );
          })
        )}
      </Section>
    </>
  );
}
