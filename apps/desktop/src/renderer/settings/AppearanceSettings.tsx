import { t } from "i18next";
import { Plus, RotateCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import {
  needsTransparentWindow,
  type ThemePreference,
  type WindowMaterial,
} from "../../preload/bridge";
import { msg } from "../../i18n";
import { seesThrough, setAppearance, shownThemes, useAppearance } from "../appearance";
import { ParallaxMark } from "../logos";
import { chatPrefs, setChatPrefs, type ChatPrefs } from "../prefs";
import { navChoices } from "../SidebarNav";
import {
  archivePageSize,
  navDefaults,
  sidebarMode,
  sidebarNav,
  sidebarPrefs,
  type SidebarMode,
} from "../sidebarPrefs";
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

/** The window's backgrounds, named in the app's language. */
const materials = (): { value: WindowMaterial; name: string }[] => [
  { value: "opaque", name: t("Opaque") },
  { value: "clear", name: t("Clear", { context: "see-through" }) },
  { value: "blur", name: t("Blurred") },
];

/**
 * Settings > Appearance: the theme for each mode and the colors changed over it, the window's
 * background, text, chat, and the sidebar. Contrast, motion, and diff colors are Accessibility's.
 */
export function AppearanceSettings({
  theme,
  onThemeChange,
}: {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
}) {
  const appearance = useAppearance();
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
        label={mode === "light" ? t("Light theme") : t("Dark theme")}
        value={picked[mode]}
        onChange={(id) => slot(mode, id)}
        options={options}
        search={options.length > 8 ? t("Search themes") : undefined}
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
            {t("Add a theme from Open VSX…")}
          </button>
        )}
      />
    );
  };

  const through = seesThrough(appearance.windowMaterial);
  const canSet = window.parallax.setWindowLook !== undefined;

  return (
    <>
      <PageTitle title={t("Appearance")}>
        {t("Make Parallax yours: its themes and colors, the window, and its text.")}
      </PageTitle>

      <Section title={t("Theme")}>
        <div className="grid grid-cols-2 gap-3 border-b border-border p-4">
          {(["light", "dark"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-label={mode === "light" ? t("Use the light theme") : t("Use the dark theme")}
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
                <span className="font-medium">{mode === "light" ? t("Light") : t("Dark")}</span>
                <span className="truncate text-muted-foreground">{nameOf(mode)}</span>
              </span>
            </button>
          ))}
        </div>
        <Row
          title={t("Color scheme")}
          description={t("Which theme shows. System follows your OS.")}
        >
          <Segmented
            label={t("Color scheme")}
            options={[
              { value: "system", name: t("System") },
              { value: "light", name: t("Light") },
              { value: "dark", name: t("Dark") },
            ]}
            value={theme}
            onChange={onThemeChange}
          />
        </Row>
        <Row title={t("Light theme")} description={t("Shown in light mode.")}>
          {themePicker("light")}
        </Row>
        <Row title={t("Dark theme")} description={t("Shown in dark mode.")}>
          {themePicker("dark")}
        </Row>
        <div data-setting="installed-themes" className="px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <span className="block text-body font-medium">{t("Installed themes")}</span>
              <span className="block text-meta text-muted-foreground">
                {t("VS Code themes from Open VSX. Each one's variants join the menus above.")}
              </span>
            </div>
            <button
              type="button"
              className={`${quietButton} flex shrink-0 items-center gap-1.5 border border-border text-foreground`}
              onClick={() => setAdding(showing("light") ? "light" : "dark")}
            >
              <Plus aria-hidden className="size-3.5" />
              {t("Add theme")}
            </button>
          </div>
          {added.length > 0 && (
            <ul aria-label={t("Installed themes")} className="mt-3 flex flex-col gap-1">
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
                  <IconButton
                    label={t("Remove {{name}}", { name: e.name })}
                    onClick={() => removeExtension(e.id)}
                  >
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
        <Section title={t("Window")}>
          <Row
            title={t("Background")}
            description={
              !window.parallax.canBlur
                ? t("Clear lets the desktop show through the window.")
                : window.parallax.platform === "linux"
                  ? t(
                      "Clear lets the desktop show through the window. Blurred asks your compositor, such as Hyprland or KDE, to frost it.",
                    )
                  : t("Clear lets the desktop show through the window. Blurred frosts it.")
            }
          >
            <Segmented
              label={t("Window background")}
              options={materials().filter((m) => m.value !== "blur" || window.parallax.canBlur)}
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
                title={t("Restart to finish")}
                description={t("Your OS makes a window see-through only when it opens.")}
              >
                <button
                  type="button"
                  className={`${quietButton} flex items-center gap-1.5 border border-border text-foreground`}
                  onClick={() => window.parallax.relaunch?.()}
                >
                  <RotateCw aria-hidden className="size-3.5" />
                  {t("Restart Parallax")}
                </button>
              </Row>
            )}
          <Row
            title={t("Background opacity")}
            description={t("How much of the theme covers what shows through. Text stays solid.")}
          >
            <span className={`flex items-center gap-3 ${through ? "" : "opacity-50"}`}>
              <input
                type="range"
                aria-label={t("Background opacity")}
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

      <ChatSettings />

      <SidebarSettings />
    </>
  );
}

