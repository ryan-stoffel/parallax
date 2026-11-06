// Rehype plugins for GithubMarkdown: GitHub's inline HTML, kept to what GitHub itself allows;
// GitHub's alerts; and links for `#12`, `owner/repo#12`, `@user`, and commit hashes.

/** The few hast nodes these plugins read and write. */
type Text = { type: "text"; value: string };
type Raw = { type: "raw"; value: string };
export type HastElement = {
  type: "element";
  tagName: string;
  properties: Record<string, unknown>;
  children: Node[];
};
type Node = Text | Raw | HastElement | { type: "comment" | "doctype"; value?: string };
type Parent = { children: Node[] };

// Tags GitHub keeps in a pull request's Markdown (its html-pipeline sanitizer), and `section`,
// which remark-gfm's footnotes come in. Any other tag is dropped and its text kept, except these,
// which go with what's in them.
const TAGS = new Set(
  (
    "a abbr b bdo blockquote br caption cite code dd del details dfn div dl dt em figcaption " +
    "figure h1 h2 h3 h4 h5 h6 hr i img input ins kbd li mark ol p picture pre q rp rt ruby s " +
    "samp section small source span strike strong sub summary sup table tbody td tfoot th thead " +
    "time tr tt ul var wbr"
  ).split(" "),
);
const DROP = new Set(
  "script style iframe object embed form textarea select button template noscript svg math title meta link".split(
    " ",
  ),
);
const VOID = new Set(["br", "hr", "img", "input", "source", "wbr"]);
const ATTRS = new Set(
  (
    "align alt title width height id class dir lang colspan rowspan abbr valign " +
    "data-footnote-ref data-footnotes data-footnote-backref aria-describedby aria-label"
  ).split(" "),
);
const TAG_ATTRS: Record<string, string[]> = {
  a: ["href"],
  img: ["src"],
  source: ["srcset", "media"],
  details: ["open"],
  ol: ["start", "type"],
  input: ["type", "checked", "disabled"],
};
const BOOLEAN = new Set(["open", "checked", "disabled", "data-footnote-ref", "data-footnotes"]);
// Classes remark-gfm, rehype-highlight, and footnotes set, which stay; any other is dropped.
const CLASS = /^(language-[\w+-]+|sr-only|footnotes|task-list-item|contains-task-list)$/;
const https = (url: string) => /^https:\/\/[^/]/i.test(url.trim());

/** `value` safe inside an HTML attribute or text. */
const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A hast property's attribute name: `className` → class, `dataFootnoteRef` → data-footnote-ref. */
const attribute = (key: string) =>
  key === "className"
    ? "class"
    : key === "htmlFor"
      ? "for"
      : /^(data|aria)[A-Z]/.test(key)
        ? key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
        : key.toLowerCase();

/** Nodes as HTML, raw HTML as written, so the browser can parse the two together. */
function toHtml(nodes: readonly Node[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text") return escape(node.value);
      if (node.type === "raw") return node.value;
      if (node.type !== "element") return "";
      const attrs = Object.entries(node.properties)
        .filter(([, v]) => v !== false && v !== undefined && v !== null)
        .map(([k, v]) =>
          v === true
            ? ` ${attribute(k)}`
            : ` ${attribute(k)}="${escape(Array.isArray(v) ? v.join(" ") : String(v))}"`,
        )
        .join("");
      const open = `<${node.tagName}${attrs}>`;
      return VOID.has(node.tagName) ? open : `${open}${toHtml(node.children)}</${node.tagName}>`;
    })
    .join("");
}

