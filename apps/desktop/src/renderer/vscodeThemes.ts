import { strFromU8, unzipSync } from "fflate";

import { stored } from "./stored";

// VS Code color themes, added from Open VSX in Settings > Appearance. Each theme's VS Code colors
// and syntax colors become Parallax's tokens (`tokensOf`) when it's added, and its CSS
// (`themeCss`) paints them under a `theme-<id>` class on <html> (appearance.ts).

export type Mode = "light" | "dark";
export type Tokens = Record<string, string>;

/** One color theme, converted. */
interface AddedTheme {
  id: string;
  name: string;
  mode: Mode;
  tokens: Tokens;
  /** --added and --danger under Blue & orange change colors. */
  blueOrange: Tokens;
}

/** An Open VSX extension's color themes, as added. */
export interface AddedExtension {
  /** `namespace.name` on Open VSX. */
  id: string;
  name: string;
  /** Its Open VSX icon, as a data: URL, so it shows offline. */
  icon?: string;
  themes: AddedTheme[];
}

/** JSON with comments and trailing commas, as VS Code reads theme files. */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i === 0) break;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// Colors: #rgb, #rgba, #rrggbb, or #rrggbbaa, as [r, g, b] in 0..255 and an alpha in 0..1.
function parse(color: string): [number, number, number, number] {
  let h = color.replace("#", "").toLowerCase();
  if (h.length <= 4) h = h.replace(/./g, "$&$&");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
}
const isColor = (value: unknown): value is string =>
  typeof value === "string" && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);
const hex = (rgb: number[]) =>
  "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
