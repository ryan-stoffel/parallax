import { useEffect, useState } from "react";

import icon from "./assets/app-icon.svg";
import nightlyIcon from "./assets/app-icon-nightly.svg";

// The least time the splash shows from launch, so a fast load doesn't flash it, and the most, so
// a host that's slow to answer still opens the window. Both count from the page's start.
const MIN_MS = 600;
const MAX_MS = 3000;
const FADE_MS = 300;

/**
 * The app icon centered on the window's background while the app launches, as T3 Code does
 * (PLX-1109). It fades out once `ready`, the open host's list loaded or its connection failed,
 * and goes away when faded. A nightly build shows its own icon (main.tsx sets `.nightly`).
 */
export function Splash({ ready }: { ready: boolean }) {
  const [phase, setPhase] = useState<"shown" | "fading" | "gone">("shown");
  useEffect(() => {
    if (phase !== "shown") return;
    const wait = ready ? MIN_MS - performance.now() : MAX_MS - performance.now();
    const timer = setTimeout(() => setPhase("fading"), Math.max(0, wait));
    return () => clearTimeout(timer);
  }, [ready, phase]);
  useEffect(() => {
    if (phase !== "fading") return;
    const timer = setTimeout(() => setPhase("gone"), FADE_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  if (phase === "gone") return null;
  return (
    // The theme's background, opaque even in a clear window, where index.css thins `.bg-background`
    // and `--pane` so the app would show through.
    <div
      aria-hidden
      data-testid="splash"
      className={`fixed inset-0 z-[1000] grid place-items-center bg-[var(--background)] transition-opacity duration-300 ${phase === "fading" ? "pointer-events-none opacity-0" : ""}`}
    >
      <img src={icon} alt="" className="size-16 rounded-[22%] [:root.nightly_&]:hidden" />
      <img
        src={nightlyIcon}
        alt=""
        className="hidden size-16 rounded-[22%] [:root.nightly_&]:block"
      />
    </div>
  );
}