const toolCalls: { value: ChatPrefs["toolCalls"]; label: string }[] = [
  { value: "showAll", label: msg("Show all") },
  { value: "hideSuccessful", label: msg("Hide successful") },
  { value: "hideAll", label: msg("Hide all") },
  { value: "zen", label: msg("Zen") },
];

/**
 * Appearance's Chat (PLX-1519), as T3 Code's chat settings: whether the composer formats Markdown,
 * whether messages typeset math, and which tool calls a thread shows.
 */
function ChatSettings() {
  const prefs = chatPrefs.use();
  return (
    <Section title={t("Chat")}>
      <Row
        title={t("Rich text composer")}
        description={t("Format Markdown as you type. Off, the box shows it as typed.")}
      >
        <Switch
          label={t("Rich text composer")}
          checked={prefs.richComposer}
          onChange={(richComposer) => setChatPrefs({ richComposer })}
        />
      </Row>
      <Row
        title={t("Render math")}
        description={t("Typeset LaTeX, such as $x^2$, in messages. Off, it shows as its source.")}
      >
        <Switch
          label={t("Render math")}
          checked={prefs.math}
          onChange={(math) => setChatPrefs({ math })}
        />
      </Row>
      <Row
        title={t("Tool calls")}
        description={t(
          "The commands, edits, and searches a thread shows. Hide successful keeps the ones that failed. Zen shows only each turn's answer. Approvals, questions, and errors always show.",
        )}
      >
        <Picker
          field
          label={t("Tool calls")}
          value={prefs.toolCalls}
          onChange={(v) => setChatPrefs({ toolCalls: v as ChatPrefs["toolCalls"] })}
          options={toolCalls.map((o) => ({ ...o, label: t(o.label) }))}
          className="w-48"
          panelClassName="min-w-48"
        />
      </Row>
    </Section>
  );
}

const modes: { value: SidebarMode; name: string }[] = [
  { value: "inbox", name: msg("Inbox") },
  { value: "traditional", name: msg("Traditional") },
];

/**
 * Appearance's Sidebar (0094): which sidebar shows, where Traditional's pages show (0090), and
 * the Working and Archived drawers' behavior.
 */
function SidebarSettings() {
  const mode = sidebarMode.use();
  const nav = { ...navDefaults, ...sidebarNav.use() };
  const prefs = sidebarPrefs.use();
  return (
    <Section title={t("Sidebar")}>
      <Row
        title={t("Layout")}
        description={t(
          "Inbox lists your threads by activity, newest first. Traditional groups them in a folder per repo.",
        )}
      >
        <Segmented
          label={t("Sidebar layout")}
          options={modes.map((m) => ({ ...m, name: t(m.name) }))}
          value={mode}
          onChange={(next) => sidebarMode.set(next)}
        />
      </Row>
      {/* Traditional's head rows. They show in Inbox too, so search finds them, and apply on switching. */}
      {navChoices.map(({ id, label }) => (
        <Row
          key={id}
          title={t(label)}
          description={t("In Traditional's head. Off, it waits under More.")}
        >
          <Switch
            label={t("Show {{page}} in the sidebar", { page: t(label) })}
            checked={nav[id]}
            onChange={(show) => sidebarNav.set({ ...nav, [id]: show })}
          />
        </Row>
      ))}
      <Row
        title={t("Working section")}
        description={t(
          "While a thread is working, list it under Working, above Archived. Off keeps it in the list.",
        )}
      >
        <Switch
          label={t("Working section")}
          checked={prefs.workingSection}
          onChange={(workingSection) => sidebarPrefs.set({ ...sidebarPrefs.get(), workingSection })}
        />
      </Row>
      <Row
        title={t("Archive pages")}
        description={t(
          "Show {{count}} archived threads at a time, with Show more for the rest. Off lists them all.",
          { count: archivePageSize },
        )}
      >
        <Switch
          label={t("Archive pages")}
          checked={prefs.pageArchived}
          onChange={(pageArchived) => sidebarPrefs.set({ ...sidebarPrefs.get(), pageArchived })}
        />
      </Row>
    </Section>
  );
}
