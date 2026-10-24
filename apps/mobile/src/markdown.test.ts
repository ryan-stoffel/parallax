import type { Token, Tokens } from "marked";
import { expect, test } from "vitest";

import { lex } from "./markdown";

/** The math in `text`'s tokens, at any depth, as `$tex$` or `$$tex$$`. */
const math = (text: string) => {
  const found: string[] = [];
  const walk = (tokens: Token[] = []) =>
    tokens.forEach((t) => {
      if (t.type === "math") found.push(t["display"] ? `$$${t["text"]}$$` : `$${t["text"]}$`);
      if ("tokens" in t) walk(t.tokens);
      if (t.type === "list") t["items"].forEach((item: Tokens.ListItem) => walk(item.tokens));
      if (t.type === "table")
        [t["header"], ...t["rows"]].flat().forEach((cell: Tokens.TableCell) => walk(cell.tokens));
    });
  walk(lex(text));
  return found;
};

test("reads each delimiter the desktop accepts", () => {
  expect(math("So $a^2$ and \\(b_1\\), then $$c$$ in a line.")).toEqual(["$a^2$", "$b_1$", "$$c$$"]);
  expect(math("Setup:\n\n\\[\nx = \\frac{1}{2}\n\\]\n\nDone.")).toEqual(["$$x = \\frac{1}{2}$$"]);
});

test("display math on its own lines is a block, whatever its lines look like", () => {
  const [token] = lex("$$\n- a + b\n# c\n$$");
  expect(token).toMatchObject({ type: "math", display: true, text: "- a + b\n# c" });
});

test("leaves prices, code, and unclosed math as text", () => {
  expect(math("From $5 to $10, or $5-$10.\n\nThen `$x$` and\n\n```\n$y$\n```")).toEqual([]);
  expect(math("Then \\(a^2")).toEqual([]);
});

test("finds math in lists, tables, and emphasis", () => {
  expect(math("- *where $x$ is*\n- $y$\n\n| a | b |\n| - | - |\n| $z$ | 1 |")).toEqual([
    "$x$",
    "$y$",
    "$z$",
  ]);
});
