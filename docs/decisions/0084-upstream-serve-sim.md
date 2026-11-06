# 0084: iOS Simulators stream through upstream serve-sim

- Status: accepted; amends [0064](0064-agent-ui-tools-and-terminals.md)'s device hub for iOS
- Date: 2026-10-24
- Issue: PLX-988

## Context

The Device panel streamed every device through Expo's device hub at T3 Code's pin (`expo-device-hub` 0.15.3), whose bundled serve-sim is Expo's fork. Upstream serve-sim fixed its slow capture in EvanBacon/serve-sim#171, which no `expo-device-hub` release carries. Measured on an iOS 27.1 iPhone Duo with taps and swipes, Expo's fork decoded about 42 fps scrolling the Settings list and about 24 fps in full-screen home-page swipes, and upstream `0.1.49-beta.139.1` about 62 fps and 43 fps. Tap latency was about 145 ms on both.

## Decision

- The device hub sidecar also pins upstream `serve-sim` at `0.1.49-beta.139.1`. Its `version` names both pins, so either change installs into a new folder.
- On a Mac, plxd starts the sidecar with a second loopback port, where the wrapper serves serve-sim's middleware at `/serve-sim` before starting Expo's hub. Expo's hub runs with `--platform android` everywhere, so only serve-sim captures a simulator. plxd still opens only the stream routes: `/serve-sim/helper/<udid>/stream.avcc` and `/serve-sim/helper/<udid>/ws`.
- The panel speaks upstream's input protocol for iOS. Input starts once the control stream opens, since upstream has no admission frame, and a Duo folds with `0x0e {pose}`, its live display following the reported `hingeDegrees`.
- serve-sim leaves the description off some video streams, such as the first one of a new capture session. The panel reuses the stream's last description, or reopens the stream for one, up to three times per start.

## Rejected

- **Raising the 6 Mbps H.264 bitrate on Expo's hub.** At 17 Mbps the stream grew, from about 2.5 to 4.3 Mbps in full-screen swipes, but frame rates didn't change.
- **Relaying raw bytes in place of base64 JSON.** Encoding, parsing and decoding cost 4 to 14 µs a frame, 0.37 ms for a keyframe, under 1% of the relay's 12 ms.
- **Waiting for an `expo-device-hub` release with the fix.** None has one, and none is announced.

## Consequences

- iOS streaming depends on a serve-sim beta until a stable release has the fix, when the pin moves to it.
- Android keeps Expo's hub and its serve-emu unchanged.
- Two hubs share one sidecar process and its lifetime, so plxd still starts and stops one child.
