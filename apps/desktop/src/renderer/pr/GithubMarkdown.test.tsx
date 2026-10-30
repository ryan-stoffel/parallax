// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vite-plus/test";

import { githubRefs } from "./githubHtml";
import { GithubMarkdown } from "./GithubMarkdown";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function render(text: string) {
  const el = document.body.appendChild(document.createElement("div"));
  act(() => createRoot(el).render(<GithubMarkdown text={text} repo="me/app" />));
  return el;
}

test("githubRefs links #n, owner/repo#n, @user, and hashes, and leaves emails and words", () => {
  const links = (text: string) =>
    githubRefs(text, "me/app").flatMap((p) => ("href" in p ? [[p.text, p.href]] : []));
  expect(links("Fixes #12 and you/lib#3, thanks @ryan-s, in 1a2b3c4d5e")).toEqual([
    ["#12", "https://github.com/me/app/issues/12"],
    ["you/lib#3", "https://github.com/you/lib/issues/3"],
    ["@ryan-s", "https://github.com/ryan-s"],
    ["1a2b3c4", "https://github.com/me/app/commit/1a2b3c4d5e"],
  ]);
  expect(links("me@example.com defaced 1234567 a#1")).toEqual([]);
});

test("GitHub's HTML renders: a details fold, centered and sized images, picture, sub, kbd, br", () => {
  const el = render(
    [
      '<p align="center"><img src="https://x.dev/logo.png" width="120" alt="Logo"></p>',
      "",
      "<details><summary>Why</summary>",
      "",
      "Because **it** works.",
      "",
      "</details>",
      "",
      'Press <kbd>⌘</kbd><kbd>K</kbd>, H<sub>2</sub>O<br>next <a href="https://x.dev">site</a>',
      "",
      '<picture><source media="(prefers-color-scheme: dark)" srcset="https://x.dev/d.png"><img src="https://x.dev/l.png" alt="Shot"></picture>',
      "",
      '<script>alert(1)</script><img src="http://x.dev/plain.png" alt="Plain"><span onclick="x()">ok</span>',
    ].join("\n"),
  );
  const logo = el.querySelector<HTMLImageElement>('p[align="center"] img')!;
  expect([logo.src, logo.getAttribute("width")]).toEqual(["https://x.dev/logo.png", "120"]);
  const details = el.querySelector("details")!;
  expect(details.querySelector("summary")!.textContent).toBe("Why");
  expect(details.querySelector("strong")!.textContent).toBe("it");
  expect([...el.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["⌘", "K"]);
  expect(el.querySelector("sub")!.textContent).toBe("2");
  expect(el.querySelector("br")).not.toBeNull();
  expect(el.querySelector('a[href="https://x.dev"]')!.textContent).toBe("site");
  expect(el.querySelector("picture source")!.getAttribute("srcset")).toBe("https://x.dev/d.png");
  // Nothing runs, http images stay links, and handlers go.
  expect(el.querySelector("script")).toBeNull();
  expect(el.textContent).not.toContain("alert");
  expect([...el.querySelectorAll("img")].map((i) => i.alt)).toEqual(["Logo", "Shot"]);
  expect(el.querySelector("span[onclick]")).toBeNull();
});

test("footnotes, alerts, task lists, and references render as on GitHub", () => {
  const el = render(
    [
      "> [!WARNING]",
      "> Back up first.",
      "",
      "- [x] done",
      "- [ ] next",
      "",
      "Closes #7, by @me, at abc1234[^1].",
      "",
      "[^1]: The first commit.",
    ].join("\n"),
  );
  const alert = el.querySelector('[role="note"]')!;
  expect(alert.textContent!.replace(/\s+/g, " ").trim()).toBe("Warning Back up first.");
  expect(
    [...el.querySelectorAll('input[type="checkbox"]')].map((i) => (i as HTMLInputElement).checked),
  ).toEqual([true, false]);
  expect([...el.querySelectorAll("a[data-ref]")].map((a) => a.getAttribute("href"))).toEqual([
    "https://github.com/me/app/issues/7",
    "https://github.com/me",
    "https://github.com/me/app/commit/abc1234",
  ]);
  expect(el.querySelector("section")!.textContent).toContain("The first commit.");
});
