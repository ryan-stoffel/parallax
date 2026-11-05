import { expect, test } from "vitest";

import {
  approvalCode,
  asLists,
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
  sourcesFor,
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

const hostLists = (approvedHosts: string[], allowedHosts: string[] = []) => ({
  approvedClients: [],
  removedClients: [],
  approvedHosts,
  allowedHosts,
});

test("a computer adds to another's lists only if that one's list vouches for it, or it's proved", () => {
  const a = { id: "a", lists: hostLists(["b"]) };
  const b = { id: "b", lists: hostLists(["c"]) };
  const c = { id: "c", lists: hostLists(["a"]) };
  const fake = { id: "fake", lists: hostLists(["a", "b", "c", "fake"]) };
  const known = [a, b, c, fake];

  // Following the lists from `a`: `b`, then `c`. The fake lists them all, and none lists it.
  expect(sourcesFor(a, known, [], [])).toEqual([a, b, c]);
  // The fake's own list decides for the fake, and only for it.
  expect(sourcesFor(fake, known, [], [])).toEqual(known);
  // A computer this phone proved counts for all, and vouches for those it lists.
  const alone = { id: "alone", lists: hostLists([]) };
  expect(sourcesFor(alone, [alone, a, b, fake], ["a"], [])).toEqual([alone, a, b]);
});

test("a marked computer adds to no lists, even if listed or proved, and keeps its own", () => {
  const a = { id: "a", lists: hostLists(["clicked", "b"]) };
  const b = { id: "b", lists: hostLists([], ["clicked"]) };
  const clicked = { id: "clicked", lists: hostLists(["c"]) };
  const c = { id: "c", lists: hostLists([]) };
  // `b` marks it, and `a` lists `b`, so what it lists counts for nothing.
  expect(sourcesFor(a, [a, b, clicked, c], [], [])).toEqual([a, b]);
  // Marked here, and typed later: still marked.
  expect(sourcesFor(c, [c, clicked], ["clicked"], ["clicked"])).toEqual([c]);
  expect(sourcesFor(clicked, [c, clicked], [], ["clicked"])).toContain(clicked);

  // An older client reads only `approvedHosts`, so a marked computer stays out of it.
  const union = merged([a.lists, b.lists], ["a", "clicked"], ["clicked"]);
  expect(union.approvedHosts).toEqual(["a", "b"]);
  expect(union.allowedHosts).toEqual(["clicked"]);
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

test("a key read-only anywhere is read-only everywhere, and a host without the mark gets it", () => {
  const lists = { approvedClients: ["k1"], removedClients: [], approvedHosts: [] };
  const marked = { ...lists, readOnlyClients: ["k1"] };
  // A fake computer's malformed marks are no lists at all.
  expect(asLists(marked)).toEqual(marked);
  expect(asLists({ ...lists, readOnlyClients: "k1" })).toBeUndefined();
  // A host that never heard of the mark, or a plxd from before it, can't take it off.
  const union = merged([lists, marked], []);
  expect(union.readOnlyClients).toEqual(["k1"]);
  expect(merged([marked, lists], []).readOnlyClients).toEqual(["k1"]);
  expect(lacks(lists, union)).toBe(true);
  expect(lacks(marked, union)).toBe(false);
  // A removal doesn't touch the mark, and the mark doesn't touch a removal.
  const removed = { ...lists, approvedClients: [], removedClients: ["k1"] };
  expect(merged([marked, removed], [])).toMatchObject({
    readOnlyClients: ["k1"],
    removedClients: ["k1"],
  });
});
