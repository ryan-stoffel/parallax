// The `window.wisp` contract. The preload implements it and the renderer types
// against it, so it must not import anything from Node or Electron.
export interface WispBridge {
  /** Node's `process.platform`, e.g. "darwin", "win32", "linux". */
  platform: string;
  /** The app's version. */
  version(): Promise<string>;
}
