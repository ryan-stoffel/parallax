// Turns dist/ into one HTML file (dist/single.html) for sharing without a server:
// the script and stylesheet are inlined and the font files become data URIs.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dist = new URL("../dist/", import.meta.url).pathname;
const html = readFileSync(join(dist, "index.html"), "utf8");
const src = (re) => re.exec(html)?.[1];
const jsPath = src(/<script[^>]*src="\.\/([^"]+)"/);
const cssPath = src(/<link[^>]*rel="stylesheet"[^>]*href="\.\/([^"]+)"/);

let css = readFileSync(join(dist, cssPath), "utf8").replace(/url\(\.?\/?([^)]+\.woff2)\)/g, (_, file) => {
  const data = readFileSync(join(dist, "assets", file.replace(/^.*\//, ""))).toString("base64");
  return `url(data:font/woff2;base64,${data})`;
});
const js = readFileSync(join(dist, jsPath), "utf8").replace(/<\/script/gi, "<\\/script");
const title = src(/<title>([^<]*)<\/title>/);

writeFileSync(
  join(dist, "single.html"),
  `<title>${title}</title>\n<style>${css}</style>\n<div id="root"></div>\n<script type="module">${js}</script>\n`,
);
console.log("wrote dist/single.html");
