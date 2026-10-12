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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <Tooltips />
  </StrictMode>,
);
