import { Circle, CircleCheck, Maximize2, Minimize2, TriangleAlert } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCallback, useState } from "react";

import type { AgentRun, ContextFile } from "../protocol/generated/protocol";
import { board, ContextReader, SharedNotes, useContent, useProjectContext } from "./ContextPanel";
import type { InboxView } from "./Inbox";
import { Loader } from "./Loader";
import { MemoryPanel, sectionsOf, type Memory } from "./MemoryPanel";
import { MiniPrompt } from "./MiniPrompt";
import { PixelField, type Pixel } from "./Pixels";
import { age } from "./Sidebar";
import { IconButton } from "./ui";

// What counts as new: learned in the last day.
const freshMs = 24 * 60 * 60 * 1000;

/**
 * The side panel's Knowledge view: what a Project's agents know, in one list. A Project's opens on
 * where it stands, the coordinator's status board as a checklist, then how much it knows, a square
 * a fact as a field that fills as agents learn, and what it learned last; then Memory's brief,
 * entries, knowledge, and proposals, then the Project's other shared notes. A note opens in place, with memory kept
 * behind it. At its foot a mini prompt changes it in plain words; `expanded`, it centers in the
 * window with a larger one. Off a Project it's the repository's memory alone. `memory` is whether
 * the host's plxd has `memory`; without it a Project shows only its context. Key it by host and
 * folder.
 */
export function KnowledgePanel({
  hostId,
  project,
  repo,
  coordinator,
  connected,
  memory,
  inbox,
  working,
  expanded,
  onExpand,
}: {
  hostId: string;
  project?: string;
  repo?: string;
  coordinator?: AgentRun;
  connected: boolean;
  memory: boolean;
  /** The Project's inbox, whose Learned items show as they arrive. */
  inbox?: InboxView;
  /** Whether any of its agents is working, so the field is live. */
  working?: boolean;
  expanded?: boolean;
  /** Fills the window with it, or puts it back. */
  onExpand?: (expanded: boolean) => void;
}) {
  const { files, error } = useProjectContext(hostId, project ?? "", connected && !!project);
  const [memories, setMemories] = useState<readonly Memory[]>([]);
  const onFiles = useCallback((f: readonly Memory[]) => setMemories(f), []);
  const [openPath, setOpenPath] = useState<string>();
  const open = files.find((f) => f.path === openPath);
  const notes = project && <SharedNotes files={files} onOpen={setOpenPath} />;
  const notesFile = files.find((f) => f.path === board);
  const head = project && (
    <>
      <div className="flex items-center gap-2 px-2.5 pt-3">
        <h3 className="font-mono text-[11px] tracking-wide text-faint-foreground uppercase">
          Knowledge
        </h3>
        {working && (
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-working">
            <Loader kind="matrix" variant="ripple" size={11} />
            growing
          </span>
        )}
        {onExpand && (
          <span className="ml-auto">
            <IconButton
              label={expanded ? "Back to the side" : "Full screen"}
              onClick={() => onExpand(!expanded)}
            >
              {expanded ? <Minimize2 /> : <Maximize2 />}
            </IconButton>
          </span>
        )}
      </div>
      <ProjectState
        hostId={hostId}
        project={project}
        file={notesFile}
        error={error}
        onOpen={() => notesFile && setOpenPath(notesFile.path)}
      />
      <Known
        memories={memories}
        files={files}
        inbox={inbox}
        working={working}
        expanded={expanded}
      />
    </>
  );
  const prompt = project && memory && (
    <MiniPrompt hostId={hostId} coordinator={coordinator} large={expanded} />
  );
  return (
    <div className={`flex min-h-0 flex-1 flex-col ${expanded ? "mx-auto w-full max-w-3xl" : ""}`}>
      {open && project && (
        <ContextReader
          hostId={hostId}
          project={project}
          files={files}
          file={open}
          onOpen={setOpenPath}
          onBack={() => setOpenPath(undefined)}
        />
      )}
      <div hidden={!!open} className="flex min-h-0 flex-1 flex-col">
        {memory ? (
          <MemoryPanel
            hostId={hostId}
            project={project}
            repo={repo}
            coordinator={coordinator?.id}
            start={head}
            end={notes}
            footer={prompt || undefined}
            onFiles={onFiles}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {head}
            {notes}
          </div>
        )}
      </div>
    </div>
  );
}

