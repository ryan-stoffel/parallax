import { threadTabs } from "../tabState";
import { PageTitle, Row, Section, Switch } from "./parts";

/** Settings > Beta: features still taking shape, each off until turned on. */
export function BetaSettings() {
  const tabs = threadTabs.use();
  return (
    <>
      <PageTitle title="Beta">
        Features still taking shape. Each is off until you turn it on.
      </PageTitle>
      <Section title="Window">
        <Row
          title="Tabs"
          description="Threads open as tabs above each pane, drawn as cards. Off, each pane shows one thread under the classic top bar."
        >
          <Switch label="Use tabs" checked={tabs} onChange={(next) => threadTabs.set(next)} />
        </Row>
      </Section>
    </>
  );
}
