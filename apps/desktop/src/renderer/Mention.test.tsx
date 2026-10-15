// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";

import { withMentions } from "./Mention";

test("a sent prompt's /skills and @paths are chips; other slashes and @s stay text", () => {
  const div = document.createElement("div");
  div.innerHTML = renderToStaticMarkup(
    <>{withMentions("/implement on @src/main.rs\nnot /usr/bin, @ryan, or a@b.com")}</>,
  );
  const chips = [...div.querySelectorAll("span[contenteditable]")];
  expect(chips.map((c) => [c.textContent, c.getAttribute("title")])).toEqual([
    ["implement", null],
    ["main.rs", "src/main.rs"],
  ]);
  expect(div.textContent).toBe("implement on main.rs\nnot /usr/bin, @ryan, or a@b.com");
});
