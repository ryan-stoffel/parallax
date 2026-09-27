import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { applyTheme } from "./theme";
import "./index.css";

// index.css keys the macOS title bar styles off this.
document.documentElement.dataset["platform"] = window.wisp.platform;
// The saved theme, before React renders anything.
applyTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