interface BoardSection {
  title: string;
  items: { text: string; done: boolean }[];
}

/**
 * The status board's sections and their items, from the coordinator's Markdown: each `##` heading
 * a section, each list item an item, `- [x]` done. Other lines aren't items.
 */
export function boardSections(markdown: string): BoardSection[] {
  const sections: BoardSection[] = [];
  for (const line of markdown.split("\n")) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      sections.push({ title: heading[1]!.trim(), items: [] });
      continue;
    }
    const item = /^\s*[-*]\s+(?:\[([ xX])\]\s+)?(.+)$/.exec(line);
    if (item && sections.length) {
      const text = item[2]!.trim();
      if (text !== "(empty)") sections.at(-1)!.items.push({ text, done: !!item[1]?.trim() });
    }
  }
  return sections.filter((s) => s.items.length > 0);
}

// A board item's Markdown as one run of text: its bold and code as they are, but no paragraphs.
const inline: Components = {
  p: ({ children }) => <>{children}</>,
  strong: ({ children }) => <strong className="font-medium text-foreground">{children}</strong>,
  a: ({ children }) => <span className="underline underline-offset-2">{children}</span>,
  code: ({ children }) => (
    <code className="rounded bg-selected px-1 font-mono text-[11.5px]">{children}</code>
  ),
};

/**
 * Where the Project stands, from the coordinator's status board: a section a heading (Now, Next,
 * Risks), each item a line with a circle, checked once done, or a warning under Risks.
 */
