import { navChoices } from "../SidebarNav";
import { navDefaults, newSidebar, sidebarNav } from "../sidebarPrefs";
import { PageTitle, Row, Section, Switch } from "./parts";

/**
 * Settings > Beta: features still taking shape, each off until turned on. The new sidebar (0090)
 * switches with the classic one, and while it's on, where each of its pages shows.
 */
export function BetaSettings() {
  const on = newSidebar.use();
  const nav = { ...navDefaults, ...sidebarNav.use() };
  return (
    <>
      <PageTitle title="Beta">
        Features still taking shape. Each is off until you turn it on.
      </PageTitle>
      <Section title="Sidebar">
        <Row
          title="New sidebar"
          description="New thread, Search, and Projects as rows, pinned projects, and a Projects page. Off, the sidebar is the classic one."
        >
          <Switch
            label="Use the new sidebar"
            checked={on}
            onChange={(next) => newSidebar.set(next)}
          />
        </Row>
        {on &&
          navChoices.map(({ id, label }) => (
            <Row
              key={id}
              title={label}
              description="In the sidebar's head. Off, it waits under More."
            >
              <Switch
                label={`Show ${label} in the sidebar`}
                checked={nav[id]}
                onChange={(show) => sidebarNav.set({ ...nav, [id]: show })}
              />
            </Row>
          ))}
      </Section>
    </>
  );
}
