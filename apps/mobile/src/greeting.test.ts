import { expect, test } from "vitest";

import { greeting } from "./greeting";

test("greets by the time of day, with the name when there is one", () => {
  expect(greeting(4, "Ryan")).toBe("Evening, Ryan");
  expect(greeting(5, "Ryan")).toBe("Morning, Ryan");
  expect(greeting(11)).toBe("Morning");
  expect(greeting(12, "Ryan")).toBe("Afternoon, Ryan");
  expect(greeting(16)).toBe("Afternoon");
  expect(greeting(17, "Ryan")).toBe("Evening, Ryan");
  expect(greeting(23)).toBe("Evening");
});
