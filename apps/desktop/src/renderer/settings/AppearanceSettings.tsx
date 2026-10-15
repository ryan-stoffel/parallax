import { Moon, Plus, Sun, Trash2 } from "lucide-react";
import { useId, useState } from "react";

import type { ThemePreference } from "../../preload/bridge";
import { setAppearance, useAppearance, type Appearance } from "../appearance";
import { behaviorPrefs, setBehaviorPrefs, usageView } from "../prefs";
import { IconButton, Segmented } from "../ui";
import { removeExtension, useAddedThemes, type Mode } from "../vscodeThemes";
import { AddThemeDialog } from "./AddThemeDialog";
import { PageTitle, Row, Section, Switch } from "./parts";
import { TypographySettings } from "./TypographySettings";

type ColorTheme = { id: string; name: string; mode: Mode };

/** Parallax's own themes, in index.css. */
const parallaxThemes: ColorTheme[] = [
  { id: "parallax-light", name: "Parallax Light", mode: "light" },
  { id: "parallax-dark", name: "Parallax Dark", mode: "dark" },
];

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
function SchemePreview({ mode, theme }: { mode: Mode; theme: string }) {
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
function SplitPreview({ light, dark }: { light: string; dark: string }) {
  return (
    <>
      <SchemePreview mode="dark" theme={dark} />
      <span className="absolute inset-0 [clip-path:inset(0_50%_0_0)]">
        <SchemePreview mode="light" theme={light} />
      </span>
    </>
  );
}

/**
 * A set of themes: an orb for each, in its colors (.theme-orb in index.css), and its name. An orb
 * picks its theme for its mode, and the picked ones show a ring and a sun or moon.
 */
function ThemeCard({
  name,
  themes,
  picked,
  onPick,
  onRemove,
}: {
  name: string;
  themes: ColorTheme[];
  picked: Record<Mode, string>;
  onPick: (theme: ColorTheme) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <div className="flex flex-1 flex-wrap items-center justify-center gap-3 py-2">
        {themes.map((t) => {
          const on = picked[t.mode] === t.id;
          const Icon = t.mode === "light" ? Sun : Moon;
          return (
            <button
              key={t.id}
              type="button"
              title={t.name}
              aria-label={`${t.name}, for ${t.mode} mode`}
              aria-pressed={on}
              onClick={() => onPick(t)}
              className={`relative size-15 shrink-0 rounded-full p-1 focus-visible:outline-2 focus-visible:outline-ring ${on ? "ring-2 ring-accent" : ""}`}
            >
              <span
                className={`scheme-${t.mode} theme-${t.id} theme-orb block size-full rounded-full`}
              />
              {on && (
                <span className="absolute -right-0.5 -bottom-0.5 grid size-5 place-items-center rounded-full border border-border bg-surface text-foreground">
                  <Icon aria-hidden className="size-3" />
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex min-h-7 items-center justify-between gap-2">
        <span className="truncate text-[13px] font-medium">{name}</span>
        {onRemove && (
          <IconButton label={`Remove ${name}`} onClick={onRemove}>
            <Trash2 />
          </IconButton>
        )}
      </div>
    </div>
  );
}

const schemes: { value: ThemePreference; name: string }[] = [
  { value: "system", name: "System" },
  { value: "light", name: "Light" },
  { value: "dark", name: "Dark" },
];

/** A percent slider and its value, for the Window section. */
function Percent({
  label,
  min,
  value,
  disabled,
  onChange,
}: {
  label: string;
  min: number;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <span className={`flex items-center gap-3 ${disabled ? "opacity-50" : ""}`}>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={100}
        step={5}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-40"
      />
      <span className="w-9 text-right text-[12.5px] text-muted-foreground tabular-nums">
        {value}%
      </span>
    </span>
  );
}

const preview = "relative block aspect-[16/10] overflow-hidden rounded-lg border border-border";
const card =
  "flex cursor-pointer flex-col gap-2 rounded-xl border border-border bg-surface p-2 text-center text-[12.5px] text-muted-foreground hover:bg-hover has-checked:border-accent has-checked:text-foreground has-checked:outline-1 has-checked:outline-accent has-focus-visible:outline-2 has-focus-visible:outline-ring";

/**
 * Settings > Appearance: the color theme and scheme, and how the interface reads:
 * contrast, motion, the colors for added and removed, the window's blur and opacity, and
 * typography.
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
  const [adding, setAdding] = useState(false);
  const added = useAddedThemes();
  // The picked themes, or Parallax's where a picked one is no longer added.
  const addedIds = new Set(added.flatMap((e) => e.themes.map((t) => t.id)));
  const picked = {
    light: addedIds.has(appearance.lightTheme) ? appearance.lightTheme : "parallax-light",
    dark: addedIds.has(appearance.darkTheme) ? appearance.darkTheme : "parallax-dark",
  };
  const pick = (t: ColorTheme) =>
    set(t.mode === "light" ? { lightTheme: t.id } : { darkTheme: t.id });

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
                  <SplitPreview light={picked.light} dark={picked.dark} />
                ) : (
                  <SchemePreview mode={s.value} theme={picked[s.value]} />
                )}
              </span>
              {s.name}
            </label>
          ))}
        </fieldset>
      </Section>

      <Section
        title="Themes"
        action={
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12.5px] font-medium hover:bg-hover"
          >
            <Plus aria-hidden className="size-3.5" />
            Add theme
          </button>
        }
      >
        <div className="grid grid-cols-3 gap-3 p-3">
          <ThemeCard name="Parallax" themes={parallaxThemes} picked={picked} onPick={pick} />
          {added.map((e) => (
            <ThemeCard
              key={e.id}
              name={e.name}
              themes={e.themes}
              picked={picked}
              onPick={pick}
              onRemove={() => removeExtension(e.id)}
            />
          ))}
        </div>
      </Section>
      {adding && <AddThemeDialog onClose={() => setAdding(false)} />}

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

      {window.parallax.setWindowLook && (
        <Section title="Window">
          <Row
            title="Blur behind window"
            description="The desktop shows through the app's backgrounds, blurred."
          >
            <Switch
              label="Blur behind window"
              checked={appearance.blur}
              onChange={(blur) => set({ blur })}
            />
          </Row>
          <Row
            title="Background opacity"
            description="How much of the theme's background covers the blur. 0% is clear glass."
          >
            <Percent
              label="Background opacity"
              min={0}
              value={appearance.backgroundOpacity}
              disabled={!appearance.blur}
              onChange={(backgroundOpacity) => set({ backgroundOpacity })}
            />
          </Row>
          <Row title="Window opacity" description="The whole window, text included.">
            <Percent
              label="Window opacity"
              min={30}
              value={appearance.windowOpacity}
              onChange={(windowOpacity) => set({ windowOpacity })}
            />
          </Row>
        </Section>
      )}

      <TypographySettings />
    </>
  );
}
