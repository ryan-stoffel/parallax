/**
 * Writes src/renderer/themes.css and src/renderer/themes.ts from VS Code color themes, as their
 * extensions publish them on Open VSX: `node scripts/themes.mjs`, after changing `sources`. Needs
 * `unzip`. Each theme's VS Code colors and syntax colors become Parallax's tokens (`tokensOf`),
 * and any text color that falls short of 4.5:1 on the theme's background or sidebar, or a Project
 * color short of 3:1 on its sidebar, moves toward white or black until it doesn't.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Each extension, pinned, and the labels of the themes taken from it. */
const sources = [
  {
    id: "GitHub/github-vscode-theme@6.3.5",
    themes: ["GitHub Light Default", "GitHub Dark Default", "GitHub Dark Dimmed"],
  },
  {
    id: "Catppuccin/catppuccin-vsc@3.19.0",
    themes: ["Catppuccin Latte", "Catppuccin Frappé", "Catppuccin Macchiato", "Catppuccin Mocha"],
  },
  { id: "zhuangtongfa/material-theme@3.20.3", themes: ["One Dark Pro"] },
  { id: "akamud/vscode-theme-onelight@2.3.0", themes: ["Atom One Light"] },
  { id: "dracula-theme/theme-dracula@2.25.1", themes: ["Dracula Theme"] },
  {
    id: "enkia/tokyo-night@1.1.2",
    themes: ["Tokyo Night Light", "Tokyo Night", "Tokyo Night Storm"],
  },
  { id: "arcticicestudio/nord-visual-studio-code@0.19.0", themes: ["Nord"] },
  { id: "mvllow/rose-pine@2.15.2", themes: ["Rosé Pine Dawn", "Rosé Pine", "Rosé Pine Moon"] },
];

const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.join(here, "../src/renderer");

/** JSON with comments and trailing commas, as VS Code reads theme files. */
function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// Colors: [r, g, b, a] with r, g, b in 0..255 and a in 0..1.
function parse(hex) {
  let h = hex.replace("#", "").toLowerCase();
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
}
const hex = ([r, g, b]) =>
  "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
/** `top` painted over the opaque `under`. */
const over = (top, under) => {
  const [r, g, b, a] = parse(top);
  const u = parse(under);
  return hex([r * a + u[0] * (1 - a), g * a + u[1] * (1 - a), b * a + u[2] * (1 - a)]);
};
const mix = (a, b, t) =>
  over(
    `${a}${Math.round(t * 255)
      .toString(16)
      .padStart(2, "0")}`,
    b,
  );
