// Renders the Device panel gallery's still of each model in src/renderer/assets/devices (PLX-908):
// the model as the 3D view draws it, turned as a gallery card shows it, its screen off, cropped to
// the device, as WebP in assets/devices/stills. The gallery shows these, so its cards draw at once
// without loading a model. The folding iPhone Duo has none: its card shows its cover's artwork.
// Run it again after adding or changing a model. From apps/desktop:
//   pnpm exec playwright install chromium   (once)
//   node scripts/device-stills.mjs

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { createServer } from "vite-plus";

const renderer = fileURLToPath(new URL("../src/renderer/", import.meta.url));
const out = `${renderer}assets/devices/stills/`;
const ids = readdirSync(`${renderer}assets/devices`)
  .filter((file) => file.endsWith(".glb") && file !== "iphone-duo.glb")
  .map((file) => file.slice(0, -".glb".length));

const server = await createServer({
  configFile: false,
  root: renderer,
  logLevel: "error",
  server: { port: 0 },
});
await server.listen();
const origin = server.resolvedUrls.local[0];
// SwiftShader, so it renders the same on any machine, with or without a GPU.
const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.route(`${origin}stills`, (route) =>
  route.fulfill({ contentType: "text/html", body: "<!doctype html><body style=margin:0>" }),
);
await page.goto(`${origin}stills`);
mkdirSync(out, { recursive: true });

for (const id of ids) {
  const webp = await page.evaluate(async (id) => {
    const { createDevice3d } = await import("/device3d.ts");
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;width:240px;height:240px";
    document.body.replaceChildren(canvas);
    // A dark screen with a little light on it, as a phone looks off.
    const source = document.createElement("canvas");
    source.width = 600;
    source.height = 1300;
    const context = source.getContext("2d");
    const light = context.createRadialGradient(180, 130, 0, 180, 130, 900);
    light.addColorStop(0, "#2a3346");
    light.addColorStop(0.6, "#0b0d12");
    context.fillStyle = light;
    context.fillRect(0, 0, source.width, source.height);

    const device = createDevice3d({
      canvas,
      source,
      url: `/assets/devices/${id}.glb`,
      duo: false,
    });
    device.resize(240, 240, 2);
    await device.ready;
    device.frame();
    // As a gallery card turns a device's artwork.
    device.setPose(6, -24, 0);
    // Read in the frame it renders, before the drawing buffer is cleared.
    const frame = await new Promise((resolve) =>
      requestAnimationFrame(() => {
        const copy = document.createElement("canvas");
        copy.width = canvas.width;
        copy.height = canvas.height;
        copy.getContext("2d").drawImage(canvas, 0, 0);
        resolve(copy);
      }),
    );
    device.dispose();

    // Cropped to the device, with a pixel to spare.
    const { data, width, height } = frame
      .getContext("2d")
      .getImageData(0, 0, frame.width, frame.height);
    let [left, top, right, bottom] = [width, height, 0, 0];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] < 8) continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    if (right < left) throw new Error(`${id} rendered nothing`);
    left = Math.max(0, left - 1);
    top = Math.max(0, top - 1);
    const crop = document.createElement("canvas");
    crop.width = Math.min(width, right + 2) - left;
    crop.height = Math.min(height, bottom + 2) - top;
    crop.getContext("2d").drawImage(frame, -left, -top);
    return crop.toDataURL("image/webp", 0.9).split(",")[1];
  }, id);
  writeFileSync(`${out}${id}.webp`, Buffer.from(webp, "base64"));
  console.log(`${id}.webp`);
}

await browser.close();
await server.close();
