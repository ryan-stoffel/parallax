import { expect, test } from "vite-plus/test";

import { initials } from "./profile";

test("initials are the first and last names' first letters, or the email's", () => {
  expect(initials({ name: "Ryan Thomas Stoffel", email: "r@x.dev" })).toBe("RS");
  expect(initials({ name: "  ryan  ", email: "r@x.dev" })).toBe("R");
  expect(initials({ name: "", email: "ryan@x.dev" })).toBe("R");
  expect(initials({ name: "Émile Zola", email: "" })).toBe("ÉZ");
});
