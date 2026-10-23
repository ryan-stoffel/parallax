// Which 3D model, and which still of it, shows a device in the Device panel (PLX-886, PLX-908).
// Only URLs: the models load with three.js in device3d.ts, and the stills, which
// scripts/device-stills.mjs renders from them, show as plain images in the gallery.

import type { DevicePlatform } from "../protocol/generated/protocol";

const models = import.meta.glob<string>("./assets/devices/*.glb", {
  query: "?url",
  import: "default",
  eager: true,
});
const stills = import.meta.glob<string>("./assets/devices/stills/*.webp", {
  query: "?url",
  import: "default",
  eager: true,
});

/** A Pixel's screen, wide for its height. */
const PIXEL_ASPECT = 1080 / 2424;

/** The model file Apple's model of iOS device `name` would be, such as "iphone-17-pro". */
function appleId(name: string): string {
  const n = name.toLowerCase();
  // An 11-inch iPad's screen is narrower than the 13-inch one in each of these models.
  const ipad = /^ipad (pro|air) 13-inch \((m\d)\)/.exec(n);
  // The M3 iPad Air is the M4's body.
  if (ipad) return `ipad-${ipad[1]}-${ipad[2]}`.replace("ipad-air-m3", "ipad-air-m4");
  if (n === "ipad (a16)") return "ipad-a16";
  if (n === "iphone se (3rd generation)") return "iphone-se-3";
  return n.replaceAll(" ", "-");
}

/** Google's model of Pixel `name`, such as "Pixel 9 Pro" or an AVD's "Pixel_9a", if it has one. */
function pixelId(name: string): string | undefined {
  const n = name.toLowerCase().replaceAll("_", " ");
  if (/fold|tablet/.test(n)) return undefined;
  // A Pro XL is its Pro's design, larger.
  const pixel = /pixel (\d+a?)( pro)?/.exec(n);
  const id = pixel && `pixel-${pixel[1]}${pixel[2] ? "-pro" : ""}`;
  return id && models[`./assets/devices/${id}.glb`] ? id : undefined;
}

/**
 * Apple's model of an iOS device, by its name, such as "iPhone 17 Pro" or "iPad Air 13-inch (M3)".
 * Undefined for a device Apple has none of, or a renamed one: it turns as flat artwork instead.
 */
export function appleModel(name: string): string | undefined {
  return models[`./assets/devices/${appleId(name)}.glb`];
}

/**
 * Google's model of an Android phone, by its name: its own Pixel's, or for another phone, the
 * Pixel 9's. The stream fills the model's screen, so a phone whose screen, `aspect` wide for its
 * height, isn't a Pixel's shape, or a foldable or tablet, gets none and turns as its flat artwork.
 */
export function pixelModel(name: string, aspect: number): string | undefined {
  if (/fold|tablet/i.test(name) || Math.abs(aspect - PIXEL_ASPECT) > 0.02) return undefined;
  return models[`./assets/devices/${pixelId(name) ?? "pixel-9"}.glb`];
}

/**
 * The gallery's still of a device's own model, turned as its card shows it, or undefined for a
 * device with no model of its own, which shows its artwork instead.
 */
export function deviceStill(platform: DevicePlatform, name: string): string | undefined {
  const id = platform === "ios" ? appleId(name) : pixelId(name);
  return id && stills[`./assets/devices/stills/${id}.webp`];
}
