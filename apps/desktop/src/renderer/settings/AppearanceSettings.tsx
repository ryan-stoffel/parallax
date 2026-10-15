import { useId } from "react";

import type { ThemePreference } from "../../preload/bridge";
import {
  colorThemes,
  setAppearance,
  useAppearance,
  type Appearance,
  type ColorTheme,
} from "../appearance";
import { behaviorPrefs, setBehaviorPrefs, usageView } from "../prefs";
import { Segmented } from "../ui";
import { PageTitle, Row, Section, Switch } from "./parts";
import { TypographySettings } from "./TypographySettings";

/** What each usage view shows, for its row's description. */
const usageDescriptions = {
  ring: "A ring by the attach button fills with the fullest limit. Hover it for every limit and the thread's context, cache, and speed.",
  inline:
    "A row inside the prompt box, under its pickers, with every limit and the thread's context, speed, and cache.",
  off: "No usage in the composer. The Usage page still has it.",
};

/**
 * A small drawing of the app in `theme`'s `mode`: the sidebar, a few lines, a card, and the
 * composer. It draws with the real tokens, which .scheme-light or .scheme-dark beside the
 * theme's class set whatever mode the app is in (index.css).
 */
function SchemePreview({ mode, theme }: { mode: "light" | "dark"; theme: ColorTheme }) {
  const bar = (width: string) => (
    <span
      className="block h-1.5 rounded-full"
      style={{ width, background: "color-mix(in oklab, var(--foreground) 16%, transparent)" }}
    />
  );
  return (
    <span className={`scheme-${mode} theme-${theme} flex h-full bg-background`}>
      <span className="flex w-1/5 flex-col gap-1.5 bg-sidebar p-2">
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
          <span className="flex w-1/3 flex-col gap-1 rounded-md border border-border bg-surface p-1.5">
            {["var(--mark-blue)", "var(--mark-coral)"].map((m) => (
              <span key={m} className="flex items-center gap-1">
                <span className="size-1 rounded-full" style={{ background: m }} />
                {bar("70%")}
              </span>
            ))}
          </span>
        </span>
        <span className="mt-auto flex items-center justify-between rounded-full border border-border bg-surface px-2 py-1">
          {bar("40%")}
          <span className="size-2.5 rounded-full bg-accent" />
        </span>
      </span>
    </span>
  );
}

/** The light and dark themes together: light on the left half, over the dark one. */
function SplitPreview({ light, dark }: { light: ColorTheme; dark: ColorTheme }) {
  return (
    <>
      <SchemePreview mode="dark" theme={dark} />
      <span className="absolute inset-0 [clip-path:inset(0_50%_0_0)]">
        <SchemePreview mode="light" theme={light} />
      </span>
    </>
  );
}

const schemes: { value: ThemePreference; name: string }[] = [
  { value: "system", name: "System" },
  { value: "light", name: "Light" },
  { value: "dark", name: "Dark" },
];

const preview = "relative block aspect-[16/10] overflow-hidden rounded-lg border border-border";
const card =
  "flex cursor-pointer flex-col gap-2 rounded-xl border border-border bg-surface p-2 text-center text-[12.5px] text-muted-foreground hover:bg-hover has-checked:border-accent has-checked:text-foreground has-checked:outline-1 has-checked:outline-accent has-focus-visible:outline-2 has-focus-visible:outline-ring";

/**
 * Settings > Appearance: the color theme and scheme, and how the interface reads:
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
  const composerUsage = usageView(behaviorPrefs.use().composerUsage);
  const set = (change: Partial<Appearance>) => setAppearance(change);
  const scheme = useId();
  const themeGroup = useId();

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
              <span className={preview}>
                {s.value === "system" ? (
                  <SplitPreview light={appearance.lightTheme} dark={appearance.darkTheme} />
                ) : (
                  <SchemePreview
                    mode={s.value}
                    theme={s.value === "light" ? appearance.lightTheme : appearance.darkTheme}
                  />
                )}
              </span>
              {s.name}
            </label>
          ))}
        </fieldset>
      </Section>

      {(["light", "dark"] as const).map((mode) => {
        const field = mode === "light" ? "lightTheme" : "darkTheme";
        const title = mode === "light" ? "Light theme" : "Dark theme";
        return (
          <Section key={mode} title={title}>
            <fieldset aria-label={title} className="grid grid-cols-4 gap-3 p-3">
              {colorThemes
                .filter((t) => t.mode === mode)
                .map((t) => (
                  <label key={t.id} className={card}>
                    <input
                      type="radio"
                      name={`${themeGroup}-${mode}`}
                      value={t.id}
                      checked={appearance[field] === t.id}
                      onChange={() => set({ [field]: t.id })}
                      className="sr-only"
                    />
                    <span className={preview}>
                      <SchemePreview mode={mode} theme={t.id} />
                    </span>
                    {t.name}
                  </label>
                ))}
            </fieldset>
          </Section>
        );
      })}

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
        <Row title="Usage in the composer" description={usageDescriptions[composerUsage]}>
          <Segmented
            label="Usage in the composer"
            options={[
              { value: "ring", name: "Ring" },
              { value: "inline", name: "Inline" },
              { value: "off", name: "Off" },
            ]}
            value={composerUsage}
            onChange={(view) => setBehaviorPrefs({ composerUsage: view })}
          />
        </Row>
      </Section>

      <TypographySettings />
    </>
  );
}
