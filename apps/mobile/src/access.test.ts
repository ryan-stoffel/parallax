import { expect, test } from "vitest";

import {
  approvalCode,
  commitment,
  emptyBook,
  forgetRequest,
  keptValue,
  lacks,
  Limited,
  merged,
  newRequest,
  REQUEST_LIFETIME_MS,
  setupRun,
} from "./access";
import { WrongHost } from "./routes";

const random = (count: number) => new Uint8Array(count).fill(9);

// Computed apart from this code, from remote.rs's formulas, so the phone and plxd show one code.
test("the commitment and code match plxd's", () => {
  const host = new Uint8Array(32).fill(1);
  const client = new Uint8Array(32).fill(2);
  expect(commitment(host)).toBe("ZoQ6KShdUPgkGbfSVYmS8qgYFq541Chmhf9lDsqnzEY");
  expect(approvalCode(host, client, "A".repeat(43), "B".repeat(43))).toBe("647062");
});

test("a kept value is reused for its request, and another request or commitment fails", () => {
  const { book, value } = newRequest(emptyBook(), "r1", "c1", 0, random);
  expect(keptValue(book, "r1", "c1", 1000)).toEqual(value);
  expect(() => keptValue(book, "r2", "c1", 1000)).toThrow(WrongHost);
  expect(() => keptValue(book, "r1", "c2", 1000)).toThrow(WrongHost);
  // Once it lapses, the host may start another.
  expect(keptValue(book, "r2", "c2", REQUEST_LIFETIME_MS)).toBeUndefined();
  expect(keptValue(forgetRequest(book), "r2", "c2", 1000)).toBeUndefined();
});

test("at most 5 new requests and 5 setup runs a host an hour", () => {
  let book = emptyBook();
  for (let i = 0; i < 5; i++) book = forgetRequest(newRequest(book, `r${i}`, "c", i, random).book);
  expect(() => newRequest(book, "r5", "c", 10, random)).toThrow(Limited);
  expect(newRequest(book, "r5", "c", 60 * 60_000 + 5, random).book.requests).toHaveLength(1);

  let runs = emptyBook();
  for (let i = 0; i < 5; i++) runs = setupRun(runs, i);
  expect(() => setupRun(runs, 10)).toThrow(Limited);
  expect(setupRun(runs, 60 * 60_000 + 5).setupRuns).toHaveLength(1);
});

test("lists merge with removal winning, and a host lacking any entry gets a merge", () => {
  const a = { approvedClients: ["k1", "k2"], removedClients: [], approvedHosts: ["h1"] };
  const b = { approvedClients: ["k3"], removedClients: ["k2"], approvedHosts: [] };
  const union = merged([a, b], ["h2"]);
  expect(union).toEqual({
    approvedClients: ["k1", "k3"],
    removedClients: ["k2"],
    approvedHosts: ["h1", "h2"],
  });
  expect(lacks(a, union)).toBe(true);
  expect(lacks(union, union)).toBe(false);
});
