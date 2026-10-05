import { useEffect, useState } from "react";

import type { OpenTarget } from "../../preload/bridge";
import { useConnection } from "../ConnectionStatus";
import { localId, useHosts } from "../hosts";
import { nameOf, OPEN_TARGET_KEY } from "../OpenMenu";
import { accessPrefs } from "../accessPrefs";
import { archivePageSize, sidebarPrefs, type SidebarPrefs } from "../sidebarPrefs";
import { notices } from "./licenses";
import { HostPicker, PageTitle, quietButton, Row, Section, Switch } from "./parts";

/**
 * Settings > General: where Open sends a folder, usage limits on a host, and the app's version
 * and bundled-font notices.
 */
export function GeneralSettings() {
  const [showNotices, setShowNotices] = useState(false);
  const [targets, setTargets] = useState<OpenTarget[]>([]);
  const [chosen, setChosen] = useState(() => localStorage.getItem(OPEN_TARGET_KEY));
  const [version, setVersion] = useState<string>();
  useEffect(() => {
    void window.parallax.openTargets(localId).then(setTargets);
    void window.parallax.version().then(setVersion);
  }, []);
  const current = targets.find((t) => t === chosen) ?? targets[0];
  const sidebar = sidebarPrefs.use();
  const setSidebar = (patch: Partial<SidebarPrefs>) =>
    sidebarPrefs.set({ ...sidebarPrefs.get(), ...patch });

  return (
    <>
      <PageTitle title="General" />
      <Section title="Sidebar">
        <Row
          title="Working section"
          description="While a thread is working, list it under Working, above Archived. Off keeps it in Threads."
        >
          <Switch
            label="Working section"
            checked={sidebar.workingSection}
            onChange={(workingSection) => setSidebar({ workingSection })}
          />
        </Row>
        <Row
          title="Archive pages"
          description={`Show ${archivePageSize} archived threads at a time, with Show more for the rest. Off lists them all.`}
        >
          <Switch
            label="Archive pages"
            checked={sidebar.pageArchived}
            onChange={(pageArchived) => setSidebar({ pageArchived })}
          />
        </Row>
      </Section>
      <Section title="Access">
        <Row
          title="Legacy Plan mode"
          description="List Plan in the Access picker. A thread already in Plan keeps it either way."
        >
          <Switch
            label="Legacy Plan mode"
            checked={accessPrefs.use().legacyPlan}
            onChange={(legacyPlan) => accessPrefs.set({ legacyPlan })}
          />
        </Row>
      </Section>
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
        <Row
          title="Open source licenses"
          description="Notices for the fonts bundled with Parallax."
        >
          <button
            type="button"
            aria-expanded={showNotices}
            onClick={() => setShowNotices(!showNotices)}
            className={quietButton}
          >
            {showNotices ? "Hide licenses" : "View licenses"}
          </button>
        </Row>
        {showNotices &&
          notices.map((n) => (
            <details key={n.name} className="border-t border-border px-4 py-3">
              <summary className="cursor-pointer text-[13px] font-medium">
                {n.name}{" "}
                <span className="font-mono text-[12px] font-normal text-muted-foreground">
                  {n.license}
                </span>
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto font-mono text-[11.5px] whitespace-pre-wrap text-muted-foreground">
                {n.text}
              </pre>
            </details>
          ))}
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