/** `top` painted over the opaque `under`. */
function over(top: string, under: string) {
  const [r, g, b, a] = parse(top);
  const u = parse(under);
  return hex([r * a + u[0] * (1 - a), g * a + u[1] * (1 - a), b * a + u[2] * (1 - a)]);
}
/** `a` mixed into `b`, `t` of the way. */
const mix = (a: string, b: string, t: number) => {
  const [x, y] = [parse(a), parse(b)];
  return hex([0, 1, 2].map((i) => x[i]! * t + y[i]! * (1 - t)));
};
function luminance(color: string) {
  const [r, g, b] = parse(color).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
/** WCAG 2's contrast ratio of two opaque colors. */
export function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
/** `color`, moved toward white on dark fills or black on light ones until it keeps `ratio` on each. */
function readable(color: string, fills: string[], ratio: number, dark: boolean) {
  let c = color;
  for (let t = 0.04; fills.some((f) => contrast(c, f) < ratio) && t <= 1; t += 0.04)
    c = mix(dark ? "#ffffff" : "#000000", color, t);
  return c;
}

type TokenColor = { scope?: string | string[]; settings?: { foreground?: string } };
type VscodeTheme = { colors?: Record<string, unknown>; tokenColors?: TokenColor[] };

/** The foreground VS Code would give `scope`: the rule whose selector matches the most of it. */
function scopeColor(tokenColors: TokenColor[], scope: string) {
  let best: { length: number; color: string } | undefined;
  for (const rule of tokenColors) {
    const color = rule.settings?.foreground;
    if (!isColor(color)) continue;
    const selectors = typeof rule.scope === "string" ? rule.scope.split(",") : (rule.scope ?? []);
    for (const s of selectors.map((s) => s.trim()))
      if ((scope === s || scope.startsWith(`${s}.`)) && s.length >= (best?.length ?? 0))
        best = { length: s.length, color };
  }
  return best?.color;
}

// Blue for added, orange for removed, under Blue & orange change colors: index.css's.
const blueOrange = {
  light: { "--added": "#0969da", "--danger": "#bc4c00" },
  dark: { "--added": "#58a6ff", "--danger": "#f0883e" },
};

/**
 * Parallax's tokens from a VS Code theme, over `defaults`, Parallax's own for `mode`. Text keeps
 * 4.5:1 on the background and sidebar and Project colors 3:1 on the sidebar, moved toward white
 * or black where the theme's fall short.
 */
export function tokensOf(
  { colors = {}, tokenColors = [] }: VscodeTheme,
  mode: Mode,
  defaults: Tokens,
): { tokens: Tokens; blueOrange: Tokens } {
  const dark = mode === "dark";
  const first = (...keys: string[]) => keys.map((k) => colors[k]).find(isColor);
  const background = over(
    first("editor.background") ?? defaults["--background"]!,
    dark ? "#000000" : "#ffffff",
  );
  const opaque = (color: string | undefined, fallback: string) =>
    color ? over(color, background) : fallback;
  const sidebar = opaque(first("sideBar.background"), background);
  const fills = [background, sidebar];
  const text = (color: string | undefined, fallback: string) =>
    readable(opaque(color, fallback), fills, 4.5, dark);
  const foreground = text(first("editor.foreground", "foreground"), defaults["--foreground"]!);
  const description = first("descriptionForeground");
  const [r, g, b] = parse(foreground);
  const alpha = (percent: number) => `rgb(${r} ${g} ${b} / ${percent}%)`;
  const syntax = (scope: string, token: string) =>
    opaque(scopeColor(tokenColors, scope), defaults[token]!);
  const tokens: Tokens = {
    "--background": background,
    "--sidebar": sidebar,
    "--surface": opaque(first("editorWidget.background", "input.background"), background),
    "--foreground": foreground,
    "--muted-foreground": text(
      description && opaque(description, foreground) !== foreground ? description : undefined,
      mix(foreground, background, 0.75),
    ),
    "--faint-foreground": text(undefined, mix(foreground, background, 0.6)),
    "--border": alpha(dark ? 9 : 12),
    "--hover": alpha(5),
    "--selected": alpha(9),
    "--accent": text(
      first("textLink.foreground", "progressBar.background", "focusBorder"),
      defaults["--accent"]!,
    ),
    "--primary": foreground,
    "--primary-foreground": background,
    "--danger": text(first("errorForeground", "editorError.foreground"), defaults["--danger"]!),
    "--warning": readable(
      opaque(first("editorWarning.foreground", "terminal.ansiYellow"), defaults["--warning"]!),
      fills,
      3,
      dark,
    ),
    "--added": text(
      first("gitDecoration.addedResourceForeground", "terminal.ansiGreen"),
      defaults["--added"]!,
    ),
    "--code": opaque(first("textCodeBlock.background"), sidebar),
    "--syntax-keyword": syntax("keyword.control", "--syntax-keyword"),
    "--syntax-string": syntax("string.quoted.double", "--syntax-string"),
    "--syntax-number": syntax("constant.numeric", "--syntax-number"),
    "--syntax-title": syntax("entity.name.function", "--syntax-title"),
    "--syntax-type": syntax("entity.name.type", "--syntax-type"),
    "--syntax-comment": syntax("comment.line.double-slash", "--syntax-comment"),
  };
  for (const [name, value] of Object.entries(defaults))
    if (name.startsWith("--project-")) tokens[name] = readable(value, [sidebar], 3, dark);
  return {
    tokens,
    blueOrange: Object.fromEntries(
      Object.entries(blueOrange[mode]).map(([k, v]) => [k, readable(v, fills, 4.5, dark)]),
    ),
  };
}

/** `path`, relative to the file `from`, as a name inside the .vsix. */
const resolve = (path: string, from: string) =>
  decodeURIComponent(new URL(path, `file:///${from}`).pathname.slice(1));

const slug = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * The color themes in an extension's .vsix, converted over `defaults` (Parallax's tokens by
 * mode). Throws when it has none.
 */
