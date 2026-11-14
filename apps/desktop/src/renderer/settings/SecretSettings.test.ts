import { expect, test } from "vite-plus/test";

import { expiresAt, expiryTone } from "./SecretSettings";

const day = 86_400_000;
const now = Date.parse("2026-11-14T12:00:00Z");
const at = (ms: number) => new Date(now + ms).toISOString();

test("an expiry choice ends in that many days, at the end of a picked day, or never", () => {
  expect(expiresAt("never", "", now)).toBeUndefined();
  expect(expiresAt("7", "", now)).toBe(at(7 * day));
  expect(expiresAt("date", "2026-12-01", now)).toBe(new Date("2026-12-01T23:59:59").toISOString());
});

test("an expiry reads as soon within three days and expired once passed", () => {
  expect(expiryTone(undefined, now)).toBe("never");
  expect(expiryTone(at(30 * day), now)).toBe("later");
  expect(expiryTone(at(2 * day), now)).toBe("soon");
  expect(expiryTone(at(-1), now)).toBe("expired");
});
