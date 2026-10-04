import { useEffect, useState } from "react";

import type { OpenTarget } from "../../preload/bridge";
import { useConnection } from "../ConnectionStatus";
import { localId, useHosts } from "../hosts";
import { nameOf, OPEN_TARGET_KEY } from "../OpenMenu";
import { HostPicker, PageTitle, Row, Section, Switch } from "./parts";

/** Settings > General: where Open sends a folder, usage limits on a host, and the app's version. */
export function GeneralSettings() {
  const [targets, setTargets] = useState<OpenTarget[]>([]);
  const [chosen, setChosen] = useState(() => localStorage.getItem(OPEN_TARGET_KEY));
  const [version, setVersion] = useState<string>();
  useEffect(() => {
    void window.parallax.openTargets(localId).then(setTargets);
    void window.parallax.version().then(setVersion);
  }, []);
  const current = targets.find((t) => t === chosen) ?? targets[0];

  return (
    <>
      <PageTitle title="General" />
      <Section title="Open">
        <Row
          title="Open folders in"
          description="What Open and its shortcut use, until you pick another from its menu."
        >
          <select
            aria-label="Open folders in"
            value={current ?? ""}
            disabled={!targets.length}
            onChange={(e) => {
              localStorage.setItem(OPEN_TARGET_KEY, e.target.value);
              setChosen(e.target.value);
            }}
            className="rounded-md border border-border bg-background px-2 py-1 text-[13px]"
          >
            {targets.map((t) => (
              <option key={t} value={t}>
                {nameOf(t)}
              </option>
            ))}
          </select>
        </Row>
      </Section>
      <UsageLimits />
      <Section title="About">
        <Row title="Version">
          <span className="font-mono text-[12px] text-muted-foreground">{version ?? "…"}</span>
        </Row>
      </Section>
    </>
  );
}

/**
 * Whether a host's runs wait out a usage limit and resume when it resets (`host/settings`, 0049).
 * A thread's own toggle, in its menu, overrides it.
 */
function UsageLimits() {
  const hosts = useHosts();
  const [hostId, setHostId] = useState(localId);
  const connection = useConnection(hostId);
  const supported = connection?.status === "connected" && "autoResume" in connection.capabilities;
  const [on, setOn] = useState<boolean>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setOn(undefined);
    setError(undefined);
    if (!supported) return;
    let stale = false;
    void window.parallax.request(hostId, "host/settings/get", {}).then((answer) => {
      if (stale) return;
      if ("error" in answer) setError(answer.error.message);
      else setOn(answer.result.autoResume);
    });
    return () => {
      stale = true;
    };
  }, [hostId, supported]);
  const set = async (autoResume: boolean) => {
    setOn(autoResume);
    const answer = await window.parallax.request(hostId, "host/settings/set", { autoResume });
    if ("error" in answer) {
      setOn(!autoResume);
      setError(answer.error.message);
    } else {
      setOn(answer.result.autoResume);
      setError(undefined);
    }
  };

  return (
    <Section
      title="Usage limits"
      action={<HostPicker hosts={hosts} value={hostId} onChange={setHostId} />}
    >
      <Row
        title="Resume after a usage limit"
        description={
          error ??
          (connection?.status === "connected" && !supported
            ? "This host's plxd can't resume threads after a usage limit."
            : "A thread a usage limit stopped continues once the limit resets. Each thread's menu can override this.")
        }
      >
        <Switch
          label="Resume after a usage limit"
          checked={on ?? false}
          disabled={on === undefined}
          onChange={(next) => void set(next)}
        />
      </Row>
    </Section>
  );
}
