// Approval: when the agent waits on a permission, the box becomes the request. The command
// shows as it will run, the box's foot splits into Deny and Allow, and a draft in the box is
// kept under it. The thread can't go on until this is answered, so it takes the place the user
// is already looking at, and the answer is one key.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { icons } from "../../src/renderer/icons";
import { animate, duration, easing } from "../../src/renderer/motion";
import { Kbd } from "../../src/renderer/ui";
import { type ConceptProps, sleep, typeInto, useCover } from "./morph";

const command = "pnpm exec icon-export --variant tinted --sizes 16,32,128";

export function Approval({ box, signal, done }: ConceptProps) {
  const content = useRef<HTMLDivElement>(null);
  const [asked, setAsked] = useState(false);
  return asked ? (
    <Request box={box} signal={signal} done={done} content={content} />
  ) : (
    <Draft box={box} signal={signal} onAsked={() => setAsked(true)} />
  );
}

/** The user types a draft, and the request arrives under it. */
function Draft({
  box,
  signal,
  onAsked,
}: Pick<ConceptProps, "box" | "signal"> & { onAsked: () => void }) {
  useEffect(() => {
    void (async () => {
      await sleep(500, signal);
      await typeInto(box, "Also check the 16 px one reads at", signal);
      await sleep(500, signal);
      onAsked();
    })().catch(() => {});
  }, [box, signal, onAsked]);
  return null;
}

function Request({
  box,
  signal,
  done,
  content,
}: ConceptProps & { content: React.RefObject<HTMLDivElement | null> }) {
  const cover = useCover(box, content);
  const split = useRef<HTMLSpanElement>(null);
  const [pressed, setPressed] = useState<"deny" | "allow">();

  const answer = async (how: "deny" | "allow") => {
    setPressed(how);
    await sleep(240, signal);
    await cover?.release();
    done();
  };

  // The foot splits from the middle once the box has its shape.
  useEffect(() => {
    if (!cover || !split.current) return;
    animate(split.current, [{ scale: "1 0" }, { scale: "1 1" }], {
      duration: duration.slow,
      delay: duration.base,
      easing: easing.spring,
      fill: "backwards",
    });
  }, [cover]);

  useEffect(() => {
    if (!cover) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        void answer(e.key === "Enter" ? "allow" : "deny");
      }
    };
    addEventListener("keydown", onKey, true);
    // The scripted answer.
    sleep(3200, signal).then(
      () => answer("allow"),
      () => {},
    );
    return () => removeEventListener("keydown", onKey, true);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once the cover is in.
  }, [cover]);

  const half = (how: "deny" | "allow") =>
    `flex h-11 flex-1 items-center justify-center gap-2 text-body transition-colors hover:bg-hover ${pressed === how ? "bg-selected" : ""} ${how === "allow" ? "font-medium text-foreground" : "text-muted-foreground"}`;

  return (
    cover &&
    createPortal(
      <div ref={content}>
        <div className="flex items-center gap-2 px-5 pt-3.5 text-meta text-muted-foreground">
          <icons.terminal className="size-3.5" />
          Claude Code wants to run a command
          <span className="ml-auto text-faint-foreground">Your draft is kept</span>
        </div>
        <pre className="mx-4 mt-2 overflow-x-auto rounded-lg bg-code px-3 py-2 font-mono text-body text-foreground">
          {command}
        </pre>
        <div className="mt-3 flex border-t border-border">
          <button type="button" onClick={() => void answer("deny")} className={half("deny")}>
            Deny <Kbd>esc</Kbd>
          </button>
          <span ref={split} className="w-px bg-border" />
          <button type="button" onClick={() => void answer("allow")} className={half("allow")}>
            Allow <Kbd>↵</Kbd>
          </button>
        </div>
      </div>,
      cover.layer,
    )
  );
}
