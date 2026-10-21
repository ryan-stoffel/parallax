import { zipSync } from "fflate";
import { expect, test, vi } from "vite-plus/test";

vi.mock("electron", () => ({ app: {} }));

const { crxZip, storeId } = await import("./extensions");

test("a Chrome Web Store link or a bare id gives the extension's id", () => {
  const id = "aeblfdkhhhdcdjpifhhbdiojplfjncoa";
  expect(storeId(id)).toBe(id);
  expect(storeId(`https://chromewebstore.google.com/detail/1password/${id}`)).toBe(id);
  expect(storeId(`https://chromewebstore.google.com/detail/${id}?hl=en`)).toBe(id);
  // Ids use only the letters a to p, 32 of them.
  expect(storeId("https://example.com/detail/not-an-extension")).toBeUndefined();
  expect(storeId("aeblfdkhhhdcdjpifhhbdiojplfjncoz")).toBeUndefined();
});

test("a CRX's zip comes out from under its version 3 or 2 header", () => {
  const zip = zipSync({ "manifest.json": new TextEncoder().encode("{}") });
  const crx = (version: number, ...lengths: number[]) => {
    const header = new Uint8Array(8 + lengths.length * 4 + lengths.reduce((a, b) => a + b, 0));
    const view = new DataView(header.buffer);
    header.set(new TextEncoder().encode("Cr24"));
    view.setUint32(4, version, true);
    lengths.forEach((n, i) => view.setUint32(8 + i * 4, n, true));
    return new Uint8Array([...header, ...zip]);
  };
  expect(crxZip(crx(3, 5))).toEqual(zip);
  expect(crxZip(crx(2, 3, 4))).toEqual(zip);
  expect(() => crxZip(zip)).toThrow("isn't a Chrome extension");
  expect(() => crxZip(crx(4, 0))).toThrow("version 4");
});
