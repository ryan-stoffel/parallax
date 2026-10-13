import { expect, test } from "vite-plus/test";

import { dollarMath } from "./math";

test("rewrites \\(...\\) and \\[...\\] as dollar math", () => {
  expect(dollarMath("So \\( a^2 \\) and \\[\nx = 1\n\\]")).toBe("So $a^2$ and $$\nx = 1\n$$");
  // \\[2pt] inside is a line break with spacing, not an opener.
  expect(dollarMath("\\[ \\begin{aligned} a &= b \\\\[2pt] c &= d \\end{aligned} \\]")).toBe(
    "$$ \\begin{aligned} a &= b \\\\[2pt] c &= d \\end{aligned} $$",
  );
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

test("leaves dollars where Markdown doesn't read escapes: deep fences, indented code, and URLs", () => {
  const text = [
    "10. Run:\n\n    ```sh\n    export A=$HOME\n\n    echo $A\n    ```",
    "Text\n\n    indented $5 and $10\n\n    more $x",
    "See https://graph.microsoft.com/v1.0/users?$select=id and <https://e.com/?q=$filter>.",
  ].join("\n\n");
  expect(dollarMath(text)).toBe(text);
});

test("keeps \\(...\\) holding a dollar, and $$ must close in its paragraph mid-line", () => {
  expect(dollarMath("\\(\\$5 \\times 3\\)")).toBe("\\(\\$5 \\times 3\\)");
  expect(dollarMath("PID is $$. Prices $5 and $10.")).toBe("PID is \\$\\$. Prices \\$5 and \\$10.");
  // One that opens a line runs to the end, as a streaming display equation does.
  expect(dollarMath("Setup:\n\n$$\n\\frac{1")).toBe("Setup:\n\n$$\n\\frac{1");
});
