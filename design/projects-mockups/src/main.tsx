import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/sora";
import "./styles.css";
import { App } from "./App";
import { StoreProvider } from "./store";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);
