import { expect, test, vi } from "vite-plus/test";

vi.mock("electron", () => ({ app: {} }));
vi.mock("electron-chrome-extensions", () => ({ ElectronChromeExtensions: class {} }));

const { chromeUserAgent, storeStatus } = await import("./webStore");

test("the browser's user agent is Chrome's, without Electron's and the app's tokens", () => {
  expect(
    chromeUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) parallax-desktop/0.0.0 Chrome/144.0.7559.60 Electron/44.4.5 Safari/537.36",
    ),
  ).toBe(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7559.60 Safari/537.36",
  );
  // A nightly's name has parentheses.
  expect(
    chromeUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Parallax(Nightly)/2610.12304.11500-nightly Chrome/144.0.7559.60 Electron/44.4.5 Safari/537.36",
    ),
  ).toBe(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7559.60 Safari/537.36",
  );
});

test("the store sees an extension as added, too old, or installable", () => {
  expect(storeStatus(true, undefined)).toBe("enabled");
  expect(storeStatus(false, '{"manifest_version":2}')).toBe("deprecated_manifest_version");
  expect(storeStatus(false, '{"manifest_version":3}')).toBe("installable");
  expect(storeStatus(false, undefined)).toBe("installable");
});
