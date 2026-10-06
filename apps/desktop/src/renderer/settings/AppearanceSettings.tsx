import { useId } from "react";

import type { ThemePreference } from "../../preload/bridge";
import { setAppearance, useAppearance, type Appearance } from "../appearance";
import { Segmented } from "../ui";
import { PageTitle, Row, Section, Switch } from "./parts";
import { TypographySettings } from "./TypographySettings";

// The app's two marks and its accent in each mode (index.css).
const marks = ["#2b5cff", "#ff4a1f"];
const accents = { light: "#2563eb", dark: "#3b82f6" };

// A preview's colors, fixed, so each card shows its mode whatever the app is in.
const swatches = {
  light: { bg: "#ffffff", side: "#f5f5f5", line: "#e5e5e5", card: "#ffffff", edge: "#e5e5e5" },
  dark: { bg: "#0d0d0d", side: "#000000", line: "#2a2a2a", card: "#171717", edge: "#2a2a2a" },
};

/** A small drawing of the app in `mode`: the sidebar, a few lines, a card, and the composer. */
function SchemePreview({ mode }: { mode: "light" | "dark" }) {
  const c = swatches[mode];
  const bar = (width: string, color = c.line) => (
    <span className="block h-1.5 rounded-full" style={{ width, background: color }} />
  );
  return (
    <span className="flex h-full" style={{ background: c.bg }}>
      <span className="flex w-1/5 flex-col gap-1.5 p-2" style={{ background: c.side }}>
        {bar("100%")}
        {bar("80%")}
        {bar("90%")}
      </span>
      <span className="flex flex-1 flex-col gap-1.5 p-2.5">
        <span className="flex items-start justify-between gap-2">
          <span className="flex flex-1 flex-col gap-1.5">
            {bar("70%")}
            {bar("50%")}
          </span>
          <span
            className="flex w-1/3 flex-col gap-1 rounded-md border p-1.5"
            style={{ background: c.card, borderColor: c.edge }}
          >
            {marks.map((m) => (
              <span key={m} className="flex items-center gap-1">
                <span className="size-1 rounded-full" style={{ background: m }} />
                {bar("70%")}
              </span>
            ))}
          </span>
        </span>
        <span
          className="mt-auto flex items-center justify-between rounded-full border px-2 py-1"
          style={{ background: c.card, borderColor: c.edge }}
        >
          {bar("40%")}
          <span className="size-2.5 rounded-full" style={{ background: accents[mode] }} />
        </span>
      </span>
    </span>
  );
}

const schemes: { value: ThemePreference; name: string }[] = [
  { value: "system", name: "System" },
  { value: "light", name: "Light" },
  { value: "dark", name: "Dark" },
];

const card =
  "flex cursor-pointer flex-col gap-2 rounded-xl border border-border bg-surface p-2 text-center text-[12.5px] text-muted-foreground hover:bg-hover has-checked:border-accent has-checked:text-foreground has-checked:outline-1 has-checked:outline-accent has-focus-visible:outline-2 has-focus-visible:outline-ring";

/**
 * Settings > Appearance: the color scheme and how the interface reads:
 * contrast, motion, the colors for added and removed, and typography.
 */
export function AppearanceSettings({
  theme,
  onThemeChange,
}: {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
}) {
  const appearance = useAppearance();
  const set = (change: Partial<Appearance>) => setAppearance(change);
  const scheme = useId();

  return (
    <>
      <PageTitle title="Appearance" />
      <Section title="Color scheme">
        <fieldset aria-label="Color scheme" className="grid grid-cols-3 gap-3 p-3">
          {schemes.map((s) => (
            <label key={s.value} className={card}>
              <input
                type="radio"
                name={scheme}
                value={s.value}
                checked={theme === s.value}
                onChange={() => onThemeChange(s.value)}
                className="sr-only"
              />
              <span className="relative block aspect-[16/10] overflow-hidden rounded-lg border border-border">
                {s.value === "system" ? (
                  <>
                    <SchemePreview mode="dark" />
                    {/* Light on the left half, over the dark one. */}
                    <span className="absolute inset-0 [clip-path:inset(0_50%_0_0)]">
                      <SchemePreview mode="light" />
                    </span>
                  </>
                ) : (
                  <SchemePreview mode={s.value} />
                )}
              </span>
              {s.name}
            </label>
          ))}
        </fieldset>
      </Section>

      <Section title="Interface">
        <Row title="Contrast" description="Stronger text and borders. System follows your OS.">
          <Segmented
            label="Contrast"
            options={[
              { value: "system", name: "System" },
              { value: "standard", name: "Standard" },
              { value: "more", name: "More" },
            ]}
            value={appearance.contrast}
            onChange={(contrast) => set({ contrast })}
          />
        </Row>
        <Row
          title="Reduce motion"
          description="Stops animations. Also on whenever your OS asks for less motion."
        >
          <Switch
            label="Reduce motion"
            checked={appearance.motion === "reduce"}
            onChange={(on) => set({ motion: on ? "reduce" : "system" })}
          />
        </Row>
        <Row
          title="Change colors"
          description="What marks added and removed lines, and done and failed work."
        >
          <Segmented
            label="Change colors"
            options={[
              { value: "redGreen", name: "Red & green" },
              { value: "blueOrange", name: "Blue & orange" },
            ]}
            value={appearance.diffColors}
            onChange={(diffColors) => set({ diffColors })}
          />
        </Row>
      </Section>

      <TypographySettings />
    </>
  );
}
