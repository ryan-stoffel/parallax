// Writes src/renderer/settings/licenses.generated.json, what Settings > About lists: every npm
// package bundled into the app, read from a build's source maps since all of them are dev
// dependencies; the crates in plxd, from `cargo tree`; and the sidecars' packages, from their
// lockfiles. Run `node scripts/licenses.mjs` in apps/desktop after dependencies change.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const output = path.join(desktop, "src/renderer/settings/licenses.generated.json");

const texts = [];
const textIndex = new Map();
/** The index of a license file's text, each distinct text kept once. */
function textOf(file) {
  const text = readFileSync(file, "utf8").trim();
  if (!textIndex.has(text)) {
    textIndex.set(text, texts.length);
    texts.push(text);
  }
  return textIndex.get(text);
}
/** The indexes of a package folder's license and notice files. */
const licenseFiles = (dir) =>
  readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|notice)/i.test(f) && statSync(path.join(dir, f)).isFile())
    .sort()
    .map((f) => textOf(path.join(dir, f)));

/** A repository field as a web link, or nothing. */
function webLink(repository) {
  const raw = typeof repository === "string" ? repository : repository?.url;
  if (!raw) return undefined;
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}`;
  return raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^github:/, "https://github.com/")
    .replace(/\.git$/, "");
}

const licenseOf = (manifest) =>
  typeof manifest.license === "string"
    ? manifest.license
    : (manifest.license?.type ??
      manifest.licenses?.map((l) => l.type ?? l).join(" OR ") ??
      "Unknown");

/** One entry for an installed npm package's folder. */
function npmEntry(dir, group) {
  const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  return {
    name: manifest.name,
    version: manifest.version,
    license: licenseOf(manifest),
    url: webLink(manifest.repository) ?? manifest.homepage,
    group,
    texts: licenseFiles(dir),
  };
}

/** The folders of the packages a build's source maps name. */
function bundled(folders) {
  const dirs = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (name.endsWith(".map")) {
        const { sources = [], sourceRoot = "" } = JSON.parse(readFileSync(file, "utf8"));
        for (const source of sources) {
          const absolute = path.resolve(dir, sourceRoot, source.replace(/^\/@fs/, ""));
          const match = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(absolute);
          if (match && existsSync(path.join(match[1], "package.json"))) dirs.add(match[1]);
        }
      }
    }
  };
  folders.forEach(walk);
  return [...dirs];
}

// Built with source maps beside the real output, which keeps its own settings.
const scratch = mkdtempSync(path.join(tmpdir(), "parallax-licenses-"));
const vp = path.join(desktop, "node_modules/.bin/vp");
execFileSync(vp, ["build", "--sourcemap", "--outDir", scratch, "--emptyOutDir"], {
  cwd: desktop,
  stdio: ["ignore", "ignore", "inherit"],
});
execFileSync(vp, ["pack"], { cwd: desktop, stdio: ["ignore", "ignore", "inherit"] });
const app = bundled([scratch, path.join(desktop, "dist/main"), path.join(desktop, "dist/preload")]);
// What the build doesn't inline: Electron itself, and the fonts' and icons' packages.
const manifest = JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8"));
for (const name of Object.keys(manifest.devDependencies))
  if (name === "electron" || name.startsWith("@fontsource") || name === "material-icon-theme")
    app.push(path.join(desktop, "node_modules", name));
const packages = [...new Set(app.map((dir) => realpathSync(dir)))].map((dir) =>
  npmEntry(dir, "App"),
);

// plxd's crates, on every platform it ships for.
const tree = execFileSync(
  "cargo",
  ["tree", "-p", "plxd", "-e", "normal", "--target", "all", "--prefix", "none", "--format", "{p}"],
  { cwd: root, encoding: "utf8" },
);
const crates = new Set(
  tree
    .split("\n")
    .map((line) => line.replace(" (*)", "").trim())
    .filter(Boolean),
);
const metadata = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--offline"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  }),
);
for (const crate of metadata.packages) {
  const dir = path.dirname(crate.manifest_path);
  // The repo's own crates are under LICENSE at its root.
  if (dir.startsWith(`${root}${path.sep}`)) continue;
  if (![...crates].some((c) => c.startsWith(`${crate.name} v${crate.version}`))) continue;
  packages.push({
    name: crate.name,
    version: crate.version,
    license: crate.license ?? "Unknown",
    url: webLink(crate.repository) ?? crate.homepage,
    group: "plxd",
    texts: licenseFiles(dir),
  });
}

// The sidecars plxd carries. Only their lockfiles are here, so they have no license text.
for (const sidecar of readdirSync(path.join(root, "sidecar"))) {
  const lock = JSON.parse(
    readFileSync(path.join(root, "sidecar", sidecar, "package-lock.json"), "utf8"),
  );
  for (const [where, entry] of Object.entries(lock.packages)) {
    if (!where || entry.dev) continue;
    packages.push({
      name: where.slice(where.lastIndexOf("node_modules/") + "node_modules/".length),
      version: entry.version,
      license: entry.license ?? "Unknown",
      url: undefined,
      group: "Sidecars",
      texts: [],
    });
  }
}

// One entry per name, version, and group, in a stable order.
const seen = new Set();
const unique = packages
  .filter((p) => {
    const key = `${p.group}/${p.name}@${p.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
writeFileSync(output, `${JSON.stringify({ packages: unique, texts })}\n`);
console.log(
  `${unique.length} packages, ${texts.length} license texts, to ${path.relative(desktop, output)}`,
);