function ProjectState({
  hostId,
  project,
  file,
  error,
  onOpen,
}: {
  hostId: string;
  project: string;
  file?: ContextFile;
  error?: string;
  onOpen: () => void;
}) {
  return (
    <section aria-label="Where it stands" className="px-2.5 pt-2">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[15px] font-medium">Where it stands</h3>
        {file && (
          <button
            type="button"
            onClick={onOpen}
            className="ml-auto font-mono text-[11px] text-faint-foreground hover:text-foreground"
          >
            {file.path} · {age(file.modifiedAt)}
          </button>
        )}
      </div>
      {file ? (
        <Board hostId={hostId} project={project} file={file} />
      ) : (
        <p className="pt-1.5 text-[12.5px] text-muted-foreground">
          The coordinator keeps a status board here once it starts on the work.
        </p>
      )}
      {error && (
        <p role="alert" className="pt-1.5 text-[12.5px] text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

function Board({ hostId, project, file }: { hostId: string; project: string; file: ContextFile }) {
  const { content } = useContent(hostId, project, file);
  if (content === undefined) return null;
  const sections = boardSections(content);
  return (
    <div className="flex flex-col gap-3 pt-2.5">
      {sections.map((section) => {
        const risks = /risk|block/i.test(section.title);
        const done = section.items.filter((i) => i.done).length;
        return (
          <section key={section.title} aria-label={section.title}>
            <h4 className="pb-1 font-mono text-[11px] tracking-wide text-faint-foreground uppercase">
              {section.title}{" "}
              <span className="tabular-nums">
                {done > 0 ? `${done}/${section.items.length}` : section.items.length}
              </span>
            </h4>
            <ul className="flex flex-col">
              {section.items.map((item, i) => {
                const Icon = risks ? TriangleAlert : item.done ? CircleCheck : Circle;
                return (
                  <li key={i} className="flex gap-2.5 py-1 text-[12.5px] leading-snug">
                    <Icon
                      aria-hidden
                      className={`mt-px size-3.5 shrink-0 ${risks ? "text-warning" : item.done ? "text-added" : "text-faint-foreground"}`}
                    />
                    <span
                      className={`min-w-0 ${item.done ? "text-faint-foreground" : "text-muted-foreground"}`}
                    >
                      <span className="sr-only">{item.done ? "Done: " : ""}</span>
                      <Markdown remarkPlugins={[remarkGfm]} components={inline}>
                        {item.text}
                      </Markdown>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/**
 * How much the Project knows: a count of each kind, what's new today, the field of squares, and
 * the latest few things learned, newest first.
 */
function Known({
  memories,
  files,
  inbox,
  working,
  expanded,
}: {
  memories: readonly Memory[];
  files: readonly ContextFile[];
  inbox?: InboxView;
  working?: boolean;
  expanded?: boolean;
}) {
  const now = Date.now();
  const fresh = (at: string) => now - Date.parse(at) < freshMs;
  const proposals = new Set(sectionsOf(memories).proposals);
  const learned = inbox?.items.filter((i) => i.kind === "learned") ?? [];
  const facts = [
    ...memories.map((m) => ({
      id: `m/${m.scope.kind}/${m.path}`,
      tone: proposals.has(m) ? ("proposal" as const) : ("memory" as const),
      title: m.title ?? m.path,
      at: m.modifiedAt,
    })),
    ...files.map((f) => ({
      id: `c/${f.path}`,
      tone: "note" as const,
      title: f.path,
      at: f.modifiedAt,
    })),
    ...learned.map((i) => ({
      id: `l/${i.id}`,
      tone: "learned" as const,
      title: i.text.replace(/^Memory: /, ""),
      at: i.createdAt,
    })),
  ].toSorted((a, b) => a.at.localeCompare(b.at));
  const pixels: Pixel[] = facts.map((f) => ({ ...f, fresh: fresh(f.at) }));
  const today = facts.filter((f) => fresh(f.at)).length;
  const count = (tone: Pixel["tone"]) => facts.filter((f) => f.tone === tone).length;
  const latest = facts
    .filter((f) => f.tone === "learned" || f.tone === "proposal")
    .toReversed()
    .slice(0, expanded ? 5 : 3);
  const legend: { tone: Pixel["tone"]; label: string; n: number }[] = [
    { tone: "memory", label: "remembered", n: count("memory") },
    { tone: "learned", label: "learned", n: count("learned") },
    { tone: "proposal", label: "to review", n: count("proposal") },
    { tone: "note", label: "notes", n: count("note") },
  ];

  return (
    <section aria-label="What it knows" className="px-2.5 pt-5 pb-1">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[15px] font-medium">What it knows</h3>
        {today > 0 && (
          <span className="ml-auto font-mono text-[11px] text-added tabular-nums">
            +{today} today
          </span>
        )}
      </div>
      <div className="mt-2.5">
        <PixelField pixels={pixels} live={working} slots={expanded ? 96 : 48} />
      </div>
      <ul aria-label="Kinds" className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {legend
          .filter((l) => l.n > 0)
          .map((l) => (
            <li
              key={l.tone}
              className="flex items-center gap-1.5 font-mono text-[11px] text-faint-foreground"
            >
              <span aria-hidden className={`size-1.5 rounded-[1px] ${toneDot[l.tone]}`} />
              <span className="text-muted-foreground tabular-nums">{l.n}</span> {l.label}
            </li>
          ))}
      </ul>
      {latest.length > 0 && (
        <ul aria-label="Lately" className="mt-3 flex flex-col border-l border-border pl-3">
          {latest.map((f) => (
            <li
              key={f.id}
              className={`flex items-baseline gap-2.5 py-1 text-[12.5px] ${fresh(f.at) ? "pixel-fade" : ""}`}
            >
              <span className="min-w-0 flex-1 truncate text-foreground/85">{f.title}</span>
              <span
                className={`shrink-0 font-mono text-[11px] ${f.tone === "proposal" ? "text-warning" : "text-faint-foreground"}`}
              >
                {f.tone === "proposal" ? "review" : age(f.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const toneDot: Record<Pixel["tone"], string> = {
  memory: "bg-foreground/55",
  note: "bg-foreground/30",
  learned: "bg-accent",
  proposal: "bg-warning",
};
