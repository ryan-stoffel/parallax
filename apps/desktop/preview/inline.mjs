// Makes dist/single.html from the preview's build: its title, its one stylesheet with the fonts
// already inlined as data: URLs, the root element, and its one module script, all in one file
// with no <html>, <head>, or <body>, for hosts that wrap a fragment in a document of their own.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "dist");
const html = readFileSync(join(dist, "index.html"), "utf8");

const assets = (pattern) => [...html.matchAll(pattern)].map((m) => m[1]);
const styles = assets(/<link[^>]+rel="stylesheet"[^>]+href="\.?\/?([^"]+)"/g);
const scripts = assets(/<script[^>]+type="module"[^>]+src="\.?\/?([^"]+)"/g);
if (scripts.length !== 1) throw new Error(`expected one module script, found ${scripts.length}`);

const read = (path) => readFileSync(join(dist, path), "utf8");
const css = styles.map(read).join("\n");
// Data URLs left as relative paths would 404 from a fragment; the build inlines every asset.
const left = css.match(/url\((?!["']?data:)[^)]*\)/g);
if (left) throw new Error(`assets weren't inlined: ${left.join(", ")}`);

const script = read(scripts[0]).replace(/<\/script/gi, "<\\/script");
const style = css.replace(/<\/style/gi, "<\\/style");

const single = [
  "<title>Parallax Preview</title>",
  `<style>${style}</style>`,
  '<div id="root"></div>',
  `<script type="module">${script}</script>`,
  "",
].join("\n");
writeFileSync(join(dist, "single.html"), single);
console.log(`wrote dist/single.html (${(single.length / 1024).toFixed(0)} KB)`);
