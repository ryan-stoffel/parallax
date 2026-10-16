import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Screenshots shown large over the app: the shown one's name, its place among them and arrows (or
 * the arrow keys) to the others when there are several, and Close (or Escape, or a click beside
 * it). Clicking the image zooms in once at the cursor, which pans it; clicking again zooms out.
 * With `onDownload`, Download saves the shown one, as a tool call's image does (PLX-834).
 */
export function Lightbox({
  images,
  index,
  onIndex,
  onClose,
  onDownload,
}: {
  images: readonly { src: string; name: string }[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  onDownload?: (index: number) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  // Where the zoom centers, as percentages of the image; absent while zoomed out.
  const [zoom, setZoom] = useState<{ x: number; y: number }>();
  useEffect(() => dialog.current?.showModal(), []);
  const image = images[index]!;
  const many = images.length > 1;
  const go = (step: number) => {
    setZoom(undefined);
    onIndex((index + step + images.length) % images.length);
  };
  const at = (e: { currentTarget: Element; clientX: number; clientY: number }) => {
    const box = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - box.left) / box.width) * 100,
      y: ((e.clientY - box.top) / box.height) * 100,
    };
  };
  const arrow =
    "absolute top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20 [&_svg]:size-5";
  return (
    <dialog
      ref={dialog}
      aria-label={image.name}
      onClose={onClose}
      onKeyDown={(e) => {
        if (many && e.key === "ArrowLeft") go(-1);
        else if (many && e.key === "ArrowRight") go(1);
      }}
      onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}
      className="m-0 h-full max-h-none w-full max-w-none bg-black/90 p-0 text-white outline-none backdrop:bg-transparent backdrop:backdrop-blur-sm"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-3 px-4 py-3 text-[13px]">
        <span className="min-w-0 flex-1 truncate font-medium" title={image.name}>
          {image.name}
        </span>
        {many && (
          <span className="shrink-0 text-white/70">
            {index + 1} / {images.length}
          </span>
        )}
        {onDownload && (
          <button
            type="button"
            onClick={() => onDownload(index)}
            className="pointer-events-auto flex items-center gap-1.5 rounded-full px-3 py-1.5 hover:bg-white/15 [&_svg]:size-4"
          >
            <Download aria-hidden />
            Download
          </button>
        )}
        <button
          type="button"
          aria-label="Close"
          onClick={() => dialog.current?.close()}
          className="pointer-events-auto grid size-8 place-items-center rounded-full hover:bg-white/15 [&_svg]:size-5"
        >
          <X aria-hidden />
        </button>
      </div>
      <div
        className="grid h-full place-items-center px-16 py-14"
        onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}
      >
        <span
          className={`overflow-hidden rounded-md ${zoom ? "cursor-zoom-out" : "cursor-zoom-in"}`}
          onClick={(e) => setZoom(zoom ? undefined : at(e))}
          onMouseMove={(e) => zoom && setZoom(at(e))}
        >
          <img
            key={image.src}
            src={image.src}
            alt={image.name}
            draggable={false}
            style={{
              transform: zoom ? "scale(2)" : undefined,
              transformOrigin: zoom ? `${zoom.x}% ${zoom.y}%` : undefined,
            }}
            className="block max-h-[calc(100vh-7rem)] max-w-[calc(100vw-8rem)] object-contain transition-transform duration-150"
          />
        </span>
      </div>
      {many && (
        <>
          <button
            type="button"
            aria-label="Previous"
            onClick={() => go(-1)}
            className={`${arrow} left-4`}
          >
            <ChevronLeft aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Next"
            onClick={() => go(1)}
            className={`${arrow} right-4`}
          >
            <ChevronRight aria-hidden />
          </button>
        </>
      )}
    </dialog>
  );
}
