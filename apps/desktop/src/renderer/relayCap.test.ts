import { expect, test } from "vite-plus/test";

import { relayCapNotice } from "./relayCap";

const limit = 2 * 1024 ** 3;
const usage = (bytes: number) => ({ bytes, limit, resetsAt: 1_000 });
const clock = (at: number) => `T${at}`;

test("an older relay's list, and a computer under 80%, say nothing", () => {
  expect(relayCapNotice("box", undefined, clock)).toBeUndefined();
  expect(relayCapNotice("box", usage(limit * 0.8 - 1), clock)).toBeUndefined();
});

test("from 80% it warns with what's used, when it resets, and that the LAN works", () => {
  const notice = relayCapNotice("box", usage(limit * 0.8), clock);
  expect(notice?.reached).toBe(false);
  expect(notice?.title).toBe("box is near its daily Parallax Connect limit");
  expect(notice?.body).toContain("used 80% of today's 2 GiB");
  expect(notice?.body).toContain("resets at T1000");
  expect(notice?.body).toContain("LAN");
});

test("the limit counts as reached only past it, where the relay refuses", () => {
  expect(relayCapNotice("box", usage(limit), clock)?.reached).toBe(false);
  const notice = relayCapNotice("box", usage(limit + 1), clock);
  expect(notice?.reached).toBe(true);
  expect(notice?.title).toBe("box reached its daily Parallax Connect limit");
  expect(notice?.body).toContain("resets at T1000");
  expect(notice?.body).toContain("still works over the LAN");
});
