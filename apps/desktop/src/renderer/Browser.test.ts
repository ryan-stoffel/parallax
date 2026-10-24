import { expect, test } from "vite-plus/test";

import { browserUrl, savedOf, searchUrl, shortUrl, withSaved, type SavedTabs } from "./Browser";
import { fitSize } from "./PageFrame";

test("a host without a scheme is https, or http when it's local, and only http and https pages open", () => {
  expect(browserUrl("localhost:5173")).toBe("http://localhost:5173/");
  expect(browserUrl("  localhost:5173/app?x=1 ")).toBe("http://localhost:5173/app?x=1");
  expect(browserUrl("localhost")).toBe("http://localhost/");
  expect(browserUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
  expect(browserUrl("[::1]:3000")).toBe("http://[::1]:3000/");
  expect(browserUrl("myhost:8000")).toBe("http://myhost:8000/");
  expect(browserUrl("example.com")).toBe("https://example.com/");
  expect(browserUrl("docs.rs/tokio")).toBe("https://docs.rs/tokio");
  expect(browserUrl("http://example.com")).toBe("http://example.com/");
  expect(browserUrl("https://example.com/a")).toBe("https://example.com/a");
  expect(browserUrl("HTTP://LOCALHOST:3000")).toBe("http://localhost:3000/");

  for (const address of [
    "",
    "   ",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "mailto:ryan@example.com",
    "about:blank",
    "parallax://x",
    "http://",
  ]) {
    expect(browserUrl(address), address).toBeUndefined();
  }
});

test("anything that isn't an address searches Google", () => {
  expect(searchUrl("a&b")).toBe("https://www.google.com/search?q=a%26b");
  for (const query of [
    "rust lifetimes",
    "tokio",
    "what is 1.5",
    "c++ templates",
    "node.js vs deno",
    "error: cannot borrow",
    "1.5",
    "42",
  ]) {
    expect(browserUrl(query), query).toBe(searchUrl(query));
  }
});

test("the unfocused address drops the scheme and a lone trailing slash", () => {
  expect(shortUrl("https://example.com/")).toBe("example.com");
  expect(shortUrl("http://localhost:5173/app/")).toBe("localhost:5173/app/");
  expect(shortUrl("https://www.google.com/search?q=x")).toBe("www.google.com/search?q=x");
});

test("a page fits to a monitor until the panel holds one whole", () => {
  // A side panel smaller than a monitor shows the monitor, scaled down.
  expect(fitSize(416, 900)).toEqual({ width: 1280, height: 800 });
  expect(fitSize(1600, 700)).toEqual({ width: 1280, height: 800 });
  // A bigger one shows the page at its own size.
  expect(fitSize(1600, 900)).toEqual({ width: 1600, height: 900 });
  // The panel fit is the panel, whatever its size.
  expect(fitSize(416, 900, "panel")).toEqual({ width: 416, height: 900 });
});

test("a browser saves its tabs with pages, the one in front, and only linked icons", () => {
  const tabs = [
    { id: 1 },
    { id: 2, url: "https://a.com/", title: "A", icon: "https://a.com/favicon.ico" },
    { id: 3, url: "https://b.com/", icon: "data:image/png;base64,AAAA" },
  ];
  expect(savedOf(tabs, 3)).toEqual({
    tabs: [
      { url: "https://a.com/", title: "A", icon: "https://a.com/favicon.ico" },
      { url: "https://b.com/" },
    ],
    current: 1,
  });
  // A blank tab in front saves the first page in front; only blank tabs save nothing.
  expect(savedOf(tabs, 1)?.current).toBe(0);
  expect(savedOf([{ id: 1 }], 1)).toBeUndefined();
});

test("saved browsers keep the permanent one and the newest 100 chats', and drop an empty one", () => {
  const entry: SavedTabs = { tabs: [{ url: "https://a.com/" }], current: 0 };
  let all = withSaved({}, "permanent", entry);
  for (let i = 0; i < 101; i++) all = withSaved(all, `t${i}`, entry);
  expect(Object.keys(all)).toHaveLength(101);
  expect(all["permanent"]).toEqual(entry);
  expect(all["t0"]).toBeUndefined();
  // Saving one again makes it the newest.
  all = withSaved(all, "t1", entry);
  expect(Object.keys(all).at(-1)).toBe("t1");
  expect(withSaved(all, "t1", undefined)["t1"]).toBeUndefined();
});
