import { Plus, RotateCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import {
  needsTransparentWindow,
  type ThemePreference,
  type WindowMaterial,
} from "../../preload/bridge";
import { seesThrough, setAppearance, shownThemes, useAppearance } from "../appearance";
import { ParallaxMark } from "../logos";
import { navChoices } from "../SidebarNav";
import { navDefaults, sidebarNav } from "../sidebarPrefs";
import { IconButton, Picker, Segmented, menuItem, type PickerOption } from "../ui";
import {
  fillIcons,
  removeExtension,
  useAddedThemes,
  type AddedExtension,
  type Mode,
} from "../vscodeThemes";
import { AddThemeDialog } from "./AddThemeDialog";
import { ColorSettings } from "./ColorSettings";
import { PageTitle, Row, Section, Switch, quietButton } from "./parts";
import { TypographySettings } from "./TypographySettings";

type ColorTheme = { id: string; name: string; mode: Mode };

/** Parallax's own themes, in index.css. Their menus call each just Parallax. */
const parallaxThemes: ColorTheme[] = [
  { id: "parallax-light", name: "Parallax", mode: "light" },
  { id: "parallax-dark", name: "Parallax", mode: "dark" },
];

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
      <span className="flex w-1/5 flex-col gap-1.5 border-r border-border bg-sidebar p-2">
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

/** A theme's icon in menus: Parallax's mark, its extension's Open VSX icon, or an orb in its colors. */
function ThemeIcon({ theme, extension }: { theme: ColorTheme; extension?: AddedExtension }) {
  if (!extension) return <ParallaxMark className="size-4" />;
  if (extension.icon) return <img src={extension.icon} alt="" className="size-4 rounded-sm" />;
  return (
    <span
      className={`scheme-${theme.mode} theme-${theme.id} theme-orb block size-4 rounded-full`}
    />
  );
}

const materials: { value: WindowMaterial; name: string }[] = [
  { value: "opaque", name: "Opaque" },
  { value: "clear", name: "Clear" },
  { value: "blur", name: "Blurred" },
];

/**
 * Settings > Appearance: the theme for each mode and the colors changed over it, the window's
 * background, text, and how the interface reads.
 */
export function AppearanceSettings({
  theme,
  onThemeChange,
}: {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
}) {
  const appearance = useAppearance();
  const nav = { ...navDefaults, ...sidebarNav.use() };
  // The mode whose menu opened Add theme, which gets the added theme.
  const [adding, setAdding] = useState<Mode>();
  const added = useAddedThemes();
  useEffect(() => void fillIcons(), []);
  const picked = shownThemes(appearance, added);
  const slot = (mode: Mode, id: string) =>
    setAppearance(mode === "light" ? { lightTheme: id } : { darkTheme: id });
  // The mode showing now, ringed in the previews.
  const showing = (mode: Mode) =>
    theme === mode ||
    (theme === "system" &&
      matchMedia("(prefers-color-scheme: dark)").matches === (mode === "dark"));

  const themes = (mode: Mode) => [
    ...parallaxThemes
      .filter((t) => t.mode === mode)
      .map((t) => ({ theme: t, extension: undefined as AddedExtension | undefined })),
    ...added.flatMap((e) =>
      e.themes.filter((t) => t.mode === mode).map((t) => ({ theme: t, extension: e })),
    ),
  ];
  const nameOf = (mode: Mode) => themes(mode).find((t) => t.theme.id === picked[mode])?.theme.name;
  const themeOptions = (mode: Mode): PickerOption[] =>
    themes(mode).map(({ theme: t, extension: e }) => ({
      value: t.id,
      label: t.name,
      group: e?.name,
      icon: <ThemeIcon theme={t} extension={e} />,
    }));

  const themePicker = (mode: Mode) => {
    const options = themeOptions(mode);
    return (
      <Picker
        field
        label={mode === "light" ? "Light theme" : "Dark theme"}
        value={picked[mode]}
        onChange={(id) => slot(mode, id)}
        options={options}
        search={options.length > 8 ? "Search themes" : undefined}
        align="end"
        className="w-64"
        panelClassName="w-72"
        footer={(close) => (
          <button
            type="button"
            className={menuItem}
            onClick={() => {
              close();
              setAdding(mode);
            }}
          >
            <Plus aria-hidden />
            Add a theme from Open VSX…
          </button>
        )}
      />
    );
  };

  const through = seesThrough(appearance.windowMaterial);
  const canSet = window.parallax.setWindowLook !== undefined;

  return (
    <>
      <PageTitle title="Appearance">
        Make Parallax yours: its themes and colors, the window, and its text.
      </PageTitle>

      <Section title="Theme">
        <div className="grid grid-cols-2 gap-3 border-b border-border p-4">
          {(["light", "dark"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-label={`Use the ${mode} theme`}
              aria-pressed={theme === mode}
              onClick={() => onThemeChange(mode)}
              className="group flex flex-col gap-2 text-left"
            >
              <span
                className={`relative block aspect-[16/7] overflow-hidden rounded-lg border transition-shadow ${showing(mode) ? "border-accent ring-2 ring-accent/40" : "border-border group-hover:border-faint-foreground/60"}`}
              >
                <SchemePreview mode={mode} theme={picked[mode]} />
              </span>
              <span className="flex items-baseline gap-1.5 text-body">
                <span className="font-medium capitalize">{mode}</span>
                <span className="truncate text-muted-foreground">{nameOf(mode)}</span>
              </span>
            </button>
          ))}
        </div>
        <Row title="Color scheme" description="Which theme shows. System follows your OS.">
          <Segmented
            label="Color scheme"
            options={[
              { value: "system", name: "System" },
              { value: "light", name: "Light" },
              { value: "dark", name: "Dark" },
            ]}
            value={theme}
            onChange={onThemeChange}
          />
        </Row>
        <Row title="Light theme" description="Shown in light mode.">
          {themePicker("light")}
        </Row>
        <Row title="Dark theme" description="Shown in dark mode.">
          {themePicker("dark")}
        </Row>
        <div data-setting="installed-themes" className="px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <span className="block text-body font-medium">Installed themes</span>
              <span className="block text-meta text-muted-foreground">
                VS Code themes from Open VSX. Each one&apos;s variants join the menus above.
              </span>
            </div>
            <button
              type="button"
              className={`${quietButton} flex shrink-0 items-center gap-1.5 border border-border text-foreground`}
              onClick={() => setAdding(showing("light") ? "light" : "dark")}
            >
              <Plus aria-hidden className="size-3.5" />
              Add theme
            </button>
          </div>
          {added.length > 0 && (
            <ul aria-label="Installed themes" className="mt-3 flex flex-col gap-1">
              {added.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2"
                >
                  {e.icon ? (
                    <img src={e.icon} alt="" className="size-6 rounded-md" />
                  ) : (
                    <span
                      className={`scheme-${e.themes[0]!.mode} theme-${e.themes[0]!.id} theme-orb block size-6 rounded-full`}
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body">{e.name}</span>
                    <span className="block truncate text-meta text-muted-foreground">
                      {e.themes.map((t) => t.name).join(", ")}
                    </span>
                  </span>
                  <IconButton label={`Remove ${e.name}`} onClick={() => removeExtension(e.id)}>
                    <Trash2 />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>
      {adding && (
        <AddThemeDialog
          onAdded={(e) => {
            const first = e.themes.find((t) => t.mode === adding) ?? e.themes[0]!;
            slot(first.mode, first.id);
          }}
          onClose={() => setAdding(undefined)}
        />
      )}

      <ColorSettings
        themes={[...parallaxThemes, ...added.flatMap((e) => e.themes)]}
        shown={picked}
        colors={appearance.colors}
        onChange={(colors) => setAppearance({ colors })}
      />

      {canSet && (
        <Section title="Window">
          <Row
            title="Background"
            description={
              !window.parallax.canBlur
                ? "Clear lets the desktop show through the window."
                : window.parallax.platform === "linux"
                  ? "Clear lets the desktop show through the window. Blurred asks your compositor, such as Hyprland or KDE, to frost it."
                  : "Clear lets the desktop show through the window. Blurred frosts it."
            }
          >
            <Segmented
              label="Window background"
              options={materials.filter((m) => m.value !== "blur" || window.parallax.canBlur)}
              value={
                appearance.windowMaterial === "blur" && !window.parallax.canBlur
                  ? "opaque"
                  : appearance.windowMaterial
              }
              onChange={(windowMaterial) => setAppearance({ windowMaterial })}
            />
          </Row>
          {needsTransparentWindow(appearance.windowMaterial, window.parallax.platform) &&
            !window.parallax.transparent && (
              <Row
                title="Restart to finish"
                description="Your OS makes a window see-through only when it opens."
              >
                <button
                  type="button"
                  className={`${quietButton} flex items-center gap-1.5 border border-border text-foreground`}
                  onClick={() => window.parallax.relaunch?.()}
                >
                  <RotateCw aria-hidden className="size-3.5" />
                  Restart Parallax
                </button>
              </Row>
            )}
          <Row
            title="Background opacity"
            description="How much of the theme covers what shows through. Text stays solid."
          >
            <span className={`flex items-center gap-3 ${through ? "" : "opacity-50"}`}>
              <input
                type="range"
                aria-label="Background opacity"
                min={0}
                max={100}
                step={5}
                value={appearance.backgroundOpacity}
                disabled={!through}
                onChange={(e) => setAppearance({ backgroundOpacity: Number(e.target.value) })}
                className="w-40 accent-accent"
              />
              <span className="w-9 text-right text-body text-muted-foreground tabular-nums">
                {appearance.backgroundOpacity}%
              </span>
            </span>
          </Row>
        </Section>
      )}

      <TypographySettings />

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
            onChange={(contrast) => setAppearance({ contrast })}
          />
        </Row>
        <Row
          title="Reduce motion"
          description="Stops animations. Also on whenever your OS asks for less motion."
        >
          <Switch
            label="Reduce motion"
            checked={appearance.motion === "reduce"}
            onChange={(on) => setAppearance({ motion: on ? "reduce" : "system" })}
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
            onChange={(diffColors) => setAppearance({ diffColors })}
          />
        </Row>
      </Section>

      <Section title="Sidebar">
        {navChoices.map(({ id, label }) => (
          <Row
            key={id}
            title={label}
            description="In the sidebar's head. Off, it waits under More."
          >
            <Switch
              label={`Show ${label} in the sidebar`}
              checked={nav[id]}
              onChange={(on) => sidebarNav.set({ ...nav, [id]: on })}
            />
          </Row>
        ))}
      </Section>
    </>
  );
}
