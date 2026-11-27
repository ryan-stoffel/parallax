// What the site promises of its own pages: no script, nothing loaded from another origin, and
// every local link and file resolves. `node --test`, with no dependencies.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const pub = join(dirname(dirname(fileURLToPath(import.meta.url))), "public");
const pages = readdirSync(pub).filter((name) => name.endsWith(".html"));
const read = (name) => readFileSync(join(pub, name), "utf8");

/** Whether the site serves `path`, as `html_handling` resolves it: `/privacy` is `privacy.html`. */
const served = (path) => path === "/" || existsSync(join(pub, path)) || existsSync(join(pub, `${path}.html`));

test("the store pages exist", () => {
  for (const name of ["privacy.html", "support.html", "delete-account.html", "404.html", "index.html"])
    assert.ok(pages.includes(name), name);
});

test("no page runs script or styles itself inline, which the CSP would block", () => {
  for (const name of pages) {
    const html = read(name);
    assert.doesNotMatch(html, /<script|<style|\sstyle=|\son[a-z]+=|javascript:/i, name);
  }
});

test("pages load only their own files, and every local link resolves", () => {
  for (const name of pages) {
    const html = read(name);
    for (const [tag, element] of html.matchAll(/<(\w+)\b[^>]*>/g)) {
      for (const [, url] of tag.matchAll(/\s(?:src|srcset|href)="([^"]*)"/g)) {
        // A link may leave the site. Anything the page loads may not.
        if (element === "a" && (/^https:\/\//.test(url) || url.startsWith("#"))) continue;
        assert.ok(url.startsWith("/") && !url.startsWith("//"), `${name} loads ${url} from another origin`);
        assert.ok(served(url.split("#")[0]), `${name} points at ${url}, which the site doesn't serve`);
      }
    }
  }
});

test("the headers apply to every path and allow no other origin", () => {
  const headers = read("_headers");
  assert.match(headers, /^\/\*$/m);
  const csp = headers.match(/Content-Security-Policy: (.*)/)?.[1] ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /https?:|\*|unsafe/);
});
