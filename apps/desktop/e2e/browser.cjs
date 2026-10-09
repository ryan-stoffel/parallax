// A plain browser for web.spec.ts: Electron's own Chromium, with no preload, opening the page at
// PLX_WEB_URL, so the web client needs no other browser installed.
const { app, BrowserWindow } = require("electron");

void app.whenReady().then(() => {
  const [width, height] = (process.env.PLX_WEB_SIZE ?? "1280x800").split("x").map(Number);
  void new BrowserWindow({ width, height }).loadURL(process.env.PLX_WEB_URL);
});