export function themesFromVsix(
  vsix: Uint8Array,
  id: string,
  defaults: Record<Mode, Tokens>,
): AddedTheme[] {
  const files = unzipSync(vsix, {
    filter: (f) => f.name === "extension/package.json" || f.name.endsWith(".json"),
  });
  const read = (name: string) => {
    const file = files[name];
    if (!file) throw new Error(`The extension has no ${name.replace(/^extension\//, "")}.`);
    return parseJsonc(strFromU8(file)) as VscodeTheme & { include?: string };
  };
  // A theme file, with any `include` merged under it.
  const theme = (name: string): VscodeTheme => {
    const { include, ...own } = read(name);
    if (!include) return own;
    const base = theme(resolve(include, name));
    return {
      colors: { ...base.colors, ...own.colors },
      tokenColors: [...(base.tokenColors ?? []), ...(own.tokenColors ?? [])],
    };
  };
  const manifest = read("extension/package.json") as {
    contributes?: { themes?: { label?: string; uiTheme?: string; path?: string }[] };
  };
  const themes = (manifest.contributes?.themes ?? []).flatMap((t) => {
    if (!t.path) return [];
    const mode: Mode = t.uiTheme === "vs" || t.uiTheme === "hc-light" ? "light" : "dark";
    const name = t.label ?? t.path;
    const file = resolve(t.path, "extension/package.json");
    return [
      { id: slug(`${id}-${name}`), name, mode, ...tokensOf(theme(file), mode, defaults[mode]) },
    ];
  });
  if (!themes.length) throw new Error("This extension has no color themes.");
  return themes;
}

/** An extension Open VSX's search found. */
export interface FoundExtension {
  namespace: string;
  name: string;
  displayName?: string;
  description?: string;
  downloadCount?: number;
  files: { icon?: string };
}

const openVsx = "https://open-vsx.org/api";

/** Open VSX's Themes most downloaded for `query`, leaving out icon themes. */
export async function searchThemes(query: string, signal?: AbortSignal): Promise<FoundExtension[]> {
  const params = new URLSearchParams({
    query,
    category: "Themes",
    sortBy: "downloadCount",
    sortOrder: "desc",
    size: "24",
  });
  const response = await fetch(`${openVsx}/-/search?${params}`, { signal });
  if (!response.ok) throw new Error(`Open VSX answered ${response.status}.`);
  const { extensions = [] } = (await response.json()) as { extensions?: FoundExtension[] };
  return extensions.filter((e) => !/\bicons?\b/i.test(`${e.displayName ?? e.name}`));
}

/** The image at `url` as a data: URL, or undefined where it can't be read. */
async function dataUrl(url: string | undefined): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    const response = await fetch(url);
    if (!response.ok) return undefined;
    const blob = await response.blob();
    // Kept in localStorage with the themes: an outsized icon is left out rather than fill it.
    if (blob.size > 100_000) return undefined;
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

type ExtensionMeta = { displayName?: string; files: { download: string; icon?: string } };

async function extensionMeta(namespace: string, name: string): Promise<ExtensionMeta> {
  const meta = await fetch(`${openVsx}/${namespace}/${name}`);
  if (!meta.ok) throw new Error(`Open VSX answered ${meta.status}.`);
  return (await meta.json()) as ExtensionMeta;
}

/** Downloads an extension's latest version from Open VSX and converts its color themes. */
export async function fetchExtension(
  namespace: string,
  name: string,
  defaults: Record<Mode, Tokens>,
): Promise<AddedExtension> {
  const { displayName, files } = await extensionMeta(namespace, name);
  const vsix = await fetch(files.download);
  if (!vsix.ok) throw new Error(`Open VSX answered ${vsix.status}.`);
  const id = `${namespace}.${name}`;
  return {
    id,
    name: displayName ?? name,
    icon: await dataUrl(files.icon),
    themes: themesFromVsix(new Uint8Array(await vsix.arrayBuffer()), id, defaults),
  };
}

