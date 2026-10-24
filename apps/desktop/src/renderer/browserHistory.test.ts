import { expect, test } from "vite-plus/test";

import { byDay, searchHistory, titled, visited, type Visit } from "./browserHistory";

test("a visit goes at the end, and coming back to the last page only moves its time", () => {
  let list = visited([], "https://a.com/", 1);
  list = visited(list, "https://b.com/", 2);
  list = visited(list, "https://b.com/", 3);
  expect(list).toEqual([
    { url: "https://a.com/", time: 1 },
    { url: "https://b.com/", time: 3 },
  ]);
  // The newest 5,000 are kept.
  const many = Array.from({ length: 5000 }, (_, i): Visit => ({ url: `https://x/${i}`, time: i }));
  expect(visited(many, "https://new/", 5000)).toHaveLength(5000);
});

test("a page's title goes to its latest visit, and an unchanged one hands back the same list", () => {
  const list: Visit[] = [
    { url: "https://a.com/", time: 1 },
    { url: "https://a.com/", time: 5, title: "A" },
    { url: "https://b.com/", time: 6 },
  ];
  expect(titled(list, "https://a.com/", "A, renamed")[1]!.title).toBe("A, renamed");
  expect(titled(list, "https://a.com/", "A")).toBe(list);
  expect(titled(list, "https://c.com/", "C")).toBe(list);
});

test("history search finds every word in a title or page, the newest first", () => {
  const list: Visit[] = [
    { url: "https://docs.rs/tokio", title: "Tokio docs", time: 1 },
    { url: "https://github.com/tokio-rs/tokio", title: "GitHub", time: 2 },
    { url: "https://example.com/", title: "Example", time: 3 },
  ];
  expect(searchHistory(list, "tokio").map((v) => v.time)).toEqual([2, 1]);
  expect(searchHistory(list, "tokio docs").map((v) => v.time)).toEqual([1]);
  expect(searchHistory(list, "")).toHaveLength(3);
});

test("visits group by day: Today, Yesterday, then the date", () => {
  const now = new Date(2026, 9, 23, 15).getTime();
  const at = (day: number, hour: number) => new Date(2026, 9, day, hour).getTime();
  const days = byDay(
    [
      { url: "a", time: at(23, 9) },
      { url: "b", time: at(22, 22) },
      { url: "c", time: at(20, 8) },
    ],
    now,
  );
  expect(days.map((d) => d.day)).toEqual([
    "Today",
    "Yesterday",
    new Date(at(20, 0)).toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    }),
  ]);
});
