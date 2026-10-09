// The web client's entry (PLX-651): plxd serves web.html at `/` of its HTTPS listener. A browser
// that hasn't paired gets the pairing screen; one that has gets the app, on webBridge.ts.

import { pair, savedSession, webBridge, WebHost } from "./webBridge";

async function start(): Promise<void> {
  const descriptor = await fetch("/.well-known/parallax")
    .then((r) => r.json() as Promise<{ name: string }>)
    .catch(() => ({ name: "Parallax" }));
  const session = await savedSession().catch(() => undefined);
  if (!session) return showPairing(descriptor.name);
  const host = new WebHost(session);
  window.parallax = webBridge(host, descriptor.name);
  void host.connect();
  // Wakes a socket a sleeping phone or tab may have lost.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") host.heartbeat();
  });
  await import("./main");
  // main.tsx keys the title bar's drag and window-button room off the platform; a page has neither.
  document.documentElement.dataset["platform"] = "web";
}

function showPairing(name: string): void {
  const screen = document.getElementById("pair")!;
  const form = screen.querySelector("form")!;
  const input = form.querySelector("input")!;
  const button = form.querySelector("button")!;
  const alert = form.querySelector('[role="alert"]')!;
  document.getElementById("host")!.textContent = name;
  screen.style.display = "grid";
  input.focus();
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    button.disabled = true;
    void pair(input.value).then((error) => {
      button.disabled = false;
      if (!error) return location.reload();
      alert.textContent = error;
      input.select();
    });
  });
}

void start();