/** Fetches the icons of extensions added before they were kept. Each is tried once a session. */
const iconTried = new Set<string>();
export async function fillIcons() {
  for (const e of added.get().filter((e) => !e.icon && !iconTried.has(e.id))) {
    iconTried.add(e.id);
    const dot = e.id.indexOf(".");
    const [namespace, name] = [e.id.slice(0, dot), e.id.slice(dot + 1)];
    if (dot < 1 || !name) continue;
    const icon = await extensionMeta(namespace, name).then(
      (m) => dataUrl(m.files.icon),
      () => undefined,
    );
    if (icon) added.set(added.get().map((a) => (a.id === e.id ? { ...a, icon } : a)));
  }
}

const block = (selector: string, tokens: Tokens) =>
  `${selector} {\n${Object.entries(tokens)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n")}\n}`;

/** `tokens` for theme `id` in its `mode`, on <html> or in a preview. */
const themeBlock = (id: string, mode: Mode, tokens: Tokens) =>
  mode === "light"
    ? block(`:root:where(.theme-${id}:not(.dark)),\n.scheme-light.theme-${id}`, tokens)
    : block(`:root.dark:where(.theme-${id}),\n.scheme-dark.theme-${id}`, tokens);

/**
 * The CSS for added themes: each one mode's tokens over Parallax's, under `theme-<id>` on <html>
 * or beside .scheme-light or .scheme-dark in a preview. It goes after index.css, and :where keeps
 * the root selectors no more specific than Parallax's own, so .contrast-more, more specific,
 * still wins, and each theme's Blue & orange colors win over index.css's by coming later.
 */
export function themeCss(extensions: AddedExtension[]) {
  return extensions
    .flatMap((e) => e.themes)
    .flatMap(({ id, mode, tokens, blueOrange }) => [
      themeBlock(id, mode, tokens),
      mode === "light"
        ? block(`:root.diff-blue-orange:where(.theme-${id}:not(.dark))`, blueOrange)
        : block(`:root.dark.diff-blue-orange:where(.theme-${id})`, blueOrange),
    ])
    .join("\n");
}

/** The tokens Settings > Appearance > Colors changes, by their names there. */
export const colorTokens: Record<string, string> = {
  "--accent": "Accent",
  "--background": "Background",
  "--sidebar": "Sidebar",
  "--surface": "Cards and menus",
  "--code": "Code blocks",
  "--foreground": "Text",
  "--muted-foreground": "Secondary text",
  "--faint-foreground": "Faint text",
  "--added": "Added",
  "--danger": "Removed and errors",
  "--warning": "Warnings",
  "--syntax-keyword": "Keywords",
  "--syntax-string": "Strings",
  "--syntax-number": "Numbers",
  "--syntax-title": "Functions",
  "--syntax-type": "Types",
  "--syntax-comment": "Comments",
};
/** Tokens only Edit as JSON changes: they're usually see-through, which a color picker can't set. */
const jsonOnlyTokens = ["--border", "--hover", "--selected"];

/** The VS Code color keys Edit as JSON takes, and the token each sets: `tokensOf`'s sources. */
const vscodeKeys: Record<string, string> = {
  "editor.background": "--background",
  "sideBar.background": "--sidebar",
  "editorWidget.background": "--surface",
  "input.background": "--surface",
  foreground: "--foreground",
  "editor.foreground": "--foreground",
  descriptionForeground: "--muted-foreground",
  focusBorder: "--accent",
  "textLink.foreground": "--accent",
  "progressBar.background": "--accent",
  "button.background": "--accent",
  errorForeground: "--danger",
  "editorError.foreground": "--danger",
  "editorWarning.foreground": "--warning",
  "gitDecoration.addedResourceForeground": "--added",
  "textCodeBlock.background": "--code",
  "panel.border": "--border",
  "list.hoverBackground": "--hover",
  "list.activeSelectionBackground": "--selected",
};

/**
 * Whether `value` is a color CSS reads, kept to one plain value (a hex, a name, or one function
 * like rgb() or oklch()), so it can't end its declaration in the CSS it goes into.
 */
