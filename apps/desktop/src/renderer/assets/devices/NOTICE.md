# Device models

The 3D models the Device view shows iPhones and iPads in (PLX-886) are Apple Inc.'s, from the AR
files on its product pages. No open-source or redistribution license has been established for
them; Parallax ships them knowing that.

`scripts/convert-device-model.py`, after T3 Code's (https://github.com/pingdotgg/t3code, MIT),
made each one with Blender 5.2 and glTF-Transform 4.2.1 from its source below: it keeps the
device's visible meshes around its screen, centers the screen and scales it to 2.2 units tall,
replaces Apple's wallpaper with a mesh named `device-screen`, encodes textures as WebP at most
1024 pixels, and compresses meshes with meshopt. Body and screen are the script's arguments.

A device with no model here, such as an 11-inch iPad or a Pro Max Apple only made the Pro's file
for, turns as its flat artwork. Android phones have no such files; `device3d.ts` builds a Pixel 9.

| File                    | Apple's source                                                                                                                                           | Body              | Screen                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------- |
| `iphone-11-pro.glb`     | https://www.apple.com/105/media/us/iphone-11-pro/2019/3bd902e4-0752-4ac1-95f8-6225c32aec6d/ar/iphone-11-pro.usdz                                         | `-`               | `XxVIqkRGlPduBBA`     |
| `iphone-11.glb`         | https://www.apple.com/105/media/us/iphone-11/2019/dc09a167-9d96-4ea8-935e-14af260ac4b1/ar/modern/iphone-11.usdz                                          | `-`               | `CZWQcguJkWJDGpu`     |
| `iphone-12-mini.glb`    | https://www.apple.com/105/media/us/iphone/compare/2021/e153e83d-e241-45f9-bb25-90cf42614e57/quick-look/iphone_12_mini_blue_5G_ios14.usdz                 | `-`               | `iUYDQDkAaCgLhDO`     |
| `iphone-12-pro-max.glb` | https://www.apple.com/105/media/us/iphone-12-pro/2020/e70ffbd8-50f1-40f3-ac36-0f03a15ac314/quick-look/modern/iphone_12_pro_max_graphite_5G_ios14.usdz    | `-`               | `pUFhzJwHyddjzmN`     |
| `iphone-12-pro.glb`     | https://www.apple.com/105/media/us/iphone-12-pro/2020/e70ffbd8-50f1-40f3-ac36-0f03a15ac314/quick-look/modern/iphone_12_pro_graphite_5G_ios14.usdz        | `-`               | `mFxKrsmkjUCakHq`     |
| `iphone-12.glb`         | https://www.apple.com/105/media/us/iphone/shared/ar/2022/95e52aae-96c0-48d6-87f9-77b3fe97bff9/iphone-12/iphone_12_blue_5G_ios14.usdz                     | `-`               | `JEjOAZSZbZcvPaa`     |
| `iphone-13-mini.glb`    | https://www.apple.com/105/media/us/iphone/shared/ar/2022/95e52aae-96c0-48d6-87f9-77b3fe97bff9/iphone-13/iphone_13_mini_green_5G_ios15.usdz               | `-`               | `ouRBFaOhLYSmTVv`     |
| `iphone-13-pro-max.glb` | https://www.apple.com/105/media/us/iphone-13-pro/2022/e79ab92e-2755-493d-9590-3f5d2c50216d/quick-look/iphone_13_pro_max_graphite_5G_ios15.usdz           | `-`               | `upSdSvcxZCyIXvE`     |
| `iphone-13-pro.glb`     | https://www.apple.com/105/media/us/iphone-13-pro/2022/e79ab92e-2755-493d-9590-3f5d2c50216d/quick-look/iphone_13_pro_graphite_5G_ios15.usdz               | `-`               | `NNFTdOzvytpqGDp`     |
| `iphone-13.glb`         | https://www.apple.com/105/media/us/iphone/shared/ar/2022/95e52aae-96c0-48d6-87f9-77b3fe97bff9/iphone-13/iphone_13_green_5G_ios15.usdz                    | `-`               | `mZuodmlecNGkTwH`     |
| `iphone-14-plus.glb`    | https://www.apple.com/105/media/us/iphone/shared/ar/2022/95e52aae-96c0-48d6-87f9-77b3fe97bff9/iphone-14/iphone_14_plus_midnight_5G.usdz                  | `-`               | `IwpYZJyixEcjjBv`     |
| `iphone-14-pro-max.glb` | https://www.apple.com/105/media/us/iphone/shared/ar/2022/95e52aae-96c0-48d6-87f9-77b3fe97bff9/iphone-14-pro/iphone_14_pro_max_space_black_5G.usdz        | `-`               | `eeEvVOvfrRtaxZU!`    |
| `iphone-14-pro.glb`     | https://www.apple.com/105/media/us/iphone/shared/ar/2022/95e52aae-96c0-48d6-87f9-77b3fe97bff9/iphone-14-pro/iphone_14_pro_space_black_5G.usdz            | `-`               | `sKJCSBYgljWSOMT!`    |
| `iphone-14.glb`         | https://www.apple.com/105/media/us/iphone/shared/ar/2022/95e52aae-96c0-48d6-87f9-77b3fe97bff9/iphone-14/iphone_14_midnight_5G.usdz                       | `-`               | `xODRHUtemnuJCFY`     |
| `iphone-15-plus.glb`    | https://www.apple.com/105/media/us/iphone/shared/ar/2023/f6ca1075-bfa5-441b-b6c2-61e5ce4c15b2/iphone-15/iphone_15_plus_black_5G.usdz                     | `-`               | `UFUHNLzifnhnNGn`     |
| `iphone-15-pro-max.glb` | https://www.apple.com/105/media/us/iphone/shared/ar/2023/f6ca1075-bfa5-441b-b6c2-61e5ce4c15b2/iphone-15-pro/iphone_15_pro_max_black_titanium_5G.usdz     | `-`               | `jCKViMoiBhELtJN`     |
| `iphone-15-pro.glb`     | https://www.apple.com/105/media/us/iphone/shared/ar/2023/f6ca1075-bfa5-441b-b6c2-61e5ce4c15b2/iphone-15-pro/iphone_15_pro_black_titanium_5G.usdz         | `-`               | `uNGnoFASTVakusL`     |
| `iphone-15.glb`         | https://www.apple.com/105/media/us/iphone/shared/ar/2023/f6ca1075-bfa5-441b-b6c2-61e5ce4c15b2/iphone-15/iphone_15_black_5G.usdz                          | `-`               | `FiVhqGttEcUZOfV`     |
| `iphone-16-plus.glb`    | https://www.apple.com/105/media/us/iphone/shared/ar/2024/1db11f29-1385-4ae5-bbfd-2c885f4463d4/iphone-16/iphone-16-plus-black-no-sim.usdz                 | `-`               | `CytfiVxeFplHwfB`     |
| `iphone-16-pro-max.glb` | https://www.apple.com/105/media/us/iphone/shared/ar/2024/1db11f29-1385-4ae5-bbfd-2c885f4463d4/iphone-16-pro/iphone-16-pro-max-no-sim-black-titanium.usdz | `-`               | `ZvTvRNAPWsJgbqE`     |
| `iphone-16-pro.glb`     | https://www.apple.com/105/media/us/iphone/shared/ar/2024/1db11f29-1385-4ae5-bbfd-2c885f4463d4/iphone-16-pro/iphone-16-pro-no-sim-black-titanium.usdz     | `-`               | `SsxPlgdiqbgmsbW`     |
| `iphone-16.glb`         | https://www.apple.com/105/media/us/iphone/shared/ar/2024/1db11f29-1385-4ae5-bbfd-2c885f4463d4/iphone-16/iphone-16-black-no-sim.usdz                      | `-`               | `jlkDNZeoPNKCBzX`     |
| `iphone-16e.glb`        | https://www.apple.com/105/media/us/iphone/shared/ar/2025/aa5fba56-f772-4712-9d4c-0516416169e3/iphone-16e/iphone16_e_black.usdz                           | `-`               | `ZIumnRnMpwLmErC`     |
| `iphone-17-pro-max.glb` | https://www.apple.com/105/media/us/iphone-17-pro/2025/704d4474-8e63-4ce7-9917-bb47b1ca4ba0/ar/iphone-17-pro-e-sim.usdz                                   | `jqrLJsSCRSFSMip` | `HkNSnYzBPABcqwM.001` |
| `iphone-17-pro.glb`     | https://www.apple.com/105/media/us/iphone-17-pro/2025/704d4474-8e63-4ce7-9917-bb47b1ca4ba0/ar/iphone-17-pro-e-sim.usdz                                   | `RQNEPvSqUMnJxkk` | `HkNSnYzBPABcqwM`     |
| `iphone-17.glb`         | https://www.apple.com/105/media/us/iphone-17/2025/b2c72de3-1cbc-4e24-b4d3-23c7abcec4ec/ar/iphone-17-e-sim.usdz                                           | `-`               | `eXcdWRctfHqyWLU`     |
| `iphone-17e.glb`        | https://www.apple.com/105/media/us/iphone/shared/ar/2026/44fa1631-e6c3-4596-b59b-0d58f7e8735c/iphone-17e/iphone-17e-e-sim-soft-pink.usdz                 | `-`               | `saxrJLGXKkVuvan`     |
| `iphone-18-pro-max.glb` | https://www.apple.com/105/media/us/iphone-18-pro/2026/591df885-5ee2-4173-86e6-401021249f7c/ar/iphone-18-pro-e-sim.usdz                                   | `wUOhcMgiBmCgGaw` | `EHjrGDHNHzgNjtE.001` |
| `iphone-18-pro.glb`     | https://www.apple.com/105/media/us/iphone-18-pro/2026/591df885-5ee2-4173-86e6-401021249f7c/ar/iphone-18-pro-e-sim.usdz                                   | `UBGArkKGrAMRRnj` | `EHjrGDHNHzgNjtE`     |
| `iphone-air.glb`        | https://www.apple.com/105/media/us/iphone-air/2025/731189b1-a606-493f-afa4-7c766a8fd08d/ar/iphone-air-e-sim.usdz                                         | `-`               | `tppzCQmnlKcHIpP`     |
| `iphone-se-3.glb`       | https://www.apple.com/105/media/us/iphone/shared/ar/2022/95e52aae-96c0-48d6-87f9-77b3fe97bff9/iphone-se/iphone_se_3rdgen_midnight.usdz                   | `-`               | `csNYhjzAMNroEBY`     |
| `ipad-a16.glb`          | https://www.apple.com/105/media/us/ipad-11/2025/21af9618-666d-4368-9fb9-38822c35dc35/ar/ipad-11-silver.usdz                                              | `-`               | `xlzlkvUdaKfEmbz`     |
| `ipad-air-m2.glb`       | https://www.apple.com/105/media/us/ipad-air/2024/df9239d9-b05f-4fc6-9f57-8ce5c168833f/ar/ipad_air_13in_m2_sgray_mgk_ap-pro_wifi.usdz                     | `GKTlEcqQhuIuxjo` | `KqscgnoAfVzIwsd`     |
| `ipad-air-m4.glb`       | https://www.apple.com/105/media/us/ipad-air/2025/e184d49a-4015-42ae-8a8b-db06bfeabd75/ar/ipad-air-space-gray-with-accessories.usdz                       | `IfkLcOgQYNqkFbW` | `PlmwhBklHctYyNL`     |
| `ipad-pro-m4.glb`       | https://www.apple.com/105/media/us/ipad-pro/2024/97d7edf3-aac0-443d-9731-38d40ff50951/ar/ipad_pro_13in_black_m4_mgk_ap-pro_wifi.usdz                     | `ueGHhUGMjaZlNAI` | `ifuqiaWvBiLVOJa`     |
| `ipad-pro-m5.glb`       | https://www.apple.com/105/media/us/ipad-pro/2025/adee90db-c01e-430d-b726-fe64c0063f08/ar/ipad-pro-space-black.usdz                                       | `zRrSLDpdYmKeRJQ` | `lsDiIbtoSGSmWWZ`     |