/** A parsed DOM node as hast, kept to GitHub's allowlist: tags, attributes, and https sources. */
function fromDom(node: ChildNode): Node[] {
  if (node.nodeType === 3) return [{ type: "text", value: node.textContent ?? "" }];
  if (node.nodeType !== 1) return [];
  const el = node as Element;
  const tag = el.localName;
  const children = [...el.childNodes].flatMap(fromDom);
  if (DROP.has(tag)) return [];
  if (!TAGS.has(tag)) return children;
  if (tag === "input" && el.getAttribute("type") !== "checkbox") return [];
  const properties: Record<string, unknown> = {};
  for (const { name, value } of el.attributes) {
    if (!ATTRS.has(name) && !TAG_ATTRS[tag]?.includes(name)) continue;
    if (name === "class") {
      const kept = value.split(/\s+/).filter((c) => CLASS.test(c));
      if (kept.length) properties["className"] = kept;
    } else if (name === "href") {
      if (/^(https?:|mailto:|#)/i.test(value.trim())) properties["href"] = value;
    } else if (name === "src") {
      if (https(value)) properties["src"] = value;
    } else if (name === "srcset") {
      const urls = value.split(",").map((s) => s.trim().split(/\s+/)[0] ?? "");
      if (urls.every(https)) properties["srcset"] = value;
    } else if (name === "id") {
      // A page's own ids can't be taken, as GitHub prefixes them.
      properties["id"] = value.startsWith("user-content-") ? value : `user-content-${value}`;
    } else {
      // hast names data and aria attributes in camel case, as remark-gfm's own nodes have them.
      const key = /^(data|aria)-/.test(name)
        ? name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
        : name;
      properties[key] = BOOLEAN.has(name) ? true : value;
    }
  }
  if (tag === "input") properties["disabled"] = true;
  return [{ type: "element", tagName: tag, properties, children }];
}

const hasRaw = (nodes: readonly Node[]): boolean =>
  nodes.some((n) => n.type === "raw" || (n.type === "element" && hasRaw(n.children)));

/**
 * GitHub's HTML in Markdown (`<details>`, `<p align="center">`, `<picture>`, `<img width>`,
 * `<sub>`, `<kbd>`, `<br>`): a tree with raw HTML is written out and parsed again by the browser,
 * so a `<details>` wraps the Markdown between its tags, then kept to GitHub's allowlist. An inert
 * `<template>` parses it, so nothing in it loads or runs. A tree without HTML stays as it is.
 */
export const rehypeGithubHtml = () => (tree: Parent) => {
  if (!hasRaw(tree.children)) return;
  const template = document.createElement("template");
  template.innerHTML = toHtml(tree.children);
  tree.children = [...template.content.childNodes].flatMap(fromDom);
};

/** GitHub's alert kinds, as `> [!NOTE]` starts one. */
export const ALERTS = ["note", "tip", "important", "warning", "caution"] as const;
export type AlertKind = (typeof ALERTS)[number];

/**
 * A blockquote starting `[!NOTE]` (or TIP, IMPORTANT, WARNING, CAUTION) as GitHub's alert: the
 * marker comes out and `data-alert` says its kind.
 */
export const rehypeGithubAlerts = () => (tree: Parent) => {
  const visit = (nodes: Node[]) => {
    for (const node of nodes) {
      if (node.type !== "element") continue;
      if (node.tagName === "blockquote") {
        const p = node.children.find((c): c is HastElement => c.type === "element");
        const first = p?.tagName === "p" ? p.children[0] : undefined;
        const m = first?.type === "text" ? /^\s*\[!(\w+)\][ \t]*\n?/.exec(first.value) : undefined;
        const kind = m?.[1]!.toLowerCase();
        if (first?.type === "text" && m && ALERTS.includes(kind as AlertKind)) {
          first.value = first.value.slice(m[0].length);
          node.properties["dataAlert"] = kind;
        }
      }
      visit(node.children);
    }
  };
  visit(tree.children);
};

/** A piece of text: plain, or a reference GitHub links. */
export type RefPart =
  | { text: string }
  | { text: string; href: string; kind: "issue" | "user" | "commit" };

// `owner/repo#12`, `#12`, `@user`, or a 7 to 40 character hash, each after a space, a bracket, or
// the text's start, and not inside a word.
const REF =
  /(^|[^\w/.@#&-])(?:([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)#(\d+)|#(\d+)|@([A-Za-z0-9](?:-?[A-Za-z0-9]){0,38})|([0-9a-f]{7,40}))(?![\w-])/g;

/**
 * `text` split into plain text and the references GitHub links in a pull request of `repo`
 * (`owner/name`): issues and pull requests, users, and commits. A hash needs a digit and a letter,
 * so a number or a word like "defaced" stays text.
 */
export function githubRefs(text: string, repo: string): RefPart[] {
  const parts: RefPart[] = [];
  let at = 0;
  for (const m of text.matchAll(REF)) {
    const [whole, lead, otherRepo, otherNumber, number, user, sha] = m;
    if (sha && !(/\d/.test(sha) && /[a-f]/.test(sha))) continue;
    const start = m.index + lead!.length;
    if (start > at) parts.push({ text: text.slice(at, start) });
    const ref = whole.slice(lead!.length);
    if (otherRepo)
      parts.push({
        text: ref,
        href: `https://github.com/${otherRepo}/issues/${otherNumber}`,
        kind: "issue",
      });
    else if (number)
      parts.push({ text: ref, href: `https://github.com/${repo}/issues/${number}`, kind: "issue" });
    else if (user) parts.push({ text: ref, href: `https://github.com/${user}`, kind: "user" });
    else
      parts.push({
        text: sha!.slice(0, 7),
        href: `https://github.com/${repo}/commit/${sha}`,
        kind: "commit",
      });
    at = m.index + whole.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** Links GitHub's references in text, outside links, code, and keys (githubRefs). */
export const rehypeGithubRefs =
  ({ repo }: { repo: string }) =>
  (tree: Parent) => {
    const visit = (parent: Parent) => {
      parent.children = parent.children.flatMap((node): Node[] => {
        if (node.type === "element") {
          if (!["a", "code", "pre", "kbd"].includes(node.tagName)) visit(node);
          return [node];
        }
        if (node.type !== "text") return [node];
        const parts = githubRefs(node.value, repo);
        if (parts.length === 1 && !("href" in parts[0]!)) return [node];
        return parts.map((p): Node => {
          if (!("href" in p)) return { type: "text", value: p.text };
          const text: Node = { type: "text", value: p.text };
          return {
            type: "element",
            tagName: "a",
            properties: { href: p.href, dataRef: p.kind },
            children:
              p.kind === "commit"
                ? [{ type: "element", tagName: "code", properties: {}, children: [text] }]
                : [text],
          };
        });
      });
    };
    visit(tree);
  };
