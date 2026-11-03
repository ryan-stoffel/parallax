// A sidebar thread row dragged onto the composer, which attaches it to the message (PLX-378), or
// onto another sidebar section, which moves it there (PLX-1095). The tab strip and the split open it
// too (PLX-1082, PLX-1289).

/** The drag's data type. A thread's id is its host's, so the drag names the host too. */
export const threadDragType = "application/x-parallax-thread";

/** Puts thread `runId` on host `hostId` in a drag, for `draggedThread` to read on drop. */
export function dragThread(data: DataTransfer, hostId: string, runId: string) {
  data.setData(threadDragType, JSON.stringify({ hostId, runId }));
  data.effectAllowed = "copyMove";
}

/** The thread a drop carries, or undefined when it carries none. */
export function draggedThread(data: DataTransfer): { hostId: string; runId: string } | undefined {
  try {
    const { hostId, runId } = JSON.parse(data.getData(threadDragType)) as Record<string, unknown>;
    return typeof hostId === "string" && typeof runId === "string" ? { hostId, runId } : undefined;
  } catch {
    return undefined;
  }
}

/** A tab dragged along the strip (PLX-1289). Its data is the tab's id. */
export const tabDragType = "application/x-parallax-tab";

/**
 * A tile's header dragged onto another tile, which swaps them, or the tab strip, which gives it a
 * tab. Its data is the thread's id. It isn't a thread drag, so a composer doesn't attach it.
 */
export const tileDragType = "application/x-parallax-tile";
