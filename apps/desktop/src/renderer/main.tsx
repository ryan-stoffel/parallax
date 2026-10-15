import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { applyTheme } from "./theme";
import { Tooltips } from "./ui";
import "katex/dist/katex.min.css";
import "./index.css";

// index.css keys the title bar styles off this.
document.documentElement.dataset["platform"] = window.parallax.platform;
// The saved theme, before React renders anything.
applyTheme();
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
