import { expect, test } from "vite-plus/test";

import { browserUrl } from "./Browser";

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
