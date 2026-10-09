import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";

import {
  DiffFileHeader,
  DiffLineView,
  parseDiff,
  type DiffFile,
  type DiffLine,
} from "./PullRequests";

type Row = { file: DiffFile; line?: DiffLine; header?: boolean };

/** One window across all files, so both a huge file and many small files stay cheap to render. */
export function ChangesDiff({ diff, truncated }: { diff: string; truncated?: boolean }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const scroll = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => {
    const rows: Row[] = [];
    for (const file of files) {
      rows.push({ file, header: true });
      if (folded.has(file.path)) continue;
      if (file.binary) rows.push({ file });
      for (const line of file.lines) rows.push({ file, line });
    }
    return rows;
  }, [files, folded]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: (i) => (rows[i]!.header ? 38 : 20),
    overscan: 8,
  });
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <>
      <p className="px-3 py-2 text-[12.5px] text-muted-foreground">
        {files.length === 0 ? (
          "No files changed."
        ) : (
          <>
            {files.length} {files.length === 1 ? "file" : "files"} changed{" "}
            <span className="font-mono text-added">+{added}</span>{" "}
            <span className="font-mono text-danger">−{removed}</span>
          </>
        )}
        {truncated && " · cut at 10 MB"}
      </p>
      <div
        ref={scroll}
        aria-label="Changed files"
        className="min-h-0 flex-1 overflow-y-auto border-t border-border"
      >
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]!;
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {row.header ? (
                  <DiffFileHeader
                    file={row.file}
                    shut={folded.has(row.file.path)}
                    onToggle={() => {
                      setFolded((prev) => {
                        const next = new Set(prev);
                        if (next.has(row.file.path)) next.delete(row.file.path);
                        else next.add(row.file.path);
                        return next;
                      });
                      virtualizer.measure();
                    }}
                  />
                ) : (
                  <div className="font-mono text-[12px] leading-5">
                    {row.line ? (
                      <DiffLineView line={row.line} />
                    ) : (
                      <p className="px-3 text-faint-foreground">Binary file not shown</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
