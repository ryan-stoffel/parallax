import type { WispBridge } from "../preload/bridge";

declare global {
  interface Window {
    wisp: WispBridge;
  }
}