const isCssColor = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|[a-z-]+(\([^;{}()]*\))?)$/i.test(value.trim()) &&
  (globalThis.CSS?.supports("color", value) ?? true);

/**
 * Edit as JSON's object, as tokens: its keys are Parallax's token names, with or without `--`, or
 * VS Code's color keys, as in VS Code's `workbench.colorCustomizations`. `errors` names each key
 * or color it can't take.
 */
export function customColors(json: unknown): { tokens: Tokens; errors: string[] } {
  const tokens: Tokens = {};
  const errors: string[] = [];
  if (!json || typeof json !== "object" || Array.isArray(json))
    return { tokens, errors: ['Colors must be an object, like { "accent": "#ff4a1f" }.'] };
  for (const [key, value] of Object.entries(json)) {
    const name = key.startsWith("--") ? key : `--${key}`;
    const token =
      vscodeKeys[key] ?? (name in colorTokens || jsonOnlyTokens.includes(name) ? name : undefined);
    if (!token) errors.push(`${key} isn't a color Parallax has.`);
    else if (!isCssColor(value)) errors.push(`${key}: ${JSON.stringify(value)} isn't a color.`);
    else tokens[token] = value.trim();
  }
  return { tokens, errors };
}

/**
 * The CSS for changed colors (Appearance's `colors`), each theme's over its tokens, with
 * `themeCss`'s selectors so they show in previews too. They're !important, so they also win over
 * .contrast-more's and Blue & orange's more specific rules. `modes` has each theme's mode; colors
 * for a theme it lacks, or that aren't colors, are left out.
 */
export function customColorsCss(colors: Record<string, Tokens>, modes: Record<string, Mode>) {
  return Object.entries(colors)
    .filter(([id]) => /^[\w-]+$/.test(id) && modes[id])
    .map(([id, tokens]) =>
      themeBlock(
        id,
        modes[id]!,
        Object.fromEntries(
          Object.entries(tokens)
            .filter(([k, v]) => /^--[\w-]+$/.test(k) && isCssColor(v))
            .map(([k, v]) => [k, `${v} !important`]),
        ),
      ),
    )
    .join("\n");
}

const added = stored<AddedExtension[]>("parallax.themes", [], (raw, fallback) =>
  Array.isArray(raw) ? (raw as AddedExtension[]) : fallback,
);

/** The added extensions, kept current. */
export const useAddedThemes = added.use;

/** Adds `extension`, in place of an earlier copy of it. */
export const addExtension = (extension: AddedExtension) =>
  added.set([...added.get().filter((e) => e.id !== extension.id), extension]);

export const removeExtension = (id: string) => added.set(added.get().filter((e) => e.id !== id));

/** The tokens `names` in Parallax's own `mode`, as index.css's .scheme-light or .scheme-dark sets them. */
export function schemeTokens(mode: Mode, names: string[]): Tokens {
  const probe = document.createElement("span");
  probe.className = `scheme-${mode}`;
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const tokens = Object.fromEntries(
    names.map((name) => [name, style.getPropertyValue(name).trim()]),
  );
  probe.remove();
  return tokens;
}

/** The tokens `tokensOf` falls back on. */
const fallbackNames = [
  "--background",
  "--foreground",
  "--accent",
  "--danger",
  "--warning",
  "--added",
  "--syntax-keyword",
  "--syntax-string",
  "--syntax-number",
  "--syntax-title",
  "--syntax-type",
  "--syntax-comment",
  ...["red", "orange", "yellow", "green", "teal", "sky", "violet", "pink", "gray"].map(
    (c) => `--project-${c}`,
  ),
];

/** Parallax's own tokens for each mode, the ones `tokensOf` falls back on. */
export function parallaxTokens(): Record<Mode, Tokens> {
  return { light: schemeTokens("light", fallbackNames), dark: schemeTokens("dark", fallbackNames) };
}
