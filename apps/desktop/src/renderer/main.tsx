import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { preloadParser } from "react-native-enriched-markdown";

import { App } from "./App";
import { CrashBoundary } from "./Crash";
import { startLanguage } from "./language";
import { applyTheme } from "./theme";
import { Tooltips } from "./ui";
import "katex/dist/katex.min.css";
import "./index.css";

// index.css keys the title bar styles off this.
document.documentElement.dataset["platform"] = window.parallax.platform;
// Windows' window buttons are as tall as the top row, which the page's zoom scales: main sizes
// them now and whenever the zoom, and with it the pixel ratio, changes.
if (window.parallax.platform === "win32") {
  let ratio = window.devicePixelRatio;
  window.parallax.zoomed();
  window.addEventListener("resize", () => {
    if (window.devicePixelRatio === ratio) return;
    ratio = window.devicePixelRatio;
    window.parallax.zoomed();
  });
}
// Full screen hides the window buttons on Windows and the traffic lights on macOS, and with them
// the room the top row keeps for them.
// On macOS it leaves a see-through window nothing to show, so it shows the wallpaper (index.css).
let fullScreen = false;
let wallpaper: string | undefined;
window.parallax.onFullScreen((full) => {
  fullScreen = full;
  const root = document.documentElement;
  root.toggleAttribute("data-full-screen", full);
  if (!full) {
    root.style.removeProperty("--wallpaper");
    if (wallpaper) URL.revokeObjectURL(wallpaper);
    wallpaper = undefined;
  } else if (window.parallax.transparent && !wallpaper) {
    void window.parallax.wallpaper?.().then((jpeg) => {
      if (!jpeg || !fullScreen || wallpaper) return;
      // A blob's URL, since a data URL this long is more than a CSS variable can hold.
      wallpaper = URL.createObjectURL(
        new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
      );
      root.style.setProperty("--wallpaper", `url("${wallpaper}")`);
    });
  }
});
// The saved theme, before React renders anything.
applyTheme();
// Enriched Markdown's parser, so a message draws in its first frame once it's loaded
// (MarkdownText). It loads in a few milliseconds, before any thread opens.
void preloadParser();
// A nightly build wears a night sky in the sidebar and on its send buttons, and a dev build
// (0103) blueprint paper (index.css). `.stage` is either.
void window.parallax.version().then((version) => {
  const { classList } = document.documentElement;
  classList.toggle("nightly", version.includes("-nightly"));
  classList.toggle("dev", version.endsWith("-dev"));
  classList.toggle("stage", version.includes("-nightly") || version.endsWith("-dev"));
});

// The language loads first, so the first frame is in it.
void startLanguage().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <CrashBoundary>
        <App />
      </CrashBoundary>
      <Tooltips />
    </StrictMode>,
  ),
);
