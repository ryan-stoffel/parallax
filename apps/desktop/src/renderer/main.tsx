import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { preloadParser } from "react-native-enriched-markdown";

import { App } from "./App";
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
// Full screen hides Windows' window buttons, and with them the room the top row keeps for them.
window.parallax.onFullScreen((full) =>
  document.documentElement.toggleAttribute("data-full-screen", full),
);
// The saved theme, before React renders anything.
applyTheme();
// Enriched Markdown's parser, so a message draws in its first frame once it's loaded
// (MarkdownText). It loads in a few milliseconds, before any thread opens.
void preloadParser();
// A nightly build wears a night sky in the sidebar and on its send buttons (index.css).
void window.parallax
  .version()
  .then((version) =>
    document.documentElement.classList.toggle("nightly", version.includes("-nightly")),
  );

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <Tooltips />
  </StrictMode>,
);
