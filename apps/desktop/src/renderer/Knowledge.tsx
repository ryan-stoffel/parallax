import { BookOpen, ChevronLeft, Circle, FileText, TriangleAlert } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCallback, useState } from "react";

import type { AgentRun, ContextFile } from "../protocol/generated/protocol";
import { board, ContextReader, useContent, useProjectContext } from "./ContextPanel";
import { DoneMark } from "./AttentionMark";
import type { InboxView } from "./Inbox";
import { Loader } from "./Loader";
import { locale } from "./locale";
import { MemoryPanel, type Memory } from "./MemoryPanel";
import { MiniPrompt } from "./MiniPrompt";
import { age } from "./Sidebar";
import { IconButton } from "./ui";

// What counts as new: learned in the last day.
const freshMs = 24 * 60 * 60 * 1000;

/**
 * The side panel's Knowledge view: what a Project's agents know, in one list. A Project's opens on
 * where it stands, the coordinator's status board as a checklist, with a way to the Project's
 * context files; then what it knows, newest learned first, and Memory's brief, entries, and
 * proposals. A file opens in place, with memory kept behind it. At its foot a mini prompt changes
 * it in plain words; `expanded`, it centers in the window with a larger one. Off a Project it's
 * the repository's memory alone. `memory` is whether the host's plxd has `memory`; without it a
 * Project shows only its context. Key it by host and folder.
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
  /** Whether the panel fills the window. */
  expanded?: boolean;
}) {
  const { files, error } = useProjectContext(hostId, project ?? "", connected && !!project);
  const [memories, setMemories] = useState<readonly Memory[]>([]);
  const onFiles = useCallback((f: readonly Memory[]) => setMemories(f), []);
  const [browsing, setBrowsing] = useState(false);
  const [openPath, setOpenPath] = useState<string>();
  const open = files.find((f) => f.path === openPath);
  const notesFile = files.find((f) => f.path === board);
  const head = project && (
    <>
      <ProjectState
        hostId={hostId}
        project={project}
        file={notesFile}
        error={error}
        working={working}
        onFiles={files.length > 0 ? () => setBrowsing(true) : undefined}
      />
      <Known memories={memories} files={files} inbox={inbox} expanded={expanded} />
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
      {browsing && !open && (
        <ProjectFiles files={files} onOpen={setOpenPath} onBack={() => setBrowsing(false)} />
      )}
      <div hidden={!!open || browsing} className="flex min-h-0 flex-1 flex-col">
        {memory ? (
          <MemoryPanel
            hostId={hostId}
            project={project}
            repo={repo}
            start={head}
            footer={prompt || undefined}
            onFiles={onFiles}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">{head}</div>
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
  strong: ({ children }) => <>{children}</>,
  a: ({ children }) => <span className="underline underline-offset-2">{children}</span>,
  code: ({ children }) => (
    <code className="rounded bg-selected px-1 font-mono text-[11.5px]">{children}</code>
  ),
};

/** A board item split into its lead, "**Title**: detail", and the rest, when it has one. */
function splitItem(text: string): { lead: string; rest?: string } {
  const m = /^\*\*(.+?)\*\*:?\s*(.*)$/.exec(text);
  if (!m) return { lead: text };
  return { lead: m[1]!, rest: m[2] || undefined };
}

/**
 * Where the Project stands, from the coordinator's status board: a group a heading (Now, Next,
 * Risks), each item its lead and a line on it. Items under Now show as working, done ones checked,
 * and Risks with a warning. The book opens the Project's context files.
 */
function ProjectState({
  hostId,
  project,
  file,
  error,
  working,
  onFiles,
}: {
  hostId: string;
  project: string;
  file?: ContextFile;
  error?: string;
  working?: boolean;
  onFiles?: () => void;
}) {
  return (
    <section aria-label="Where it stands" className="px-2.5 pt-4">
      <div className="flex items-center gap-2">
        <h3 className="text-[15px] font-medium">Where it stands</h3>
        {file && (
          <span className="text-[12px] text-faint-foreground">updated {age(file.modifiedAt)}</span>
        )}
        {onFiles && (
          <span className="ml-auto">
            <IconButton label="Project files" onClick={onFiles}>
              <BookOpen />
            </IconButton>
          </span>
        )}
      </div>
      {file ? (
        <Board hostId={hostId} project={project} file={file} working={working} />
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

function Board({
  hostId,
  project,
  file,
  working,
}: {
  hostId: string;
  project: string;
  file: ContextFile;
  working?: boolean;
}) {
  const { content } = useContent(hostId, project, file);
  if (content === undefined) return null;
  const sections = boardSections(content);
  return (
    <div className="flex flex-col gap-4 pt-3">
      {sections.map((section) => {
        const risks = /risk|block/i.test(section.title);
        const now = /^(now|doing|in progress)/i.test(section.title);
        const done = section.items.filter((i) => i.done).length;
        return (
          <section key={section.title} aria-label={section.title}>
            <h4 className="flex items-baseline gap-2 pb-1.5 text-[12.5px] text-muted-foreground">
              {section.title}
              <span className="text-faint-foreground tabular-nums">
                {done > 0 ? `${done} of ${section.items.length} done` : section.items.length}
              </span>
            </h4>
            <ul className="flex flex-col gap-2.5">
              {section.items.map((item, i) => {
                const { lead, rest } = splitItem(item.text);
                return (
                  <li key={i} className="flex gap-2.5">
                    <span className="grid h-[18px] w-3.5 shrink-0 place-items-center [&_svg]:size-3.5">
                      {risks ? (
                        <TriangleAlert aria-hidden className="text-warning" />
                      ) : item.done ? (
                        <span className="text-added">
                          <DoneMark animate={false} />
                        </span>
                      ) : now && working ? (
                        <Loader kind="matrix" variant="ripple" size={11} />
                      ) : (
                        <Circle aria-hidden className="text-faint-foreground" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="sr-only">{item.done ? "Done: " : ""}</span>
                      <span
                        className={`block text-[13px] leading-[18px] ${item.done ? "text-muted-foreground" : "text-foreground"}`}
                      >
                        <Markdown remarkPlugins={[remarkGfm]} components={inline}>
                          {lead}
                        </Markdown>
                      </span>
                      {rest && (
                        <span className="mt-0.5 block text-[12.5px] leading-snug text-faint-foreground">
                          <Markdown remarkPlugins={[remarkGfm]} components={inline}>
                            {rest}
                          </Markdown>
                        </span>
                      )}
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
 * What the Project knows, at a glance: how much and how much is new today, then the few things its
 * agents learned last, newest first, before Memory's own list.
 */
function Known({
  memories,
  files,
  inbox,
  expanded,
}: {
  memories: readonly Memory[];
  files: readonly ContextFile[];
  inbox?: InboxView;
  expanded?: boolean;
}) {
  const now = Date.now();
  const fresh = (at: string) => now - Date.parse(at) < freshMs;
  const learned = (inbox?.items.filter((i) => i.kind === "learned") ?? []).toSorted((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const total = memories.length + files.length + learned.length;
  const today = [
    ...memories.map((m) => m.modifiedAt),
    ...files.map((f) => f.modifiedAt),
    ...learned.map((i) => i.createdAt),
  ].filter(fresh).length;

  return (
    <section aria-label="What it knows" className="px-2.5 pt-6 pb-1">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[15px] font-medium">What it knows</h3>
        {total > 0 && (
          <span className="text-[12px] text-faint-foreground tabular-nums">
            {total} {total === 1 ? "thing" : "things"}
            {today > 0 && <span className="text-added">, {today} new today</span>}
          </span>
        )}
      </div>
      {learned.length > 0 && (
        <ul aria-label="Learned lately" className="mt-2 flex flex-col">
          {learned.slice(0, expanded ? 5 : 3).map((i) => (
            <li
              key={i.id}
              className={`flex items-baseline gap-2.5 py-1 text-[13px] ${fresh(i.createdAt) ? "pixel-fade" : ""}`}
            >
              <span
                aria-hidden
                className="size-1.5 shrink-0 translate-y-[-2px] rounded-[1px] bg-accent"
              />
              <span className="min-w-0 flex-1 text-foreground/90">
                {i.text.replace(/^Memory: /, "")}
              </span>
              <span className="shrink-0 text-[11.5px] text-faint-foreground tabular-nums">
                {age(i.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** All of the Project's context files, the status board first, each opening in place. */
function ProjectFiles({
  files,
  onOpen,
  onBack,
}: {
  files: readonly ContextFile[];
  onOpen: (path: string) => void;
  onBack: () => void;
}) {
  const sorted = files.toSorted((a, b) =>
    a.path === board ? -1 : b.path === board ? 1 : a.path.localeCompare(b.path, locale()),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button
        type="button"
        onClick={onBack}
        className="mx-2 mt-1 flex items-center gap-1 self-start rounded-lg py-1 pr-2 pl-1 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground"
      >
        <ChevronLeft aria-hidden className="size-4" />
        Knowledge
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <h3 className="px-2.5 pt-3 pb-1 text-[15px] font-medium">Project files</h3>
        <p className="px-2.5 pb-2 text-[12.5px] text-muted-foreground">
          Notes the coordinator and agents keep for each other.
        </p>
        <ul>
          {sorted.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => onOpen(f.path)}
                className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-hover"
              >
                <FileText aria-hidden className="size-4 shrink-0 text-faint-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{f.path}</span>
                <span className="shrink-0 text-[11.5px] text-faint-foreground">
                  {age(f.modifiedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
