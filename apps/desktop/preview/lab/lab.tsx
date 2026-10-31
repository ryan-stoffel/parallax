// The composer lab (PLX-1206): concepts for a composer that morphs with what it reacts to, each
// played on the real composer of the open thread. Preview only, and only with `lab` in the hash:
//
//   #thread=Tahoe icon variants&lab            the switcher, in the window's corner
//   #thread=Tahoe icon variants&lab=voice      and plays a concept as the thread opens
//   …&lab=voice&labui=0                        without the switcher, for recordings
//
// `window.lab.play(name)` and `window.lab.stop()` drive it from a script.
import { type ComponentType, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { Button } from "../../src/renderer/ui";
import { Approval } from "./Approval";
import { Drop } from "./Drop";
import { type ConceptProps, clearEditor, composerBox } from "./morph";
import { Queue } from "./Queue";
import { SendTrace } from "./SendTrace";
import { Stream } from "./Stream";
import { Voice } from "./Voice";
import "./lab.css";

const concepts = {
  voice: { label: "Voice", View: Voice },
  stream: { label: "Stream trace", View: Stream },
  approval: { label: "Approval", View: Approval },
  queue: { label: "Queue", View: Queue },
  drop: { label: "File drop", View: Drop },
  send: { label: "Send trace", View: SendTrace },
} satisfies Record<string, { label: string; View: ComponentType<ConceptProps> }>;
type Name = keyof typeof concepts;

interface Playing {
  name: Name;
  box: HTMLFormElement;
  controller: AbortController;
  /** Bumped on each play, so playing the same concept again starts it over. */
  key: number;
}

let plays = 0;

/** Waits up to 8 s for the thread's composer. */
async function findBox() {
  for (let i = 0; i < 80; i++) {
    const box = composerBox();
    if (box) return box;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function Lab({ ui }: { ui: boolean }) {
  const [playing, setPlaying] = useState<Playing>();

  const stop = useCallback(() => {
    setPlaying((now) => {
      now?.controller.abort();
      return undefined;
    });
  }, []);

  /** Plays a concept, resolving once it ends or another takes its place. */
  const play = useCallback(async (name: Name) => {
    const box = await findBox();
    if (!box) return console.warn("lab: no composer on screen");
    // Each concept starts from an empty box.
    clearEditor(box);
    (document.activeElement as HTMLElement | null)?.blur();
    const controller = new AbortController();
    setPlaying((now) => {
      now?.controller.abort();
      return { name, box, controller, key: ++plays };
    });
    await new Promise((resolve) => controller.signal.addEventListener("abort", resolve));
  }, []);

  useEffect(() => {
    const api = { play, stop, concepts: Object.keys(concepts) };
    Object.assign(window, { lab: api });
  }, [play, stop]);

  useEffect(() => {
    const name = new URLSearchParams(location.hash.slice(1)).get("lab");
    if (name && name in concepts) void play(name as Name);
  }, [play]);

  const View = playing && concepts[playing.name].View;
  return (
    <>
      {View && (
        <View key={playing.key} box={playing.box} signal={playing.controller.signal} done={stop} />
      )}
      {ui && (
        <div className="fixed bottom-3 left-3 z-popover flex items-center gap-0.5 rounded-xl border border-border bg-surface p-1 shadow-composer">
          {(Object.keys(concepts) as Name[]).map((name) => (
            <Button
              key={name}
              size="sm"
              onClick={() => void play(name)}
              className={playing?.name === name ? "bg-selected" : ""}
            >
              {concepts[name].label}
            </Button>
          ))}
        </div>
      )}
    </>
  );
}

const params = () => new URLSearchParams(location.hash.slice(1));
if (params().has("lab")) {
  const root = document.createElement("div");
  root.id = "composer-lab";
  document.body.append(root);
  createRoot(root).render(<Lab ui={params().get("labui") !== "0"} />);
}
