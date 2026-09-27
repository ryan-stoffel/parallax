import type { WispBridge } from "../preload/preload";

declare global {
  interface Window {
    wisp: WispBridge;
  }
}
