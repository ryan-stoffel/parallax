import { useEffect, useRef, useState } from "react";
import { notify } from "./notifications";
import { VoiceSession, type VoicePhase } from "./voiceSession";

function voiceError(error: unknown) {
  if (error instanceof DOMException && error.name === "NotAllowedError")
    return "Allow microphone access in System Settings, then try again.";
  if (error instanceof DOMException && error.name === "NotFoundError")
    return "Connect a microphone, then try again.";
  return error instanceof Error ? error.message : "Voice input could not start. Try again.";
}

/** Own capture and the app-local hold gesture for this composer only. */
export function useVoice(options: {
  enabled: boolean;
  focused: boolean;
  hotkey: boolean;
  scope: string;
  starting(): void;
  inserted(text: string): void;
}) {
  const current = useRef(options);
  current.current = options;
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [hotkey, setHotkey] = useState(false);
  const [owner] = useState(() => crypto.randomUUID());
  const [session] = useState(
    () =>
      new VoiceSession(
        {
          engine: async (signal) => (await import("./voiceEngine")).loadVoiceEngine(signal),
          capture: async (signal) => (await import("./voiceCapture")).captureVoice(signal),
        },
        setPhase,
        (text) => {
          if (text && current.current.focused && current.current.enabled)
            current.current.inserted(text);
        },
        (error) => {
          notify({ tone: "error", title: "Voice input failed", body: voiceError(error) });
        },
      ),
  );
  const held = useRef(false);
  const start = () => {
    if (!current.current.enabled || !current.current.focused || session.phase !== "idle") return;
    current.current.starting();
    session.start();
  };
  const latestStart = useRef(start);
  latestStart.current = start;
  useEffect(() => {
    const cancel = () => {
      held.current = false;
      session.cancel();
    };
    const visibility = () => {
      if (document.hidden) cancel();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && session.phase !== "idle") {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
      }
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("keydown", escape, true);
    return () => {
      cancel();
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("keydown", escape, true);
    };
  }, [session, options.scope]);
  useEffect(() => {
    if (!options.enabled || !options.focused) session.cancel();
    if (!options.enabled || !options.focused || !options.hotkey || !window.parallax?.voiceHotkey)
      return;
    let live = true;
    const off = window.parallax.onVoiceKey?.((key) => {
      if (!current.current.focused) return;
      if (key === "down") {
        // Fn belongs to the thread, never to a dialog or a different text field.
        if (
          Array.from(document.querySelectorAll('[role="dialog"], [role="menu"]')).some((element) =>
            element.checkVisibility(),
          ) ||
          (document.activeElement?.matches("input, textarea, [contenteditable=true]") &&
            !document.activeElement.closest(".composer-input"))
        )
          return;
        if (session.phase !== "idle") return;
        held.current = true;
        latestStart.current();
      } else if (key === "up") {
        if (held.current) {
          held.current = false;
          session.confirm();
        }
      } else {
        held.current = false;
        session.cancel();
      }
    });
    void window.parallax
      .voiceHotkey(true, owner)
      .then((result) => {
        if (!live) return;
        setHotkey(result.available);
        if (result.error)
          notify({
            key: "voice-hotkey",
            tone: "error",
            title: "Hold Fn is unavailable",
            body: "Use the microphone button to dictate. Restart the app to retry the Fn shortcut.",
          });
      })
      .catch(() => {
        if (live) setHotkey(false);
      });
    return () => {
      live = false;
      setHotkey(false);
      off?.();
      void window.parallax.voiceHotkey?.(false, owner);
      held.current = false;
      session.cancel();
    };
  }, [session, owner, options.enabled, options.focused, options.hotkey, options.scope]);
  return {
    phase,
    hotkey,
    start,
    confirm: () => session.confirm(),
    cancel: () => session.cancel(),
    waveform: session.waveform,
  };
}
