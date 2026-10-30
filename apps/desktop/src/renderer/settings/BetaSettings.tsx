import { PageTitle } from "./parts";

/**
 * Settings > Beta: features still taking shape, each off until turned on. None is in beta now: the
 * sidebar's layouts moved to Appearance › Sidebar (0091).
 */
export function BetaSettings() {
  return (
    <>
      <PageTitle title="Beta">
        Features still taking shape. Each is off until you turn it on.
      </PageTitle>
      <p className="text-body text-muted-foreground">Nothing is in beta right now.</p>
    </>
  );
}
