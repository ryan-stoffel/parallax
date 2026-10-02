# Parallax app icon kit

Built from the design-system mark: blue #2B5CFF, coral #FF4A1F, overlap white on black (dark) and black on white (light).

## What is here and where it goes

| Path | What it is | Use it for |
| --- | --- | --- |
| `Parallax.icon/` | Icon Composer bundle. Saved from Icon Composer. Two Liquid Glass layers, coral behind and blue in front, both at 80% opacity, group scale 0.92, translucency off, neutral shadow. Light appearance: white fill. Dark appearance: black fill. | macOS 26 and 27 (and iOS). Drag it into the Xcode project; Xcode generates every size and appearance. Open it in Icon Composer to see the glass render and adjust specular, shadow, and blur per layer. |
| `icns/Parallax-dark.icns` | Full-bleed square artwork, dark tile. 10 entries, 16 to 1024 px. | Electron (`electron-builder` `mac.icon`), Homebrew cask metadata, anything that cannot use an asset catalog. macOS 26 and later apply the system icon mask and glass frame on top of it. This is the default to ship. |
| `icns/Parallax-nightly.icns` | Full-bleed nightly tile: the same circles on a night-sky gradient with a few stars. Built from `masters/Parallax-nightly-full.svg` and `iconsets/Parallax-nightly-full.iconset/`. | Nightly builds (`scripts/ci/package-app` sets it as `mac.icon` for a `-nightly` version). |
| `icns/Parallax-light.icns` | Same, light tile. | Only if you want a light tile as the single fallback. `.icns` cannot hold both appearances. |
| `icns/Parallax-dark-legacy.icns`, `icns/Parallax-light-legacy.icns` | Pre-masked 824 pt squircle with margin and drop shadow, the macOS 15 and earlier convention. | Builds that must look right on macOS 15 and earlier. On macOS 26 and later the system re-masks these and they appear slightly inset, so prefer the full-bleed files there. |
| `iconsets/*.iconset/` | The PNG sets behind each `.icns`, named the way `iconutil` expects (`icon_16x16.png` through `icon_512x512@2x.png`). | Rebuild on a Mac with `iconutil -c icns Parallax-dark-full.iconset` if you change anything. |
| `xcode/AppIcon.appiconset/` | Legacy asset catalog set with `Contents.json` for the `mac` idiom, using the full-bleed dark PNGs. | Xcode targets that still need a classic app icon set alongside the `.icon` bundle. |
| `masters/` | 1024 px PNG and SVG masters for all four variants. | Marketing, README, App Store Connect (use the full-bleed PNG; it has no alpha). |

## What is required for macOS 27

1. One `Parallax.icon` bundle in the Xcode project. Xcode 26 and later compiles it and produces the legacy `.icns` and every size automatically.
2. Appearances come from the bundle. This one defines Default (light) and Dark explicitly. Clear and Tinted are derived by the system from the layers; check them in Icon Composer and add overrides only if they look wrong.
3. Layers are full-canvas SVGs. The group is scaled to 0.92 in the manifest so the circles sit inside the tile with room around them. Layers are listed front to back: blue, coral, both at 80% opacity. No separate overlap layer; the overlap is what the two glass layers produce.
4. The `.icns` files are the fallback for non-Xcode builds such as Electron. They are flat renders. Liquid Glass is rendered by the system from the `.icon` bundle, not baked into pixels.

## Notes

- The bundle was saved from Icon Composer and is the master. Do not regenerate it from the flat files.
- The flat previews in `masters/` show geometry and color only. The glass, specular, and shadow appear in Icon Composer and on device.
- The flat `.icns` renders keep the circles at full color and tint only the overlap to blue at 80% over coral, which matches the glass look without going dull. The bundle is the source of truth.
