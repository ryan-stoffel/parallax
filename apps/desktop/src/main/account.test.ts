import { expect, test } from "vite-plus/test";

import { namesOf } from "./account";

test("a given first and last name win over a provider's full name, which splits at its first space", () => {
  expect(namesOf({ first_name: " Ryan ", last_name: "Stoffel", full_name: "R S" })).toEqual({
    firstName: "Ryan",
    lastName: "Stoffel",
  });
  expect(namesOf({ first_name: "Mary Ann", last_name: "" })).toEqual({
    firstName: "Mary Ann",
    lastName: "",
  });
  expect(namesOf({ full_name: "Ryan Thomas  Stoffel" })).toEqual({
    firstName: "Ryan",
    lastName: "Thomas Stoffel",
  });
  expect(namesOf({ name: "ryan" })).toEqual({ firstName: "ryan", lastName: "" });
  expect(namesOf({ avatar_url: "https://x" })).toEqual({ firstName: "", lastName: "" });
});
