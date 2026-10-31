// The composer lab (PLX-1206): the real composer of the open thread, redrawn as one liquid body
// that each state reshapes. Preview only, and only with `lab` in the hash:
//
//   #thread=Tahoe icon variants&lab            the switcher, in the window's corner
//   #thread=Tahoe icon variants&lab=tour       and plays the whole flow as the thread opens
//   …&lab=voice&labui=0                        without the switcher, for recordings
//
// `window.lab.play(name)` plays a state or the tour from a script, and `window.lab.stop()` gives
// the composer back.
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { Button } from "../../src/renderer/ui";
import { clearEditor, composerBox, insertText, sleep, typeInto } from "./dom";
import { clock } from "./spring";
import { Stage } from "./stage";
import "./lab.css";

const said = "Make the composer feel like one liquid body, and keep it monotone.";
const command = "pnpm exec icon-preview --sizes 32,128 build/icon/Assets.car";

/** Each state's script: what a person would do to get there, then the morph. */
const scripts = {
  idle: async (stage: Stage) => stage.idle(),
  focus: async (stage: Stage) => stage.focusIn(),
  voice: async (stage: Stage, signal: AbortSignal) => {
    stage.voice();
    await sleep(3200, signal);
    await stage.voiceDone(said);
  },
  send: async (stage: Stage, signal: AbortSignal) => {
    if (!composerText(stage)) insertText(stage.form, said);
    await sleep(250, signal);
    stage.send();
  },
  working: async (stage: Stage) => stage.working(),
  queue: async (stage: Stage, signal: AbortSignal) => {
    stage.working();
    await typeInto(stage.form, "Also record it in light mode", signal);
    await sleep(350, signal);
    stage.queue();
  },
  approval: async (stage: Stage, signal: AbortSignal) => {
    stage.approval(command);
    await sleep(2200, signal);
    stage.decide(true);
  },
  drag: (stage: Stage, signal: AbortSignal) => stage.drag(signal),
  error: async (stage: Stage, signal: AbortSignal) => {
    stage.focusIn();
    await sleep(300, signal);
    stage.error();
  },
  tour: async (stage: Stage, signal: AbortSignal) => {
    clearEditor(stage.form);
    stage.idle();
    await sleep(1200, signal);
    stage.focusIn();
    await sleep(1100, signal);
    stage.voice();
    await sleep(3400, signal);
    await stage.voiceDone(said);
    await sleep(1500, signal);
    stage.send();
    await sleep(1300, signal);
    stage.working();
    await sleep(1800, signal);
    await typeInto(stage.form, "Also record it in light mode", signal);
    await sleep(300, signal);
    stage.queue();
    await sleep(2200, signal);
    stage.approval(command);
    await sleep(2400, signal);
    stage.decide(true);
    await sleep(1200, signal);
    await stage.drag(signal);
    await sleep(1500, signal);
    stage.focusIn();
    await typeInto(stage.form, "Ship it", signal);
    await sleep(300, signal);
    stage.error();
    await sleep(1200, signal);
    clearEditor(stage.form);
    stage.idle();
    await sleep(1500, signal);
  },
} satisfies Record<string, (stage: Stage, signal: AbortSignal) => Promise<void>>;
type Name = keyof typeof scripts;

const composerText = (stage: Stage) =>
  stage.form.querySelector('[contenteditable="true"]')?.textContent?.trim();

/** Waits up to 8 s for the thread's composer. */
async function findBox() {
  for (let i = 0; i < 80; i++) {
    const box = composerBox();
    if (box) return box;
    await sleep(100);
  }
}

function Lab({ ui }: { ui: boolean }) {
  const stage = useRef<Stage>(undefined);
  const run = useRef<AbortController>(undefined);
  const [playing, setPlaying] = useState<Name>();

  const stop = useCallback(() => {
    run.current?.abort();
    stage.current?.destroy();
    stage.current = undefined;
    setPlaying(undefined);
  }, []);

  /** Plays a state's script, resolving once it ends or another takes its place. */
  const play = useCallback(async (name: Name) => {
    const box = await findBox();
    if (!box) return console.warn("lab: no composer on screen");
    if (stage.current?.form !== box) {
      stage.current?.destroy();
      stage.current = new Stage(box);
    }
    run.current?.abort();
    const controller = new AbortController();
    run.current = controller;
    setPlaying(name);
    try {
      await scripts[name](stage.current, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  }, []);

  useEffect(() => {
    Object.assign(window, {
      lab: { play, stop, states: Object.keys(scripts), stage: () => stage.current, clock },
    });
  }, [play, stop]);

  useEffect(() => {
    const name = new URLSearchParams(location.hash.slice(1)).get("lab");
    if (name && name in scripts) void play(name as Name);
    else if (name !== null) void play("idle");
  }, [play]);

  if (!ui) return null;
  return (
    <div className="fixed bottom-3 left-3 z-popover flex flex-wrap items-center gap-0.5 rounded-xl border border-border bg-surface p-1 shadow-composer">
      {(Object.keys(scripts) as Name[]).map((name) => (
        <Button
          key={name}
          size="sm"
          onClick={() => void play(name)}
          className={playing === name ? "bg-selected" : ""}
        >
          {name}
        </Button>
      ))}
      <Button size="sm" onClick={stop}>
        off
      </Button>
    </div>
  );
}

const params = () => new URLSearchParams(location.hash.slice(1));
if (params().has("lab")) {
  const root = document.createElement("div");
  root.id = "composer-lab";
  document.body.append(root);
  createRoot(root).render(<Lab ui={params().get("labui") !== "0"} />);
}
