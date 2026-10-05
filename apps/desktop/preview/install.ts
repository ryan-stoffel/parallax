// Installs the mock bridge before the renderer's modules run: main.ts imports this first, and
// ES modules evaluate in import order, so `window.parallax` is there when main.tsx reads it.
import { mockBridge, previewState } from "./mockBridge";

window.parallax = mockBridge;
Object.assign(window, { previewState });
