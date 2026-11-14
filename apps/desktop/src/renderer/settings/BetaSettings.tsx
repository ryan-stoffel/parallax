import { t } from "i18next";

import { threadTabs } from "../tabState";
import { PageTitle, Row, Section, Switch } from "./parts";

/** Settings > Beta: features still taking shape, each off until turned on. */
export function BetaSettings() {
  const tabs = threadTabs.use();
  return (
    <>
      <PageTitle title={t("Beta")}>
        {t("Features still taking shape. Each is off until you turn it on.")}
      </PageTitle>
      <Section title={t("Window")}>
        <Row
          title={t("Tabs")}
          description={t(
            "Threads open as tabs above each pane, drawn as cards. Off, each pane shows one thread under the classic top bar.",
          )}
        >
          <Switch label={t("Use tabs")} checked={tabs} onChange={(next) => threadTabs.set(next)} />
        </Row>
      </Section>
    </>
  );
}
