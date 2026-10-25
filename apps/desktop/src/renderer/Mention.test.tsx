// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";

import { withMentions } from "./Mention";

test("a sent prompt's known /skills and @paths are chips; other slashes and @s stay text", () => {
  const known = new Set(["/implement", "@src/main.rs", "/review", "/design:ux-copy"]);
  const div = document.createElement("div");
  div.innerHTML = renderToStaticMarkup(
    <>
      {withMentions(
        "/implement on @src/main.rs, then /review and /design:ux-copy.\nnot /skill, @src/gone.rs, /usr/bin, @ryan, @types/node or a@b.com",
        (token) => known.has(token),
      )}
    </>,
  );
  const chips = [...div.querySelectorAll("span[contenteditable]")];
  expect(chips.map((c) => [c.textContent, c.getAttribute("title")])).toEqual([
    ["implement", "/implement"],
    ["main.rs", "src/main.rs"],
    ["review", "/review"],
    // A plugin's skill keeps its plugin, dimmed.
    ["design:ux-copy", "/design:ux-copy"],
  ]);
  expect(div.textContent).toBe(
    "implement on main.rs, then review and design:ux-copy.\nnot /skill, @src/gone.rs, /usr/bin, @ryan, @types/node or a@b.com",
  );
});
