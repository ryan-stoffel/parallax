// File icons from VS Code's Material Icon Theme (material-icon-theme, MIT), by a file's name or
// extension. Only the icons named here are bundled: the glob lists each one.
const icons = import.meta.glob<string>(
  "../../node_modules/material-icon-theme/icons/{audio,c,console,cpp,csharp,css,dart,database,docker,elixir,font,git,go,h,haskell,html,image,java,javascript,json,key,kotlin,license,lock,lua,makefile,markdown,nix,nodejs,pdf,php,pnpm,pnpm_light,python,react,react_ts,readme,ruby,rust,sass,scala,svelte,svg,swift,test-js,test-jsx,test-ts,toml,toml_light,tsconfig,typescript,typescript-def,video,vue,xml,yaml,zig,zip}.svg",
  { query: "?url", import: "default", eager: true },
);

/** Icon names by a whole file name. */
const byName: Record<string, string> = {
  "package.json": "nodejs",
  "pnpm-lock.yaml": "pnpm",
  "pnpm-workspace.yaml": "pnpm",
  "tsconfig.json": "tsconfig",
  dockerfile: "docker",
  makefile: "makefile",
  license: "license",
  ".gitignore": "git",
  ".gitattributes": "git",
};

/** Icon names by extension, the longer ones first so `.test.ts` wins over `.ts`. */
const byExtension: Record<string, string> = {
  "d.ts": "typescript-def",
  "test.ts": "test-ts",
  "test.tsx": "test-jsx",
  "test.js": "test-js",
  "test.jsx": "test-jsx",
  rs: "rust",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "react_ts",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "react",
  java: "java",
  kt: "kotlin",
  scala: "scala",
  html: "html",
  css: "css",
  scss: "sass",
  sass: "sass",
  json: "json",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  go: "go",
  rb: "ruby",
  php: "php",
  lua: "lua",
  swift: "swift",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
  hs: "haskell",
  zig: "zig",
  c: "c",
  h: "h",
  cpp: "cpp",
  cc: "cpp",
  hpp: "h",
  cs: "csharp",
  vue: "vue",
  svelte: "svelte",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  plist: "xml",
  sh: "console",
  bash: "console",
  zsh: "console",
  nix: "nix",
  lock: "lock",
  sql: "database",
  sqlite: "database",
  svg: "svg",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  ico: "image",
  mp4: "video",
  mov: "video",
  mp3: "audio",
  wav: "audio",
  woff: "font",
  woff2: "font",
  ttf: "font",
  pdf: "pdf",
  zip: "zip",
  gz: "zip",
  pem: "key",
};

/** Icons drawn too pale for the light theme, which have a light theme version. */
const withLight = new Set(["pnpm", "toml"]);

const url = (icon: string) => icons[`../../node_modules/material-icon-theme/icons/${icon}.svg`]!;

/** The name of the icon for the file at `path`, or undefined for a file it doesn't know. */
export function iconName(path: string): string | undefined {
  const name = path.split("/").pop()!.toLowerCase();
  const parts = name.split(".");
  // `README.md` and `README` both read as a readme.
  let icon = parts[0] === "readme" ? "readme" : byName[name];
  for (let i = 1; !icon && i < parts.length; i++) icon = byExtension[parts.slice(i).join(".")];
  return icon;
}

/**
 * The icon for the file at `path`, as URLs: `dark`'s for the dark theme, and `light`'s, when
 * there is one, for the light. Undefined for a file it doesn't know.
 */
export function fileIcon(path: string): { dark: string; light?: string } | undefined {
  const icon = iconName(path);
  if (!icon) return undefined;
  return { dark: url(icon), ...(withLight.has(icon) && { light: url(`${icon}_light`) }) };
}
