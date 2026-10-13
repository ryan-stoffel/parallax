import { expect, test } from "vite-plus/test";

import { dollarMath } from "./math";

test("rewrites \\(...\\) and \\[...\\] as dollar math", () => {
  expect(dollarMath("So \\( a^2 \\) and \\[\nx = 1\n\\]")).toBe("So $a^2$ and $$\nx = 1\n$$");
});

test("leaves code, and delimiters still arriving, as they are", () => {
  const text = "`\\(x\\)` and ``a \\[y\\]``\n\n```tex\n\\[z\\]\n```\n\n~~~\n\\(w\\)";
  expect(dollarMath(text)).toBe(text);
  expect(dollarMath("Then \\(a^2")).toBe("Then \\(a^2");
});
