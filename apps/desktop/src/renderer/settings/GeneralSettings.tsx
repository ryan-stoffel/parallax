import { useEffect, useState } from "react";

import type { OpenTarget } from "../../preload/bridge";
import { localId } from "../hosts";
import { nameOf, OPEN_TARGET_KEY } from "../OpenMenu";
import { archivePageSize, sidebarPrefs, type SidebarPrefs } from "../sidebarPrefs";
import { PageTitle, Row, Section, Switch } from "./parts";

/** Settings > General: where Open sends a folder, and the app's version. */
export function GeneralSettings() {
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
      <Section title="About">
        <Row title="Version">
          <span className="font-mono text-[12px] text-muted-foreground">{version ?? "…"}</span>
        </Row>
      </Section>
    </>
  );
}
