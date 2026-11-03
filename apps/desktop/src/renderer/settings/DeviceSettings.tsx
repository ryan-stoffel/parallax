import { ArrowUpRight, Check, LoaderCircle, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RpcError } from "../../preload/bridge";
import type {
  DeviceInfo,
  DevicePlatform,
  DeviceStateResult,
} from "../../protocol/generated/protocol";
import { statusLabel, useConnection } from "../ConnectionStatus";
import { describeError } from "../errors";
import { localId, useHosts } from "../hosts";
import { notify } from "../notifications";
import { IconButton } from "../ui";
import {
  HostPicker,
  outlineButton,
  PageTitle,
  primaryButton,
  quietButton,
  Row,
  Section,
  StatusDot,
} from "./parts";

/** Each platform's name, and where to get what it needs. */
const platformInfo: Record<DevicePlatform, { name: string; setup: string }> = {
  ios: { name: "iOS Simulators", setup: "https://developer.apple.com/xcode/" },
  android: { name: "Android Emulators", setup: "https://developer.android.com/studio" },
};

/** How often the list refreshes while the hub installs or a device boots. */
const POLL_MS = 3000;

/** A request's refusal, for people, or nothing. */
const refused = (answer: { error: RpcError } | object) =>
  "error" in answer ? describeError(answer.error) : undefined;

/**
 * Settings > Devices: whether a host can run iOS Simulators and Android Emulators, what to install
 * when it can't, the device hub that streams them to the Device panel, and its devices, each with
 * Start or Stop. Agents use the same ones.
 */
export function DeviceSettings() {
  const hosts = useHosts();
  const [hostId, setHostId] = useState(localId);
  const connection = useConnection(hostId);
  const connected = connection?.status === "connected";
  const supported = connected && "devices" in connection.capabilities;
  const [state, setState] = useState<DeviceStateResult>();
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  // Devices starting or stopping, and platforms making one, by id.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  const shown = useRef(hostId);
  shown.current = hostId;
  const load = useCallback(async () => {
    setChecking(true);
    const answer = await window.parallax.request(hostId, "device/state", {});
    // The picker has left this host: its devices aren't the ones on screen.
    if (shown.current !== hostId) return;
    setChecking(false);
    if ("error" in answer) setError(describeError(answer.error));
    else {
      setState(answer.result);
      setError(undefined);
    }
  }, [hostId]);
  useEffect(() => {
    setState(undefined);
    setError(undefined);
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
      ? "Update Parallax on this host to use devices."
      : (error ?? (state ? undefined : "Checking…"));

  return (
    <>
      <PageTitle
        title="Devices"
        action={
          <div className="flex items-center gap-2">
            <HostPicker hosts={hosts} value={hostId} onChange={setHostId} />
            <IconButton
              label="Refresh"
              disabled={!supported || checking}
              onClick={() => void load()}
            >
              <RefreshCw aria-hidden className={checking ? "animate-spin" : undefined} />
            </IconButton>
          </div>
        }
      >
        The simulators and emulators threads run apps on. They show in the side panel&apos;s Device
        tab, and agents open them with their device tools.
      </PageTitle>
      {note ? (
        <Section title="Platforms">
          <Row title={note} />
        </Section>
      ) : (
        state && (
          <>
            <Section title="Platforms">
              {state.platforms.map((p) => {
                const info = platformInfo[p.platform];
                return (
                  <Row
                    key={p.platform}
                    title={
                      <span className="flex items-center gap-2">
                        <StatusDot tone={p.unavailable ? "off" : p.warning ? "warn" : "on"} />
                        {info.name}
                      </span>
                    }
                    description={p.unavailable ?? p.warning ?? "Ready on this host."}
                  >
                    {p.unavailable ? (
                      <a
                        href={info.setup}
                        target="_blank"
                        rel="noreferrer"
                        className={outlineButton}
                      >
                        Get what it needs
                        <ArrowUpRight aria-hidden />
                      </a>
                    ) : p.canCreate ? (
                      <button
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
                        New device
                      </button>
                    ) : null}
                  </Row>
                );
              })}
            </Section>
            <Section title="Device hub">
              <Row
                title={
                  <span className="flex items-center gap-2">
                    <StatusDot
                      tone={state.hub.failure ? "error" : state.hub.installed ? "on" : "off"}
                    />
                    {state.hub.installed
                      ? "Installed"
                      : state.hub.installing
                        ? "Installing…"
                        : "Not installed"}
                  </span>
                }
                description={
                  state.hub.failure ? (
                    <span role="alert" className="text-danger">
                      {state.hub.failure}
                    </span>
                  ) : (
                    "Streams a running device to the Device tab, and takes your touches."
                  )
                }
              >
                {state.hub.installed ? (
                  <Check aria-hidden className="size-4 text-added" />
                ) : (
                  <button
                    type="button"
                    className={primaryButton}
                    disabled={state.hub.installing}
                    onClick={() => void setUp()}
                  >
                    {state.hub.failure ? "Try again" : "Install"}
                  </button>
                )}
              </Row>
            </Section>
            <Section title="Devices">
              {state.devices.length === 0 ? (
                <Row
                  title="None yet"
                  description="Make one above, or in Xcode or Android Studio, then refresh."
                />
              ) : (
                state.devices.map((d) => (
                  <Row
                    key={d.id}
                    title={
                      <span className="flex items-center gap-2">
                        <StatusDot tone={d.booted ? "on" : "off"} />
                        {d.name}
                      </span>
                    }
                    description={`${d.version}${d.physical ? " · Physical device" : ""}${d.booted ? " · Running" : ""}`}
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
                ))
              )}
            </Section>
          </>
        )
      )}
    </>
  );
}
