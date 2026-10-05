// The preview's entry: the mock `window.parallax`, then the real renderer, which imports its own
// index.css as it does in the app. Static imports keep the build one chunk for single.html.
import "./install";
import "../src/renderer/main.tsx";
import { openFromHash } from "./hash";

openFromHash();
window.addEventListener("hashchange", openFromHash);
