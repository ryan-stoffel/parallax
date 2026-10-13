import { expect, test } from "vite-plus/test";

import { dollarMath } from "./math";

test("rewrites \\(...\\) and \\[...\\] as dollar math", () => {
  expect(dollarMath("So \\( a^2 \\) and \\[\nx = 1\n\\]")).toBe("So $a^2$ and $$\nx = 1\n$$");
});

test("escapes a dollar that can't pair as Pandoc reads it", () => {
  expect(dollarMath("From $5 to $10, or $5-$10, then $x$.")).toBe(
    "From \\$5 to \\$10, or \\$5-\\$10, then $x$.",
  );
  expect(dollarMath("Set $PATH and $HOME, with $ x $ and $x^2$.")).toBe(
    "Set \\$PATH and \\$HOME, with \\$ x \\$ and $x^2$.",
  );
});

test("leaves code, escapes, math, and delimiters still arriving as they are", () => {
  const text =
    "`$5 \\(x\\)` and ``a \\[y\\]``\n\n```tex\n$\\[z\\]\n```\n\n$$\na \\\\[2pt] b \\$\n$$\n\n\\$5\n\n~~~\n\\(w\\)";
  expect(dollarMath(text)).toBe(text);
  expect(dollarMath("Then \\(a^2")).toBe("Then \\(a^2");
});

test("never pairs across a blank line", () => {
  expect(dollarMath("Use \\( here.\n\nLater \\(x\\) ok")).toBe("Use \\( here.\n\nLater $x$ ok");
  expect(dollarMath("Press (`).\n\nThen \\(x\\) and `code`")).toBe(
    "Press (`).\n\nThen $x$ and `code`",
  );
});