const luminance = (color) => {
  const [r, g, b] = parse(color).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** `color`, moved toward white on dark fills or black on light ones until it keeps `ratio` on each. */
function readable(color, fills, ratio, dark) {
  let c = color;
  for (let t = 0.04; fills.some((f) => contrast(c, f) < ratio) && t <= 1; t += 0.04)
    c = mix(dark ? "#ffffff" : "#000000", color, t);
  return c;
}

/** The theme file at `file` inside the unpacked extension, with any `include` merged under it. */
function readTheme(vsix, file) {
  const theme = parseJsonc(
    execFileSync("unzip", ["-p", vsix, `extension/${file}`], { encoding: "utf8" }),
  );
  if (!theme.include) return theme;
  const base = readTheme(vsix, path.posix.join(path.posix.dirname(file), theme.include));
  return {
    colors: { ...base.colors, ...theme.colors },
    tokenColors: [...(base.tokenColors ?? []), ...(theme.tokenColors ?? [])],
  };
}

/** The foreground VS Code would give `scope`: the rule whose selector matches the most of it. */
function scopeColor(tokenColors, scope) {
  let best;
  for (const rule of tokenColors) {
    const color = rule.settings?.foreground;
    if (!color) continue;
    const selectors = typeof rule.scope === "string" ? rule.scope.split(",") : (rule.scope ?? []);
    for (const s of selectors.map((s) => s.trim()))
      if ((scope === s || scope.startsWith(`${s}.`)) && s.length >= (best?.length ?? 0))
        best = { length: s.length, color };
  }
  return best?.color;
}

/** Parallax's own tokens for `mode`, from index.css, which a theme falls back on. */
function parallax(mode) {
  const css = readFileSync(path.join(renderer, "index.css"), "utf8");
  const block = (selector) => css.slice(css.indexOf(`${selector} {`)).split("}")[0];
  const read = (b) =>
    Object.fromEntries([...b.matchAll(/(--[\w-]+): (#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]));
  const light = read(block(":root,\n.scheme-light"));
  return mode === "light" ? light : { ...light, ...read(block(":root.dark,\n.scheme-dark")) };
}

/** Parallax's tokens from a VS Code theme's `colors` and `tokenColors`. */
function tokensOf({ colors: c = {}, tokenColors = [] }, mode) {
  const dark = mode === "dark";
  const defaults = parallax(mode);
  const first = (...keys) => keys.map((k) => c[k]).find(Boolean);
  const background = over(first("editor.background"), dark ? "#000000" : "#ffffff");
  const opaque = (color, fallback) => (color ? over(color, background) : fallback);
  const sidebar = opaque(first("sideBar.background"), background);
  const fills = [background, sidebar];
  const foreground = readable(
    opaque(first("editor.foreground", "foreground"), defaults["--foreground"]),
    fills,
    4.5,
    dark,
  );
  const text = (color, fallback) => readable(opaque(color, fallback), fills, 4.5, dark);
  const description = first("descriptionForeground");
  const [r, g, b] = parse(foreground);
  const alpha = (percent) => `rgb(${r} ${g} ${b} / ${percent}%)`;
  const syntax = (scope, token) => {
    const color = scopeColor(tokenColors, scope);
    return color ? opaque(color) : defaults[token];
  };
  const tokens = {
    "--background": background,
    "--sidebar": sidebar,
    "--surface": opaque(first("editorWidget.background", "input.background"), background),
    "--foreground": foreground,
    "--muted-foreground": text(
      description && description.toLowerCase() !== foreground ? description : undefined,
      mix(foreground, background, 0.75),
    ),
    "--faint-foreground": text(undefined, mix(foreground, background, 0.6)),
    "--border": alpha(dark ? 9 : 12),
    "--hover": alpha(dark ? 5 : 5),
    "--selected": alpha(dark ? 9 : 9),
    "--accent": text(
      first("textLink.foreground", "progressBar.background", "focusBorder"),
      defaults["--accent"],
    ),
    "--primary": foreground,
    "--primary-foreground": background,
    "--danger": text(first("errorForeground", "editorError.foreground"), defaults["--danger"]),
    "--warning": readable(
      opaque(first("editorWarning.foreground", "terminal.ansiYellow"), defaults["--warning"]),
      fills,
      3,
      dark,
    ),
    "--added": text(
      first("gitDecoration.addedResourceForeground", "terminal.ansiGreen"),
      defaults["--added"],
    ),
    "--code": opaque(first("textCodeBlock.background"), sidebar),
    "--syntax-keyword": syntax("keyword.control", "--syntax-keyword"),
    "--syntax-string": syntax("string.quoted.double", "--syntax-string"),
    "--syntax-number": syntax("constant.numeric", "--syntax-number"),
    "--syntax-title": syntax("entity.name.function", "--syntax-title"),
    "--syntax-type": syntax("entity.name.type", "--syntax-type"),
    "--syntax-comment": syntax("comment.line.double-slash", "--syntax-comment"),
  };
  // Parallax's Project colors, wherever the theme's sidebar needs them stronger.
  for (const [name, value] of Object.entries(defaults))
    if (name.startsWith("--project-")) {
      const kept = readable(value, [sidebar], 3, dark);
      if (kept !== value) tokens[name] = kept;
    }
  return tokens;
}

const slug = (label) =>
  label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ theme$/, "")
    .replace(/[^a-z0-9]+/g, "-");

const dir = mkdtempSync(path.join(tmpdir(), "parallax-themes-"));
const themes = [];
for (const source of sources) {
  const [extension, version] = source.id.split("@");
  const [namespace, name] = extension.split("/");
  const vsix = path.join(dir, `${namespace}.${name}.vsix`);
  const url = `https://open-vsx.org/api/${namespace}/${name}/${version}/file/${namespace}.${name}-${version}.vsix`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  writeFileSync(vsix, Buffer.from(await response.arrayBuffer()));
  const manifest = JSON.parse(
    execFileSync("unzip", ["-p", vsix, "extension/package.json"], { encoding: "utf8" }),
  );
  for (const label of source.themes) {
    const entry = manifest.contributes.themes.find((t) => t.label === label);
    if (!entry) throw new Error(`${source.id} has no theme ${label}`);
    const mode = entry.uiTheme === "vs" ? "light" : "dark";
    const theme = readTheme(vsix, path.posix.normalize(entry.path));
    const name = label.replace(/ Theme$/, "");
    themes.push({ id: slug(label), name, mode, source: source.id, tokens: tokensOf(theme, mode) });
  }
}

const header = `Generated by scripts/themes.mjs from these VS Code themes, each MIT-licensed by its
   authors on Open VSX. Don't edit by hand.`;
const css = [
  `/* ${header}\n\n   Each is one mode's tokens over Parallax's (index.css): a \`theme-<id>\` class on <html>, or
   beside .scheme-light or .scheme-dark in a preview. :where keeps the root selectors as specific
   as Parallax's own, so .contrast-more and .diff-blue-orange, later in index.css, still win. */`,
  ...themes.map(({ id, name, mode, source, tokens }) => {
    const root =
      mode === "light" ? `:root:where(.theme-${id}:not(.dark))` : `:root.dark:where(.theme-${id})`;
    const body = Object.entries(tokens)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join("\n");
    return `/* ${name}, ${source}. */\n${root},\n.scheme-${mode}.theme-${id} {\n${body}\n}`;
  }),
].join("\n");
writeFileSync(path.join(renderer, "themes.css"), `${css}\n`);

const ts = `// ${header.replace("\n  ", "\n//")}

/** The VS Code themes Appearance offers beside Parallax's, by mode; themes.css has their tokens. */
export const vscodeThemes = [
${themes.map(({ id, name, mode }) => `  { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, mode: "${mode}" },`).join("\n")}
] as const;
`;
writeFileSync(path.join(renderer, "themes.ts"), ts);
console.log(themes.map((t) => `${t.mode}\t${t.id}\t${t.tokens["--accent"]}`).join("\n"));
