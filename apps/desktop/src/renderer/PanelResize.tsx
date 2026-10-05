import { useRef, type PointerEvent } from "react";

/** The sidebar header (traffic lights, hide button, brand) needs 240px to avoid clipping. */
export const SIDEBAR_MIN = 240;
const PANEL_MIN = 200;

/** Reserve 400px for the chat, shrinking panel minima only on smaller viewports. */
export function panelWidths(viewport: number, left: number, right: number) {
  const budget = Math.max(0, viewport - Math.min(400, viewport / 2));
  const share = budget / Math.max(1, Number(left > 0) + Number(right > 0));
  const minL = left > 0 ? Math.min(SIDEBAR_MIN, share) : 0;
  const minR = right > 0 ? Math.min(PANEL_MIN, share) : 0;
  const l = left > 0 ? Math.max(minL, Math.min(400, left)) : 0;
  const r = right > 0 ? Math.max(minR, Math.min(640, right)) : 0;
  if (l + r <= budget) return [l, r] as const;
  const extra = budget - minL - minR;
  const total = l + r - minL - minR;
  return [
    l ? minL + (total ? (extra * (l - minL)) / total : 0) : 0,
    r ? minR + (total ? (extra * (r - minR)) / total : 0) : 0,
  ] as const;
}

export function PanelResize({
  side,
  width,
  onResize,
}: {
  side: "left" | "right";
  width: number;
  onResize: (width: number) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const finish = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };
  return (
    <div
      role="separator"
      aria-label={`Resize ${side === "left" ? "sidebar" : "side panel"}`}
      title={`Drag to resize ${side === "left" ? "sidebar" : "side panel"}`}
      aria-orientation="vertical"
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      className={`absolute inset-y-0 z-30 w-1.5 touch-none cursor-col-resize panel-divider ${side === "left" ? "-right-0.5" : "-left-0.5"}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        drag.current = { x: e.clientX, width };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current)
          onResize(drag.current.width + (e.clientX - drag.current.x) * (side === "left" ? 1 : -1));
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        onResize(width + (e.key === "ArrowRight" ? 16 : -16) * (side === "left" ? 1 : -1));
      }}
    />
  );
}
