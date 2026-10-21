# Device models

The 3D models the Device view shows iPhones and iPads in (PLX-886) are Apple Inc.'s, from the AR
files on its product pages, as T3 Code converted them
(https://github.com/pingdotgg/t3code, `apps/web/src/components/device/models/`). T3 Code's
`sources.json` records that conversion and that no open-source or redistribution license has
been established for them. Parallax ships them knowing that.

| File                    | Apple's source                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `iphone-18-pro.glb`     | https://www.apple.com/105/media/us/iphone-18-pro/2026/591df885-5ee2-4173-86e6-401021249f7c/ar/iphone-18-pro-e-sim.usdz |
| `iphone-18-pro-max.glb` | the same file's Pro Max                                                                                                |
| `ipad-pro-13-m5.glb`    | https://www.apple.com/105/media/us/ipad-pro/2025/adee90db-c01e-430d-b726-fe64c0063f08/ar/ipad-pro-space-black.usdz     |

T3 Code's conversion (Blender 4.5.9, glTF-Transform 4.2.1) kept the device bodies, centered each
screen and scaled it to 2.2 units tall, replaced the baked screen with a mesh named
`device-screen`, and encoded textures as WebP at most 1024 pixels.

Android phones have no such files; `device3d.ts` builds a Pixel 9 itself.
