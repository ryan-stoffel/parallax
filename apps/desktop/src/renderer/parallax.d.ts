import type { ParallaxBridge } from "../preload/bridge";

declare global {
  interface Window {
    parallax: ParallaxBridge;
  }
}
