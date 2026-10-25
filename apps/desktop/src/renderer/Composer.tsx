import {
  ArrowUp,
  Brain,
  Cpu,
  FilePen,
  Hand,
  Image as ImageIcon,
  ListChecks,
  LockOpen,
  LoaderCircle,
  MessagesSquare,
  Paperclip,
  Sparkles,
  Square,
  SquareSlash,
  X,
  Zap,
} from "lucide-react";
import Blockquote from "@tiptap/extension-blockquote";
import Bold from "@tiptap/extension-bold";
import Code from "@tiptap/extension-code";
import CodeBlock from "@tiptap/extension-code-block";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Heading from "@tiptap/extension-heading";
import Italic from "@tiptap/extension-italic";
import {
  BulletList,
  ListItem,
  ListKeymap,
  OrderedList,
  TaskItem,
  TaskList,
} from "@tiptap/extension-list";
import Paragraph from "@tiptap/extension-paragraph";
import Strike from "@tiptap/extension-strike";
import Text from "@tiptap/extension-text";
import { Dropcursor, Gapcursor, UndoRedo } from "@tiptap/extensions";
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import {
  EditorContent,
  markInputRule,
  wrappingInputRule,
  type Mark,
  Node as TiptapNode,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  type Editor,
  type NodeViewProps,
} from "@tiptap/react";
import { defaultMarkdownSerializer, MarkdownSerializer } from "prosemirror-markdown";
import {
  createContext,
  Fragment as ReactFragment,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import type {
  AgentCommand,
  AgentEffort,
  AgentPermission,
  AgentRun,
  ProjectPermission,
  PromptImage,
} from "../protocol/generated/protocol";
import { lastPrompt } from "./attention";
import { sizeOf } from "./documents";
import type { ComposerContents } from "./drafts";
import { threadUsageOf, UsageRing } from "./ComposerUsage";
import type { RequestUsage, ThreadUsage } from "./transcript";
import { EffortMenu } from "./EffortMenu";
import { accessPrefs } from "./accessPrefs";
import { FileCard } from "./FileCard";
import { Chip, fileIcon, Mention } from "./Mention";
import { imageFromUrl, imageUrl, readImage, type ImageCaps } from "./images";
import { Lightbox } from "./Lightbox";
import { encodedImage, withFiles } from "./attachments";
import { uploadFiles, type UploadCaps } from "./uploads";
import { ModelMenu } from "./ModelMenu";
import { ScrollThumb } from "./ScrollThumb";
import { dismiss, notify } from "./notifications";
import { behaviorPrefs, newThreadPrefs } from "./prefs";
import { accessLevels } from "./catalog";
import { useCatalog, type Model, type Provider, type RunOptions } from "./models";
import { RepoIcon } from "./Sidebar";
import { lookOf, type AttachThreads } from "./threadContext";
import type { ThreadsState } from "./threads";
import { draggedThread, threadDragType } from "./threadDrag";
import { stored } from "./stored";
import { Picker, type PickerOption } from "./ui";

const access = (value: AgentPermission, icon: ReactNode): PickerOption => ({
  value,
  ...accessLevels[value],
  icon,
});

// The access levels (catalog.ts), each with its icon.
export const accessOptions: Record<AgentPermission, PickerOption> = {
  manual: access("manual", <Hand />),
  edit: access("edit", <FilePen />),
  auto: access("auto", <Sparkles />),
  plan: access("plan", <ListChecks />),
  bypass: access("bypass", <LockOpen />),
};

const divider = <span aria-hidden className="mx-1 h-5 w-px bg-border" />;

/** What the inline thread and image chips read to draw themselves: the attached images, and the
 * host's threads. */
const RefsContext = createContext<{ images: readonly PromptImage[]; threads?: ThreadsState }>({
  images: [],
});

// Each image's key, by identity, for its place in the text. A draft and a failed send's put-back
// keep the same image objects, so their chips find them again. Random, since a copied chip can
// outlive the app: a counter would start over and name another image.
const imageKeys = new WeakMap<PromptImage, string>();
function imageKey(image: PromptImage): string {
  let key = imageKeys.get(image);
  if (key === undefined) imageKeys.set(image, (key = crypto.randomUUID()));
  return key;
}

/** The inline nodes that stand for something attached, each drawn as a chip and deleted whole. */
const chipNodes = new Set(["mention", "threadRef", "imageRef"]);

/** An inline atom drawn by `view`, with `attrs` as its attributes. */
const chipNode = (
  name: string,
  attrs: Record<string, unknown>,
  view: (props: NodeViewProps) => ReactNode,
) =>
  TiptapNode.create({
    name,
    group: "inline",
    inline: true,
    atom: true,
    selectable: false,
    addAttributes: () =>
      Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { default: v }])),
    parseHTML: () => [
      {
        tag: `span[data-${name}]`,
        getAttrs: (el) =>
          Object.fromEntries(Object.keys(attrs).map((k) => [k, el.getAttribute(`data-${k}`)])),
      },
    ],
    // `data-plx-chip` marks the box's own chips on the clipboard, for paste.
    renderHTML: ({ node }) => [
      "span",
      {
        "data-plx-chip": name,
        [`data-${name}`]: "",
        ...Object.fromEntries(Object.keys(attrs).map((k) => [`data-${k}`, node.attrs[k]])),
      },
    ],
    addNodeView: () =>
      ReactNodeViewRenderer(
        (props: NodeViewProps) => (
          <NodeViewWrapper as="span" data-chip={name}>
            {view(props)}
          </NodeViewWrapper>
        ),
        { as: "span" },
      ),
  });

// A picked /skill or @file: one node, drawn as a chip and deleted whole, holding the token it sends.
const MentionNode = chipNode("mention", { token: "" }, ({ node }) => (
  <Mention token={node.attrs["token"] as string} />
)).extend({
  renderText: ({ node }) => node.attrs["token"] as string,
  // Backspace just after any chip takes it whole, which the browser does unreliably for an
  // uneditable span.
  addKeyboardShortcuts: () => ({
    Backspace: ({ editor }) => {
      const { empty, $from, from } = editor.state.selection;
      const before = $from.nodeBefore;
      if (!empty || !before || !chipNodes.has(before.type.name)) return false;
      return editor.commands.deleteRange({ from: from - before.nodeSize, to: from });
    },
  }),
});

/** An attached thread where it was picked: its project's icon, its title, and its provider. */
function ThreadRef({ runId, title }: { runId: string; title: string }) {
  const { threads } = useContext(RefsContext);
  const look = lookOf(threads, runId);
  const repoId = threads?.threads.find((t) => t.id === runId)?.repo;
  const repo = threads?.repos.find((r) => r.id === repoId);
  const shown = look.known ? look.title : title || look.title;
  // A chat bubble says it's a thread; its project and provider follow its title.
  return (
    <Chip
      tone="thread"
      title={`Thread: ${repo ? `${shown} · ${repo.name}` : shown}`}
      icon={<MessagesSquare aria-hidden className="text-muted-foreground" />}
      end={
        <>
          {repo && !repo.scratch && <RepoIcon repo={repo} />}
          <look.Logo aria-hidden />
        </>
      }
    >
      {shown}
    </Chip>
  );
}

// An attached thread in the text (PLX-378): sent as its title, `@"Title"`, beside its run id.
const ThreadRefNode = chipNode("threadRef", { runId: "", title: "" }, ({ node }) => (
  <ThreadRef runId={node.attrs["runId"] as string} title={node.attrs["title"] as string} />
));

/** A pasted image where it was pasted: its thumbnail, its number among the images, and its size. */
function ImageRef({ imageKey: key }: { imageKey: string }) {
  const { images } = useContext(RefsContext);
  const i = images.findIndex((image) => imageKey(image) === key);
  const image = images[i];
  return (
    <Chip
      tone="image"
      // Every 4 characters of base64 are 3 bytes.
      end={image && sizeOf(Math.floor((image.data.length * 3) / 4))}
      icon={
        image ? (
          <img src={imageUrl(image)} alt="" className="rounded-sm object-cover" />
        ) : (
          <ImageIcon />
        )
      }
    >
      {image ? `Image ${i + 1}` : "Removed image"}
    </Chip>
  );
}

// A pasted image's place in the text: sent as `[Image N]`, its number among the message's images.
// `src` is set only on the clipboard: the image as a data URL, so a copied prompt brings it along.
const ImageRefNode = chipNode("imageRef", { key: "", src: null }, ({ node }) => (
  <ImageRef imageKey={node.attrs["key"] as string} />
));

/** `fragment` with each image chip in it replaced by what `map` makes of it, or dropped for null. */
function mapImageRefs(
  fragment: Fragment,
  map: (node: ProseMirrorNode) => ProseMirrorNode | null,
): Fragment {
  const nodes: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    if (node.type.name === "imageRef") {
      const mapped = map(node);
      if (mapped) nodes.push(mapped);
    } else nodes.push(node.isLeaf ? node : node.copy(mapImageRefs(node.content, map)));
  });
  return Fragment.fromArray(nodes);
}

/** The run ids of the threads attached in `doc`, in order, once each. */
function threadsIn(doc: ProseMirrorNode): string[] {
  const ids: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "threadRef") ids.push(node.attrs["runId"] as string);
  });
  return [...new Set(ids)];
}

/**
 * A transaction turning each `@"Title"` in `state`'s text whose title `titled` knows into that
 * thread's chip, or undefined for none, such as a stopped prompt put back as text.
 */
function threadRefsIn(state: EditorState, titled: ReadonlyMap<string, string>) {
  const { tr } = state;
  state.doc.descendants((node, pos, parent) => {
    if (!node.isText || parent?.type.spec.code) return;
    for (const m of node.text!.matchAll(/@"([^"]*)"/g)) {
      const runId = titled.get(m[1]!);
      if (runId === undefined) continue;
      const from = pos + m.index;
      const chip = state.schema.nodes["threadRef"]!.create({ runId, title: m[1] });
      tr.replaceWith(tr.mapping.map(from), tr.mapping.map(from + m[0].length), chip);
    }
  });
  return tr.docChanged ? tr.setMeta("addToHistory", false) : undefined;
}

/**
 * A transaction removing every `name` node in `state` that `drop` picks, or undefined for none.
 * It isn't an undo step, so undo can't bring them back.
 */
function withoutNodes(state: EditorState, name: string, drop: (node: ProseMirrorNode) => boolean) {
  const { tr } = state;
  state.doc.descendants((node, pos) => {
    if (node.type.name !== name || !drop(node)) return;
    // With the space put in after it, so no double space is left.
    let end = pos + node.nodeSize;
    if (state.doc.textBetween(end, Math.min(end + 1, state.doc.content.size)) === " ") end++;
    tr.delete(tr.mapping.map(pos), tr.mapping.map(end));
  });
  return tr.docChanged ? tr.setMeta("addToHistory", false) : undefined;
}

/** `mark`, formatted as you type only by text that `find` matches. */
const typedAs = (mark: Mark, find: RegExp) =>
  mark.extend({
    addInputRules() {
      return [markInputRule({ find, type: this.type })];
    },
  });

// The box's editor: typed Markdown (`- `, `1. `, `[ ] `, ```` ``` ````, `> `, `#`, `**bold**`,
// `*italic*`, `~~struck~~`, `` `code` ``) formats as you type, as T3 Code's does. Nothing else
// rewrites what's typed: bold and italic come from `**` and `*` only, with no space just inside
// them (as in CommonMark), so `__init__`, `_private_`, and `a * b * c` stay as they are, and there's
// no `---` rule, so a diff's `--- a/file` stays text. Links and
// underline have no place in a prompt, and a trailing empty line after a list or code block would
// only add height. These are StarterKit's extensions in its order, listed one by one because
// StarterKit bundles the ones it disables too, Link and linkifyjs among them.
const extensions = [
  Blockquote,
  BulletList,
  Code,
  CodeBlock,
  Document,
  Dropcursor,
  Gapcursor,
  HardBreak,
  Heading,
  UndoRedo,
  ListItem,
  ListKeymap,
  OrderedList,
  // `[ ] ` or `[x] ` at a line's start, as GitHub's task lists.
  TaskList,
  TaskItem.extend({
    // Only `[ ]` or `[x]`: Tiptap's own also takes `[]`, as in `[] is an empty array`.
    addInputRules() {
      return [
        wrappingInputRule({
          find: /^\s*\[([ xX])\]\s$/,
          type: this.type,
          getAttributes: (match) => ({ checked: match[1] !== " " }),
        }),
      ];
    },
  }).configure({ nested: true }),
  Paragraph,
  // `~~struck~~`, with no space just inside, as bold and italic.
  typedAs(Strike, /(?:^|\s)(~~([^~\s](?:[^~]*[^~\s])?)~~)$/),
  Text,
  MentionNode,
  ThreadRefNode,
  ImageRefNode,
  typedAs(Bold, /(?:^|\s)(\*\*([^*\s](?:[^*]*[^*\s])?)\*\*)$/),
  typedAs(Italic, /(?:^|\s)(\*([^*\s](?:[^*]*[^*\s])?)\*)$/),
];

// What's sent is the box as Markdown. Text goes out as typed, unescaped, since the agent reads it
// raw: `foo_bar` and `<div>` stay as they are.
const { nodes, marks } = defaultMarkdownSerializer;
const markdown = new MarkdownSerializer(
  {
    // Paragraphs, headings, and quotes share the defaults' names.
    ...nodes,
    listItem: nodes["list_item"]!,
    bulletList: (state, node) => state.renderList(node, "  ", () => "- "),
    orderedList: (state, node) => {
      // Nested lines indent as far as the widest number reaches.
      const start = node.attrs["start"] as number;
      const width = `${start + node.childCount - 1}. `.length;
      state.renderList(node, " ".repeat(width), (i) => `${start + i}. `.padEnd(width));
    },
    codeBlock: (state, node) => {
      // A fence longer than any run of backticks in the code.
      const runs = node.textContent.match(/`{3,}/g) ?? [];
      const fence = "`".repeat(Math.max(2, ...runs.map((r) => r.length)) + 1);
      state.write(`${fence}${(node.attrs["language"] as string | null) ?? ""}\n`);
      state.text(node.textContent, false);
      state.ensureNewLine();
      state.write(fence);
      state.closeBlock(node);
    },
    taskList: (state, node) =>
      state.renderList(node, "  ", (i) => (node.child(i).attrs["checked"] ? "- [x] " : "- [ ] ")),
    taskItem: nodes["list_item"]!,
    hardBreak: (state) => state.write("\n"),
    mention: (state, node) => state.text(node.attrs["token"] as string, false),
    threadRef: (state, node) => state.text(`@"${node.attrs["title"] as string}"`, false),
    imageRef: (state, node) => {
      const name = (state.options as Naming).imageName?.(node.attrs["key"] as string);
      if (name) state.text(`[${name}]`, false);
    },
    text: (state, node) => state.text(node.text!, false),
  },
  {
    // So does inline code.
    ...marks,
    bold: marks["strong"]!,
    italic: marks["em"]!,
    strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
  },
);

// Lines typed with Shift+Enter are paragraphs, which Markdown would send a blank line apart. They
// go out a line apart, as typed: each run of them is joined into one, with line breaks.
function asLines(node: ProseMirrorNode): ProseMirrorNode {
  if (node.isTextblock) return node;
  const children: ProseMirrorNode[] = [];
  node.forEach((child) => {
    const last = children.at(-1);
    if (last?.type.name === "paragraph" && child.type.name === "paragraph") {
      const lineBreak = child.type.schema.nodes["hardBreak"]!.create();
      children[children.length - 1] = last.copy(
        last.content.addToEnd(lineBreak).append(child.content),
      );
    } else children.push(asLines(child));
  });
  return node.copy(Fragment.from(children));
}

/** How the text names what its chips stand for: a pasted image by its number among the images. */
interface Naming {
  imageName?: (key: string) => string | undefined;
}

const toMarkdown = (node: ProseMirrorNode, naming: Naming = {}) =>
  markdown.serialize(asLines(node), { tightLists: true, ...naming } as never);

// Whether copied HTML has text of its own, not just an image. A parsed document is inert: nothing
// in it runs or loads.
const hasText = (html: string) =>
  !!new DOMParser().parseFromString(html, "text/html").body.textContent?.trim();

// The most base64 one image can be: an even share of the total cap, so any number of them up to
// the most fits it.
const imageShare = ({ maxImages, maxImageBytes, maxTotalBytes }: ImageCaps) =>
  Math.min(maxImageBytes, Math.floor(maxTotalBytes / maxImages));

/** Supervised's description where its requests are denied, by why (`ComposerProps.manualDenied`). */
const manualDenials = {
  host: "Asks before edits and commands. This host's plxd can't show those requests, so they're denied.",
  run: "Asks before edits and commands. This chat started before Parallax could show those requests, so they're denied.",
};

/** What a `/` or `@` at the start of a word, up to the cursor, is typing: its kind, what follows
 * it, and where it is, for the menus. */
interface Trigger {
  kind: "/" | "@";
  query: string;
  from: number;
  to: number;
}

function triggerAt(editor: Editor): Trigger | undefined {
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.parent.type.spec.code) return undefined;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
  const match = /(?:^|\s)([/@])(\S*)$/.exec(before);
  if (!match) return undefined;
  const query = match[2]!;
  return { kind: match[1] as "/" | "@", query, from: $from.pos - query.length - 1, to: $from.pos };
}

/**
 * A transaction turning each `known` `/skill` or `@path` in `state`'s text into a mention, or
 * undefined if there's none. One that ends at the cursor is still being typed and stays text. It
 * isn't an undo step of its own, so undo takes back what was typed, nor an edit, so a recalled
 * prompt stays recalled for Up and Down.
 */
function mentionsIn(state: EditorState, known: (token: string) => boolean) {
  const { tr, selection } = state;
  state.doc.descendants((node, pos, parent) => {
    if (!node.isText || parent?.type.spec.code || node.marks.some((m) => m.type.spec.code)) return;
    for (const m of node.text!.matchAll(/(?<=^|\s)([/@]\S+)/g)) {
      const from = pos + m.index;
      const to = from + m[1]!.length;
      if (!known(m[1]!) || (selection.empty && selection.from === to)) continue;
      const mention = state.schema.nodes["mention"]!.create({ token: m[1] });
      tr.replaceWith(tr.mapping.map(from), tr.mapping.map(to), mention);
    }
  });
  return tr.docChanged ? tr.setMeta("addToHistory", false).setMeta("recall", true) : undefined;
}

/** `items` whose name starts with `query`, then those that only contain it, each in order. */
function byName<T>(items: T[], query: string, name: (item: T) => string): T[] {
  const q = query.toLowerCase();
  const starts = (item: T) => name(item).toLowerCase().startsWith(q);
  return [
    ...items.filter(starts),
    ...items.filter((item) => !starts(item) && name(item).toLowerCase().includes(q)),
  ];
}

/** The most files the `@` menu shows. */
const maxFiles = 50;

/** The most threads the `@` menu shows. */
const maxThreadRows = 6;
// The notification of why something wasn't attached, which the next one replaces.
const attachKey = "composer/attach";

/**
 * `paths` matching `query`: those whose file name starts with it, then those that contain it,
 * then those that have its letters in order, at most `maxFiles`.
 */
function matchPaths(paths: readonly string[], query: string): string[] {
  const q = query.toLowerCase();
  const rank = (path: string) => {
    const p = path.toLowerCase();
    if (p.slice(p.lastIndexOf("/") + 1).startsWith(q)) return 0;
    if (p.includes(q)) return 1;
    let i = 0;
    for (const c of p) if (c === q[i]) i++;
    return i === q.length ? 2 : 3;
  };
  return paths
    .map((path) => ({ path, rank: rank(path) }))
    .filter((p) => p.rank < 3)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, maxFiles)
    .map((p) => p.path);
}

/** The commands the composer's own controls take, which no CLI gets (PLX-359). */
const ownCommands = new Set(["model", "effort", "fast", "permissions"]);

// Each CLI's commands by host, backend, and folder, kept while the app runs, so reopening a thread
// doesn't start its CLI again. A failed fetch isn't kept, so the next `/` asks again.
const commandLists = new Map<string, Promise<AgentCommand[]>>();

/** The most command lists `savedCommands` keeps, the newest. */
const maxSavedLists = 30;

/**
 * The last command list each host, backend, and folder answered, kept on this computer, so a `/`
 * shows it at once, before this run of the app asks the CLI again.
 */
const savedCommands = stored<Record<string, AgentCommand[]>>(
  "parallax:commands",
  {},
  (raw, fallback) =>
    (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : fallback) as Record<
      string,
      AgentCommand[]
    >,
);

const commandsKeyOf = (hostId: string, backend: string, folder: string | undefined) =>
  `${hostId}/${backend}/${folder ?? ""}`;

/** The commands `agent/commands` lists for a thread on `backend`, once per host and folder. */
export function listCommands(
  hostId: string,
  backend: string,
  repo: string | undefined,
  runId: string | undefined,
): Promise<AgentCommand[]> {
  const key = commandsKeyOf(hostId, backend, runId ?? repo);
  let list = commandLists.get(key);
  if (!list) {
    list = window.parallax.request(hostId, "agent/commands", { backend, repo, runId }).then((r) => {
      if ("result" in r) {
        const { [key]: _, ...rest } = savedCommands.get();
        const kept = Object.entries(rest).slice(-(maxSavedLists - 1));
        savedCommands.set({ ...Object.fromEntries(kept), [key]: r.result.commands });
        return r.result.commands;
      }
      commandLists.delete(key);
      return [];
    });
    commandLists.set(key, list);
  }
  return list;
}

/** A row of the `/` or `@` menu, under its `group`'s heading. */
interface MenuEntry {
  key: string;
  label: string;
  description?: string;
  /** What the menu's footer says while the row is highlighted, such as a skill's whole description. */
  detail?: string;
  hint?: string;
  icon?: ReactNode;
  /** Where it comes from, at the row's end: a skill's plugin, or a thread's project. */
  badge?: ReactNode;
  /** Muted text at the row's end, such as how long ago a thread was prompted. */
  meta?: string;
  group: "Controls" | "Commands and skills" | "Threads" | "Files";
  pick: () => void;
}

/**
 * The host's threads for the `@` menu, best first. With nothing typed, its newest, as the sidebar
 * orders them. Otherwise those whose title starts with `query`, then has a word starting with it,
 * then contains it, then whose title and project hold every word of it, newest first within each,
 * then the ones `found` (`thread/search`, which reads their messages) that none of those caught. Archived threads only show for a query, after the rest.
 */
export function rankThreads(
  state: ThreadsState,
  query: string,
  found: readonly string[],
): string[] {
  const q = query.trim().toLowerCase();
  const newest = (a: (typeof state.threads)[number], b: (typeof state.threads)[number]) =>
    Number(!!a.archived) - Number(!!b.archived) ||
    Date.parse(lastPrompt(b)) - Date.parse(lastPrompt(a));
  if (!q)
    return state.threads
      .filter((t) => !t.archived)
      .sort(newest)
      .map((t) => t.id);
  const words = q.split(/\s+/);
  const repoNames = new Map(state.repos.map((r) => [r.id, r.name.toLowerCase()]));
  const rank = (t: (typeof state.threads)[number]) => {
    const title = (state.titles[t.id] ?? t.title ?? "").toLowerCase();
    if (title.startsWith(q)) return 0;
    if (title.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(q))) return 1;
    if (title.includes(q)) return 2;
    const both = `${title} ${repoNames.get(t.repo) ?? ""}`;
    return words.every((w) => both.includes(w)) ? 3 : 4;
  };
  const matched = state.threads
    .map((t) => ({ t, rank: rank(t) }))
    .filter((m) => m.rank < 4)
    .sort((a, b) => a.rank - b.rank || newest(a.t, b.t))
    .map((m) => m.t.id);
  return [...new Set([...matched, ...found])];
}

/** A plain item in the composer's tab, sized like the pickers that can sit beside it. */
export const tabItem =
  "flex min-w-0 items-center gap-1.5 px-2 py-1 text-body text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0";

/** A prompt for Stop to put back: its text and attached threads, then its images once they load. */
export interface Unanswered {
  text: string;
  images: () => Promise<PromptImage[]>;
  threads?: readonly string[];
}

export interface ComposerProps {
  /** Whether it starts a new thread, which only changes its hint. */
  newThread?: boolean;
  /**
   * Sends the text, images, and attached threads' run ids, with the chosen run options (empty
   * without `backend`). Resolves to an error message, which puts them back and shows in a
   * notification; `""` puts them back with no message. Absent: Send stays off.
   */
  onSend?: (
    text: string,
    options: RunOptions,
    images: PromptImage[],
    threads: string[],
  ) => Promise<string | undefined>;
  /** Sends as `onSend` does, for Cmd/Ctrl+Enter anywhere in the box: a new thread's background start. */
  onSendInBackground?: ComposerProps["onSend"];
  /** Cmd/Ctrl+Enter sends into the active turn instead of its queue. */
  onSteer?: ComposerProps["onSend"];
  /**
   * While set, an empty box shows Stop instead of Send. Resolves to an error message, which shows
   * in a notification.
   * Stop stays pending until the caller drops `onStop`, when the run stops. Esc in the box stops
   * too.
   */
  onStop?: () => Promise<string | undefined>;
  /** The run's latest prompt while nothing answers it yet, which a Stop that works puts back. */
  unanswered?: Unanswered;
  /** Why sending is off right now, shown in place of the box's hint. */
  disabledReason?: string;
  /** The tab tucked under the box: where the thread runs, or an open run's status. */
  tab?: ReactNode;
  /** What goes under the tab, such as a new thread's account chooser. */
  footer?: ReactNode;
  /**
   * The backend the thread runs on: shows the model, effort, and access choices it can honor. A
   * new thread passes it only when plxd takes run options. Absent (or unknown): no choices, and
   * none are sent. A new thread's model of another provider starts it on that provider's
   * subscription.
   */
  backend?: string;
  /**
   * An open run's model, effort, access, context window, and fast mode (an unset one is the CLI's
   * default). They start from the run's, and only one that differs from it is sent. Another
   * provider's model moves the run to that provider's subscription: all of them go, with the
   * account.
   */
  started?: Pick<AgentRun, "model" | "effort" | "permission" | "contextWindow" | "fast">;
  /** Whether the host's plxd takes a context window and fast mode (`contextAndFast`). */
  contextAndFast?: boolean;
  /**
   * The host the thread runs on, whose provider instances and models it offers (`useCatalog`).
   * Absent: the built-in ones.
   */
  hostId?: string;
  /** Whether the host is connected, so usage is refreshed only while reachable. */
  connected?: boolean;
  /** The latest request measurements, scoped to the open run's provider and account. */
  requestUsage?: RequestUsage;
  /** The open thread's token and cost totals, which the ring's card shows. */
  threadUsage?: ThreadUsage;
  /** The account actually charged for an open run, including automatic key fallback. */
  accountId?: string;
  /** Instances the thread can't run on, by why, whose models it doesn't offer: those an open run
   * can't move to, or a new thread can't start on. */
  unavailable?: Partial<Record<Provider, string>>;
  /** Why the model, effort, and access can't change right now, which turns them off. */
  optionsDisabled?: string;
  /** The host's image caps (`promptImages`). Absent: adding an image just says it can't take them. */
  imageCaps?: ImageCaps;
  /**
   * What the host's `host/upload` takes (`fileUploads`, 0071, and `fileChunks`, 0074): the most
   * bytes a file can be, and the size of the pieces a file goes in, whose progress its chip shows.
   * With `hostId`, each file and image is saved on the host when the message sends, and the
   * message lists its path for the agent. Absent: a file that isn't an image stays a chip that
   * isn't sent.
   */
  uploadBytes?: UploadCaps;
  /**
   * Why Supervised's requests are denied instead of coming to the chat (0031): the host's plxd lacks
   * `approvals`, or the open run started without them. Absent: they come as approval cards.
   */
  manualDenied?: keyof typeof manualDenials;
  /** No Access picker, and no permission sent: plxd's default applies (a Space's chats). */
  noAccess?: boolean;
  /**
   * The Project's permission mode, where plxd keeps one (0042): every run in the Project runs in
   * it, so it shows in place of Access, and no permission is sent.
   */
  projectMode?: ProjectPermission;
  /**
   * Text to add at the end of the box, which takes focus, such as a pull request's URL. Each new
   * value is added once.
   */
  insert?: string;
  /** The thread's earlier prompts, oldest first, which Up and Down recall into an empty box. */
  history?: readonly string[];
  /**
   * Where the `/` and `@` menus' lists come from, on a plxd with `composerMenus`: the host, and
   * the thread's run or repo entry, whose folder they're read in. The commands are the CLI's that
   * the message goes to, fetched on the first `/` and kept while the app runs; the files need a run
   * or repo, and are fetched again on each new `@`. Absent: no menus.
   */
  menus?: { hostId: string; repo?: string; runId?: string };
  /**
   * The host's threads, on a plxd with `threadContext` (0047): `@` lists them above the files, and
   * a sidebar row dropped on the box attaches one, as a chip in the text. Absent: neither.
   */
  attach?: AttachThreads;
  /** What the box starts with, such as a reopened draft (PLX-788). Read once, as it mounts. */
  initial?: ComposerContents;
  /** Kept up to date with what the box holds, for its screen to save as a draft as it closes. */
  contents?: RefObject<ComposerContents | undefined>;
}

/**
 * The prompt box, the same on every screen. It formats Markdown as you type and sends it as
 * Markdown text. Enter sends and Shift+Enter starts a new line (a new item, in a list); in a code
 * block Enter adds a line and Cmd/Ctrl+Enter sends. With `onSteer`, that press steers the active
 * turn. With `onSendInBackground`, Cmd/Ctrl+Enter sends
 * through it, anywhere in the box. Settings > General's send shortcut can make Cmd/Ctrl+Enter
 * send and Enter a new line everywhere; Cmd/Ctrl+Shift+Enter then steers or sends in the
 * background. It grows with its text up to seven lines, then scrolls.
 * Pasted, dropped, and picked images sit above the text as thumbnails and go beside it (PLX-193).
 * A pasted one also takes its place in the text as a chip, sent as `[Image N]`. Other files sit
 * below it as chips. With `uploadBytes`, both go to the host, their
 * paths listed after the text (PLX-779, PLX-799).
 * In an empty box, Up and Down step through `history`, until the recalled prompt is edited.
 * With `menus`, `/` at the start of a word opens a menu of the composer's own commands and the
 * CLI's commands and skills, and `@` one of the thread's files, filtered as you type. Up and Down
 * move through it, Enter or Tab picks, and Esc closes it.
 * With `attach`, `@` also lists the host's threads above the files: its newest, or the best matches
 * for what's typed (`rankThreads`). Picking one, or dropping a sidebar row on the box, attaches it
 * as a chip in the text, sent as `@"Title"` (PLX-378).
 */
export function Composer({
  newThread,
  onSend,
  onSendInBackground,
  onSteer,
  onStop,
  unanswered,
  disabledReason,
  tab,
  footer,
  backend,
  started,
  contextAndFast,
  hostId: host,
  connected = false,
  requestUsage,
  threadUsage,
  accountId,
  unavailable,
  optionsDisabled,
  imageCaps,
  uploadBytes,
  manualDenied,
  noAccess,
  projectMode,
  insert,
  history = [],
  menus,
  attach,
  initial,
  contents,
}: ComposerProps) {
  // The box as Markdown, kept on every edit.
  const [text, setText] = useState(initial?.text ?? "");
  const [stopping, setStopping] = useState(false);
  // Files that aren't images, shown as chips, and uploaded on send where the host takes them.
  const [files, setFiles] = useState<File[]>(initial?.files ?? []);
  const canUpload = !!host && !!uploadBytes;
  // While the files upload, before the message goes.
  const [uploading, setUploading] = useState(false);
  // The file going in pieces now, the share of it sent, and whether a piece failed.
  const [sending, setSending] = useState<{ file: File; share: number; failed?: boolean }>();
  const [images, setImages] = useState<PromptImage[]>(initial?.images ?? []);
  // The image shown large, kept by identity so images put back ahead of it don't change it.
  const [shown, setShown] = useState<PromptImage>();
  // Attached threads' run ids, as the text's thread chips have them, kept on every edit.
  const [threads, setThreads] = useState<string[]>(initial?.threads ?? []);
  // Why an image, file, or thread wasn't added, in a notification an add that takes clears.
  const setAttachError = (why?: string) =>
    why
      ? notify({ key: attachKey, tone: "error", title: "Couldn't attach that", body: why })
      : dismiss(attachKey);
  // Whether a sidebar row is dragged over the box, which outlines it.
  const [threadOver, setThreadOver] = useState(false);
  const filePicker = useRef<HTMLInputElement>(null);
  // Which of `history` the box holds, unedited.
  const recalled = useRef<number>(undefined);
  const [pickedModel, setModel] = useState<Model>();
  const [pickedEffort, setEffort] = useState<AgentEffort>();
  const [pickedPermission, setPermission] = useState<AgentPermission>();
  const [pickedContext, setContext] = useState<number>();
  const [pickedFast, setFast] = useState<boolean>();
  // A new thread's composer starts from Settings > General's defaults. A Project's coordinator
  // chat keeps its coordinator's backend, so it doesn't.
  const defaults = newThreadPrefs.use();
  const fresh = !started && !!newThread;
  // What `backend` can honor: another backend's pick falls back to its first model and `edit`.
  const catalog = useCatalog(host);
  const instanceOf = (id: string | undefined) => catalog.instances.find((i) => i.id === id);
  const run = instanceOf(backend);
  const runModels = catalog.models.filter((m) => m.provider === run?.id);
  // Instances turned off in Settings, but an open run's own, which it keeps.
  const blocked: Partial<Record<Provider, string>> = { ...unavailable };
  for (const i of catalog.instances)
    if (!i.enabled && !(started && i === run))
      blocked[i.id] ??= `${i.name} is turned off in Settings > Providers.`;
  // Any instance whose models aren't unavailable: an open run moves to it, a new thread starts there.
  const choices = catalog.models.filter((m) => !blocked[m.provider]);
  // An open run's model, which may be one this list doesn't know, or the CLI's default.
  const startedModel =
    started &&
    run &&
    (runModels.find((m) => m.id === started.model) ?? {
      id: started.model ?? "",
      name: started.model ?? "Default model",
      provider: run.id,
      contexts: [],
    });
  // A pick is kept by its instance and id, since the catalog's models are made again as it changes.
  const defaultModel = !fresh
    ? undefined
    : choices.find((m) => m.provider === defaults.model?.provider && m.id === defaults.model.id);
  const model =
    choices.find((m) => m.provider === pickedModel?.provider && m.id === pickedModel.id) ??
    startedModel ??
    defaultModel ??
    runModels.find((m) => choices.includes(m)) ??
    choices[0];
  // Where the message goes: the run's backend, or the instance that runs the picked model.
  const target = run && model && model.provider !== run.id ? model.provider : backend;
  const targetBackend = instanceOf(target);
  // Plan is legacy: listed only when Settings turns it on, or the thread already started in it.
  const legacyPlan = accessPrefs.use().legacyPlan;
  // A Project's mode isn't a choice here.
  const permissions =
    projectMode || noAccess
      ? []
      : (targetBackend?.permissions ?? []).filter(
          (p) => p !== "plan" || legacyPlan || started?.permission === "plan",
        );
  // A backend that maps no efforts (Cursor) gets none, and shows no effort menu.
  const efforts = targetBackend?.efforts !== false;
  const startedEffort = started?.effort ?? (fresh ? defaults.effort : "high");
  const startedPermission = started?.permission ?? (fresh ? defaults.permission : "edit");
  const effort = pickedEffort ?? startedEffort;
  const wanted = pickedPermission ?? startedPermission;
  const permission = permissions.includes(wanted) ? wanted : "edit";
  // The model's context windows and fast mode, on a plxd that takes them. One the model doesn't
  // offer falls back to its default, and fast mode to off.
  const contexts = (contextAndFast && model?.contexts) || [];
  const startedContext =
    started?.contextWindow ?? (fresh ? defaults.context : startedModel?.contexts[0]);
  const wantedContext = pickedContext ?? startedContext;
  const context =
    wantedContext !== undefined && contexts.includes(wantedContext) ? wantedContext : contexts[0];
  const hasFast = !!contextAndFast && !!model?.fast;
  const startedFast = started?.fast ?? (fresh ? defaults.fast : false);
  const fast = hasFast && (pickedFast ?? startedFast);
  const account = { kind: "subscription", backend: target! } as const;
  // The open thread's usage, for the ring. Its latest request's measurements show only while its
  // provider, account, model, and context window are still picked.
  const usage = threadUsageOf({
    connected,
    backend: target,
    kind: targetBackend?.kind,
    accountId: target === backend ? (accountId ?? target) : target,
    usage:
      target === backend && model?.id === startedModel?.id && context === startedContext
        ? requestUsage
        : undefined,
    totals: threadUsage,
  });
  let options: RunOptions = {};
  // A started run sends only what changed, unless the message goes to another instance.
  if (run && started && target === backend)
    options = {
      ...(model?.id && model !== startedModel && { model: model.id }),
      ...(efforts && effort !== startedEffort && { effort }),
      ...(permission !== startedPermission && { permission }),
      ...(context !== undefined && context !== startedContext && { contextWindow: context }),
      ...(hasFast && fast !== startedFast && { fast }),
    };
  else if (run)
    options = {
      ...(model?.id && { model: model.id }),
      ...(efforts && { effort }),
      permission,
      ...(context !== undefined && { contextWindow: context }),
      ...(hasFast && { fast }),
      ...(target !== backend && { account }),
    };
  if (projectMode || noAccess) delete options.permission;
  // The `/` and `@` menus: what's typed, the lists, and the highlighted row. Esc closes the menu
  // until its `/` or `@` goes.
  const [trigger, setTrigger] = useState<Trigger>();
  const [closedAt, setClosedAt] = useState<number>();
  const [active, setActive] = useState(0);
  // Each list with what it was fetched for, so a list for another backend or folder isn't shown.
  const [commands, setCommands] = useState<{ key: string; list: AgentCommand[] }>();
  const [paths, setPaths] = useState<{ key: string; list: string[] }>();
  const controls = useRef<HTMLFieldSetElement>(null);
  const menuId = useId();
  const { hostId, repo, runId } = menus ?? {};
  const folder = runId ?? repo ?? "";
  const commandsKey =
    hostId === undefined || target === undefined
      ? undefined
      : commandsKeyOf(hostId, target, folder);
  const pathsKey = hostId === undefined || !folder ? undefined : `${hostId}/${folder}`;
  // The list this computer last got shows at once (`savedCommands`), while the first `/` asks the
  // CLI again. Not before: listing commands starts the CLI.
  const saved = commandsKey === undefined ? undefined : savedCommands.get()[commandsKey];
  const wantsCommands = trigger?.kind === "/" && commandsKey !== undefined;
  const wantsPaths = trigger?.kind === "@" && pathsKey !== undefined;
  useEffect(() => {
    if (!wantsCommands || hostId === undefined || target === undefined) return;
    let live = true;
    void listCommands(hostId, target, repo, runId).then(
      (list) => live && setCommands({ key: commandsKey, list }),
    );
    return () => {
      live = false;
    };
  }, [wantsCommands, commandsKey, hostId, target, repo, runId]);
  // Each new `@` lists them again, so files the agent made show up; the last list shows meanwhile.
  const pathsAt = wantsPaths ? trigger.from : undefined;
  useEffect(() => {
    if (pathsAt === undefined || hostId === undefined || pathsKey === undefined) return;
    let live = true;
    void window.parallax
      .request(hostId, "repo/files", { repo, runId })
      .then((r) => live && setPaths({ key: pathsKey, list: "result" in r ? r.result.files : [] }));
    return () => {
      live = false;
    };
  }, [pathsAt, pathsKey, hostId, repo, runId]);
  const loadedCommands = commands && commands.key === commandsKey ? commands.list : saved;
  const loadedPaths = paths && paths.key === pathsKey ? paths.list : undefined;
  // The threads `thread/search` found by their messages for what's typed after `@`, and for what.
  const [searched, setSearched] = useState<{ query: string; ids: string[] }>();
  const threadHost = attach?.hostId;
  const search = trigger?.kind === "@" ? trigger.query.trim() : undefined;
  useEffect(() => {
    if (threadHost === undefined || !search) return;
    let live = true;
    void window.parallax.request(threadHost, "thread/search", { query: search }).then(
      (r) =>
        live &&
        setSearched({
          query: search,
          ids: "result" in r ? r.result.threads.map((t) => t.id) : [],
        }),
    );
    return () => {
      live = false;
    };
  }, [threadHost, search]);
  // Takes thread chips past the host's cap out of the text, the last ones first, saying why.
  const keepThreadCap = () => {
    const max = attach?.max ?? 0;
    let seen = 0;
    const tr = withoutNodes(editor.state, "threadRef", () => ++seen > max);
    if (!tr) return;
    editor.view.dispatch(tr);
    setAttachError(`A message takes at most ${max} attached threads.`);
  };

  // Puts threads in the text as chips, at `range` (the cursor by default), each once, up to the
  // host's cap, but never the open thread itself.
  const addThreads = (ids: readonly string[], range?: { from: number; to: number }) => {
    const had = threadsIn(editor.state.doc);
    const fresh = [...new Set(ids)].filter((id) => id !== attach?.self && !had.includes(id));
    const max = attach?.max ?? 0;
    const room = Math.max(0, max - had.length);
    setAttachError(
      fresh.length > room ? `A message takes at most ${max} attached threads.` : undefined,
    );
    // A space apart from a word just before them.
    const at = range?.from ?? editor.state.selection.from;
    const before = editor.state.doc.textBetween(Math.max(0, at - 1), at, undefined, "\ufffc");
    const chips = [
      ...(before && !/\s/.test(before) ? [{ type: "text", text: " " }] : []),
      ...fresh.slice(0, room).flatMap((runId) => [
        { type: "threadRef", attrs: { runId, title: lookOf(attach?.state, runId).title } },
        { type: "text", text: " " },
      ]),
    ];
    const chain = editor.chain().focus();
    if (fresh.length === 0 || room === 0) {
      if (range) chain.deleteRange(range).run();
      return;
    }
    (range ? chain.insertContentAt(range, chips) : chain.insertContent(chips)).run();
  };

  // Puts `text` where the trigger is, as typed text, which Markdown leaves alone.
  const replaceTrigger = (at: Trigger, text: string) =>
    editor
      .chain()
      .focus()
      .command(({ tr }) => !!tr.insertText(text, at.from, at.to))
      .run();
  // The composer's own controls, as commands where they're shown and can change.
  const openControl = (label: string) =>
    controls.current?.querySelector<HTMLButtonElement>(`[aria-label^="${label}"]`)?.click();
  const own =
    !run || optionsDisabled
      ? []
      : [
          model && {
            name: "model",
            description: "Pick the model",
            icon: <Cpu />,
            act: () => openControl("Model:"),
          },
          efforts && {
            name: "effort",
            description: "Set the reasoning effort",
            icon: <Brain />,
            act: () => openControl("Reasoning effort:"),
          },
          efforts &&
            hasFast && {
              name: "fast",
              description: fast ? "Turn fast mode off" : "Turn fast mode on",
              icon: <Zap />,
              act: () => setFast(!fast),
            },
          permissions.length > 1 && {
            name: "permissions",
            description: "Choose what it may do without asking",
            icon: <LockOpen />,
            act: () => openControl("Access:"),
          },
        ].filter((c) => !!c);
  let entries: MenuEntry[] = [];
  if (trigger?.kind === "/")
    entries = [
      ...byName(own, trigger.query, (c) => c.name).map((c): MenuEntry => ({
        key: `own:${c.name}`,
        label: `/${c.name}`,
        description: c.description,
        detail: c.description,
        icon: c.icon,
        group: "Controls",
        pick: () => {
          replaceTrigger(trigger, "");
          c.act();
        },
      })),
      ...byName(
        (loadedCommands ?? []).filter((c) => !ownCommands.has(c.name)),
        trigger.query,
        (c) => c.name,
      ).map((c, i): MenuEntry => {
        // A plugin's skill, `plugin:name`, shows its plugin as a badge.
        const at = c.name.lastIndexOf(":");
        return {
          // Two scopes can each have a skill of the same name.
          key: `${i}:${c.text}`,
          label: `${c.text[0]}${c.name.slice(at + 1)}`,
          description: c.description,
          detail: c.description,
          hint: c.argumentHint,
          icon: <SquareSlash />,
          badge: at > 0 ? c.name.slice(0, at) : undefined,
          group: "Commands and skills",
          pick: () => replaceTrigger(trigger, `${c.text} `),
        };
      }),
    ];
  else if (trigger?.kind === "@") {
    const ids = attach
      ? rankThreads(
          attach.state,
          trigger.query,
          searched && searched.query === search ? searched.ids : [],
        ).filter((id) => id !== attach.self && !threads.includes(id))
      : [];
    const threadRows = ids.slice(0, maxThreadRows).map((id): MenuEntry => {
      const look = lookOf(attach?.state, id);
      const thread = attach?.state.threads.find((t) => t.id === id);
      const repo = attach?.state.repos.find((r) => r.id === thread?.repo);
      return {
        key: `thread:${id}`,
        label: look.title,
        icon: <look.Logo aria-hidden />,
        badge: repo && !repo.scratch && (
          <>
            <RepoIcon repo={repo} />
            {repo.name}
          </>
        ),
        detail: repo?.path,
        meta: look.age,
        group: "Threads",
        pick: () => addThreads([id], trigger),
      };
    });
    const fileRows = matchPaths(loadedPaths ?? [], trigger.query).map((path): MenuEntry => {
      const slash = path.lastIndexOf("/");
      return {
        key: path,
        label: path.slice(slash + 1),
        description: slash > 0 ? path.slice(0, slash) : undefined,
        detail: path,
        icon: fileIcon(path),
        group: "Files",
        pick: () => replaceTrigger(trigger, `@${path} `),
      };
    });
    entries = [...threadRows, ...fileRows];
  }
  // What the menu still waits for, shown as a row of its own.
  const loading =
    (wantsCommands && !loadedCommands && "Loading commands…") ||
    (wantsPaths && !loadedPaths && "Loading files…") ||
    undefined;
  const menuOpen =
    !!menus && !!trigger && trigger.from !== closedAt && (entries.length > 0 || !!loading);
  const highlighted = Math.min(active, entries.length - 1);
  // Opens below the box when a tall prompt leaves no room for it above (its list, footer, and margin).
  const box = useRef<HTMLFormElement>(null);
  // The text's area, whose editor `ScrollThumb` scrolls.
  const textArea = useRef<HTMLDivElement>(null);
  const editorDom = useCallback(
    () => textArea.current?.querySelector<HTMLElement>(".composer-input"),
    [],
  );
  const menuList = useRef<HTMLDivElement>(null);
  const menuDom = useCallback(() => menuList.current, []);
  const [menuBelow, setMenuBelow] = useState(false);
  useLayoutEffect(() => {
    if (menuOpen) setMenuBelow(box.current!.getBoundingClientRect().top < 360);
  });
  useEffect(() => {
    document.getElementById(`${menuId}-${highlighted}`)?.scrollIntoView?.({ block: "nearest" });
  }, [menuId, highlighted, menuOpen]);

  // The run stopped (or never ran), so a later run's Stop starts fresh.
  if (stopping && !onStop) setStopping(false);
  const empty = text.trim() === "" && images.length === 0 && (!canUpload || files.length === 0);
  const canSend = !!onSend && !disabledReason && !empty && !uploading;
  const showStop = !!onStop && !disabledReason && empty;

  // Adds pasted, dropped, or picked files: images as thumbnails, anything else as a chip.
  const addFiles = async (added: File[]): Promise<PromptImage[]> => {
    const isImage = (f: File) => f.type.startsWith("image/");
    const others = added.filter((f) => !isImage(f));
    const fits = (f: File) => !host || !uploadBytes || f.size <= uploadBytes.maxBytes;
    setFiles((all) => [...all, ...others.filter(fits)]);
    const tooLarge = others.find((f) => !fits(f));
    const picked = added.filter(isImage);
    setAttachError(
      tooLarge &&
        `${tooLarge.name} is larger than ${sizeOf(uploadBytes!.maxBytes)}, the most a file can be.`,
    );
    if (picked.length === 0) return [];
    if (!imageCaps) {
      setAttachError("This host's plxd can't take images.");
      return [];
    }
    const { maxImages } = imageCaps;
    const room = Math.max(0, maxImages - images.length);
    const share = imageShare(imageCaps);
    const read = await Promise.all(picked.slice(0, room).map((f) => readImage(f, share)));
    const errors = read.filter((r) => typeof r === "string");
    if (picked.length > room) errors.push(`A message takes at most ${maxImages} images.`);
    setAttachError(errors[0]);
    const ok = read.filter((r) => typeof r !== "string");
    setImages((all) => [...all, ...ok].slice(0, maxImages));
    return ok;
  };

  // Removes image `i`, and its place in the text unless the same image is attached again.
  const removeImage = (i: number) => {
    const key = imageKey(images[i]!);
    const left = images.filter((_, j) => j !== i);
    setImages(left);
    if (left.some((image) => imageKey(image) === key)) return;
    const tr = withoutNodes(editor.state, "imageRef", (node) => node.attrs["key"] === key);
    if (tr) editor.view.dispatch(tr);
  };
  // Each image's name in the sent text, by its number among the images.
  const imageName = (key: string) => {
    const i = images.findIndex((image) => imageKey(image) === key);
    return i < 0 ? undefined : `Image ${i + 1}`;
  };

  const submit = async (background = false, steer = false) => {
    if (!canSend) return;
    const sent = editor.getJSON();
    const sentFiles = canUpload ? files : [];
    const sentImages = images;
    // Only the host's own, never the open thread: undo can bring back a chip from before the box
    // changed computer, and a paste can bring the open thread's own.
    const sentThreads = threads.filter(
      (id) => id !== attach?.self && attach?.state.threads.some((t) => t.id === id),
    );
    // Without the space a chip leaves after itself at the end.
    let sentText = toMarkdown(editor.state.doc, { imageName }).replace(/[ \t]+$/, "");
    // Images too, so the agent has each as a file as well as seeing it (PLX-799).
    const uploads = canUpload
      ? [...sentFiles, ...sentImages.map((image, i) => encodedImage(image, i + 1))]
      : [];
    if (uploads.length > 0) {
      // Nothing typed meanwhile, which the box clears once they're saved.
      setUploading(true);
      editor.setEditable(false);
      const paths = await uploadFiles(host!, uploads, uploadBytes?.chunkBytes, (file, share) =>
        setSending({ file, share }),
      ).catch((error: unknown) => `A file couldn't be read: ${String(error)}`);
      if (!editor.isDestroyed) editor.setEditable(true);
      setUploading(false);
      // A file that stopped partway keeps its bar, marked failed (PLX-835).
      setSending((s) =>
        typeof paths === "string" && s && s.share < 1 ? { ...s, failed: true } : undefined,
      );
      if (typeof paths === "string")
        return notify({ tone: "error", title: "Couldn't upload the files", body: paths });
      sentText = withFiles(sentText, paths);
    }
    editor.commands.clearContent();
    // Only what's sent: images added during an upload stay.
    setImages((all) => all.filter((i) => !sentImages.includes(i)));
    setAttachError(undefined);
    const failed = await (steer ? onSteer! : background ? onSendInBackground! : onSend)(
      sentText,
      options,
      sentImages,
      sentThreads,
    );
    if (failed === undefined) setFiles((all) => all.filter((f) => !sentFiles.includes(f)));
    else if (!editor.isDestroyed) {
      // Put it back ahead of anything typed or added while it was in flight.
      const typed = editor.isEmpty ? [] : (editor.getJSON().content ?? []);
      editor.commands.setContent({ ...sent, content: [...(sent.content ?? []), ...typed] });
      keepThreadCap();
      setImages((added) => [...sentImages, ...added].slice(0, imageCaps?.maxImages));
      if (failed) notify({ tone: "error", title: "Couldn't send the message", body: failed });
    }
  };

  const stop = async () => {
    const back = unanswered;
    setStopping(true);
    const failed = await onStop?.();
    if (failed) {
      setStopping(false);
      notify({ tone: "error", title: "Couldn't stop the thread", body: failed });
    } else if (back && !editor.isDestroyed) {
      // Back ahead of anything typed meanwhile, as plain lines: they send as the same Markdown.
      // ponytail: its formatting shows as typed Markdown, until the box parses Markdown.
      editor.commands.focus("start");
      editor.view.pasteText(editor.isEmpty ? back.text : `${back.text}\n`);
      if (attach && back.threads?.length) {
        // Each thread the text names as `@"Title"` becomes its chip again, and any it doesn't
        // name goes in at the cursor.
        const titled = new Map(back.threads.map((id) => [lookOf(attach.state, id).title, id]));
        const tr = threadRefsIn(editor.state, titled);
        if (tr) editor.view.dispatch(tr);
        const named = threadsIn(editor.state.doc);
        addThreads(back.threads.filter((id) => !named.includes(id)));
        keepThreadCap();
      }
      void back
        .images()
        .then((images) =>
          setImages((added) => [...images, ...added].slice(0, imageCaps?.maxImages)),
        );
    }
  };

  const placeholder =
    disabledReason ??
    (newThread
      ? "Build a feature, fix a bug, paste an image, use /skills, @files or threads"
      : "Reply, add detail, or steer what it does next");
  // A known /skill, or an @ naming one of the thread's files, becomes a chip.
  const known = (token: string) =>
    token[0] === "/"
      ? !!loadedCommands?.some((c) => c.text === token)
      : !!loadedPaths?.includes(token.slice(1));
  // Its props are read again on every render, so its handlers see this render's state.
  const editor: Editor = useEditor({
    extensions,
    content: initial?.doc,
    // Pasted text arrives as typed, never reformatted.
    enablePasteRules: false,
    onUpdate: ({ editor, transaction }) => {
      if (!transaction.getMeta("recall")) recalled.current = undefined;
      setText(toMarkdown(editor.state.doc, { imageName }));
      const ids = threadsIn(editor.state.doc);
      setThreads(ids);
      // A paste can bring more threads than a message takes.
      if (attach && ids.length > attach.max) keepThreadCap();
      const mentions = mentionsIn(editor.state, known);
      if (mentions) editor.view.dispatch(mentions);
    },
    onSelectionUpdate: ({ editor }) => {
      const at = triggerAt(editor);
      setTrigger(at);
      setActive(0);
      if (!at) setClosedAt(undefined);
    },
    editorProps: {
      // All of them, since these replace Tiptap's own (its role too) once props change.
      attributes: {
        id: "composer-input",
        role: "textbox",
        "aria-label": "Message",
        "aria-multiline": "true",
        "aria-placeholder": placeholder,
        "aria-autocomplete": "list",
        "aria-expanded": String(menuOpen),
        ...(menuOpen &&
          entries.length > 0 && {
            "aria-controls": menuId,
            "aria-activedescendant": `${menuId}-${highlighted}`,
          }),
        // It grows from three rows up to seven, then scrolls, with `ScrollThumb` for a scrollbar.
        // Its parent is anchored below it, so it grows upward.
        class:
          "composer-input markdown block max-h-[min(40vh,calc(11.375em+1.125rem))] min-h-[calc(4.875em+1.125rem)] overflow-y-auto px-5 pt-4.5 focus-visible:outline-none",
      },
      handleKeyDown: (view, event): boolean => {
        const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
        if (menuOpen && plain && !event.isComposing) {
          const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
          if (event.key === "Escape") setClosedAt(trigger.from);
          // Only a loading row: the keys do what they do without a menu.
          else if (entries.length === 0) return false;
          else if (step) setActive((highlighted + step + entries.length) % entries.length);
          else if (event.key === "Enter" || event.key === "Tab") entries[highlighted]!.pick();
          else return false;
          return true;
        }
        if ((event.key === "ArrowUp" || event.key === "ArrowDown") && plain) {
          const at = recalled.current;
          if (at === undefined && !(event.key === "ArrowUp" && editor.isEmpty && history.length))
            return false;
          // Up stops at the oldest, and Down past the newest empties the box.
          const next = Math.max(0, (at ?? history.length) + (event.key === "ArrowUp" ? -1 : 1));
          recalled.current = next < history.length ? next : undefined;
          // A paragraph a line, as pasted text is, with the cursor at its end.
          const lines = (history[next] ?? "").split("\n").map((line) => ({
            type: "paragraph",
            ...(line && { content: [{ type: "text", text: line }] }),
          }));
          editor
            .chain()
            .setMeta("recall", true)
            .setContent(next < history.length ? { type: "doc", content: lines } : "")
            .focus("end")
            .run();
          return true;
        }
        if (event.key === "Escape" && showStop && !stopping && !event.isComposing) {
          void stop();
          return true;
        }
        if (event.key !== "Enter" || event.isComposing) return false;
        const inCode = editor.isActive("codeBlock");
        const mod = event.metaKey || event.ctrlKey;
        // Settings > General: Cmd/Ctrl+Enter sends and Enter is a new line. Its background start
        // and steer then take Cmd/Ctrl+Shift+Enter.
        const modEnter = behaviorPrefs.get().sendKey === "modEnter";
        const alt = mod && (!modEnter || event.shiftKey);
        if (inCode || modEnter ? mod : !event.shiftKey) {
          void submit(!!onSendInBackground && alt, !!onSteer && alt);
          return true;
        }
        // Shift+Enter does what Enter does in other editors: a new line, list item, or line of
        // code, or out of an empty list item. A line of just ``` or ```lang starts a code block,
        // as ``` and a space does.
        return (
          (event.shiftKey || modEnter) &&
          editor.commands.first(({ commands }) => [
            () => commands.newlineInCode(),
            ({ state }) => {
              const { $from } = state.selection;
              const fence = /^```([a-z]*)$/.exec($from.parent.textContent);
              return (
                !!fence &&
                commands.deleteRange({ from: $from.start(), to: $from.end() }) &&
                commands.setCodeBlock(fence[1] ? { language: fence[1] } : undefined)
              );
            },
            () => commands.splitListItem("listItem"),
            () => commands.splitListItem("taskItem"),
            () => commands.liftEmptyBlock(),
            () => commands.splitBlock(),
          ])
        );
      },
      // Paste takes files (a screenshot, a copied image) above the text, with a chip for each
      // image where it was pasted, so a copied file's name or an image's URL never lands in it.
      // What was copied from the box itself pastes as it was, chips and formatting included. Text copied from an app (Office, Notes, a web page)
      // can carry a picture of itself too: when its HTML has text of its own, it's text. Text is
      // plain only, so nothing brings in its source's styling. Anything else falls through to the
      // editor, which drops it.
      handleDOMEvents: {
        paste: (view, event) => {
          const data = event.clipboardData;
          const text = data?.getData("text/plain");
          const html = data?.getData("text/html");
          // Chips copied or cut from a box like this one: the editor reads its own HTML back, so
          // they stay chips. Only the box's own chips are marked, so a copy from another editor
          // (Linear's, with its links) still pastes as its plain text.
          if (html?.includes("data-plx-chip")) return false;
          let files = [...(data?.files ?? [])];
          if (files.length > 0 && text && html && hasText(html)) files = [];
          if (files.length === 0 && !text) return false;
          event.preventDefault();
          if (files.length > 0)
            // Each pasted image also takes its place in the text, where it was pasted.
            void addFiles(files).then((added) => {
              if (added.length === 0 || editor.isDestroyed) return;
              editor
                .chain()
                .focus()
                .insertContent(
                  added.flatMap((image) => [
                    { type: "imageRef", attrs: { key: imageKey(image) } },
                    { type: "text", text: " " },
                  ]),
                )
                .run();
            });
          else view.pasteText(text!);
          return true;
        },
      },
      // Copy and cut give the selection's Markdown as its text, so pasting it back sends the same,
      // an image chip named as it's sent.
      // Within one line or code block, that's just its text (with any inline Markdown), not the
      // block's markers or fences.
      clipboardTextSerializer: (slice, view) => {
        const { selection, schema } = view.state;
        const { $from, $to } = selection;
        const content =
          $from.sameParent($to) && $from.parent.isTextblock
            ? schema.nodes["paragraph"]!.create(
                null,
                $from.parent.slice($from.parentOffset, $to.parentOffset).content,
              )
            : slice.content;
        return toMarkdown(schema.topNodeType.create(null, content), { imageName });
      },
      // A copied image chip carries its image, so the prompt pastes whole into another box.
      transformCopied: (slice) =>
        new Slice(
          mapImageRefs(slice.content, (node) => {
            const image = images.find((i) => imageKey(i) === node.attrs["key"]);
            return image ? node.type.create({ ...node.attrs, src: imageUrl(image) }) : node;
          }),
          slice.openStart,
          slice.openEnd,
        ),
      // A pasted image chip whose image isn't attached here brings it, as long as it's one plxd
      // takes and there's room for it; one already here is the same image again.
      transformPasted: (slice) => {
        const added: PromptImage[] = [];
        let refused: string | undefined;
        const content = mapImageRefs(slice.content, (node) => {
          const here = images.find((i) => imageKey(i) === node.attrs["key"]);
          const carried = imageFromUrl((node.attrs["src"] as string | null) ?? "");
          const image =
            here ??
            (carried && [...images, ...added].find((i) => i.data === carried.data)) ??
            carried;
          if (!image) return node.type.create({ key: node.attrs["key"], src: null });
          if (image === carried && !added.includes(carried)) {
            // As an added file is: an even share of the total cap each.
            const why = !imageCaps
              ? "This host's plxd can't take images."
              : images.length + added.length >= imageCaps.maxImages
                ? `A message takes at most ${imageCaps.maxImages} images.`
                : carried.data.length > imageShare(imageCaps)
                  ? "That image is too large to send."
                  : undefined;
            if (why) {
              refused = why;
              return null;
            }
            added.push(carried);
          }
          return node.type.create({ key: imageKey(image), src: null });
        });
        if (added.length > 0) setImages((all) => [...all, ...added]);
        if (refused || added.length > 0) setAttachError(refused);
        return new Slice(content, slice.openStart, slice.openEnd);
      },
      // Pasted lines are lines, as typed ones are: a paragraph each, blank ones kept.
      clipboardTextParser: (text, _context, _plain, view) => {
        const { schema } = view.state;
        const lines = text
          .split(/\r\n?|\n/)
          .map((line) => schema.nodes["paragraph"]!.create(null, line ? schema.text(line) : null));
        return new Slice(Fragment.from(lines), 1, 1);
      },
    },
  });

  // Empty while a send uploads its files, since what the box shows is on its way.
  useEffect(() => {
    if (!contents) return;
    contents.current = uploading
      ? { text: "", doc: { type: "doc" }, images: [], files: [], threads: [] }
      : { text, doc: editor.getJSON(), images, files, threads };
  }, [contents, editor, text, images, files, threads, uploading]);

  // Run ids are the host's own, so attached threads don't follow a New Thread draft to another
  // computer.
  const threadsHost = useRef(host);
  useEffect(() => {
    if (threadsHost.current === host) return;
    threadsHost.current = host;
    // Not an undo step, so undo can't bring another computer's threads back.
    const tr = withoutNodes(editor.state, "threadRef", () => true);
    if (tr) editor.view.dispatch(tr);
  }, [host, editor]);

  // Tokens typed or recalled before their list arrived become chips once it does.
  useEffect(() => {
    const mentions = mentionsIn(editor.state, known);
    if (mentions) editor.view.dispatch(mentions);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `known` reads only these lists.
  }, [editor, loadedCommands, loadedPaths]);

  useEffect(() => {
    if (!insert) return;
    // A space apart from what's typed.
    const space = editor.isEmpty || /\s$/.test(editor.getText()) ? "" : " ";
    editor
      .chain()
      .focus("end")
      .insertContent(space + insert)
      .run();
  }, [insert, editor]);

  return (
    <div className="w-full">
      <form
        ref={box}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        // Files and sidebar threads dropped anywhere on the box are added, before the editor can
        // take them as text.
        onDragOver={(e) => {
          const { types } = e.dataTransfer;
          const thread = !!attach && types.includes(threadDragType);
          if (types.includes("Files") || thread) e.preventDefault();
          if (thread) e.dataTransfer.dropEffect = "copy";
          setThreadOver(thread);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setThreadOver(false);
        }}
        onDropCapture={(e) => {
          setThreadOver(false);
          const thread = attach ? draggedThread(e.dataTransfer) : undefined;
          if (e.dataTransfer.files.length === 0 && !thread) return;
          e.preventDefault();
          e.stopPropagation();
          if (!thread) return void addFiles([...e.dataTransfer.files]);
          // Run ids are the host's own, so another computer's thread can't come along.
          if (thread.hostId !== attach?.hostId)
            setAttachError("A thread on another computer can't be attached here.");
          else {
            // Where it's dropped in the text, else at its end.
            const at = editor.view.dom.contains(e.target as Node)
              ? editor.view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos
              : undefined;
            if (at === undefined) editor.commands.focus("end");
            addThreads([thread.runId], at === undefined ? undefined : { from: at, to: at });
          }
        }}
        className={`relative z-10 rounded-xl border bg-surface shadow-composer focus-within:border-ring ${threadOver ? "border-ring" : "border-border"}`}
      >
        {menuOpen && (
          <div
            className={`absolute inset-x-0 ${menuBelow ? "top-full mt-2" : "bottom-full mb-2"} overflow-hidden rounded-lg border border-border bg-surface text-foreground shadow-composer`}
          >
            <div className="group/scroll relative">
              <div
                ref={menuList}
                id={menuId}
                role="listbox"
                aria-label={
                  trigger.kind === "/"
                    ? "Commands"
                    : entries[0]?.group === "Threads"
                      ? "Threads and files"
                      : "Files"
                }
                className="max-h-72 overflow-y-auto p-1.5"
              >
                {entries.map((entry, i) => (
                  <ReactFragment key={entry.key}>
                    {entry.group !== entries[i - 1]?.group && (
                      <div
                        role="presentation"
                        className="px-2.5 pt-2 pb-1 text-caption font-medium tracking-wide text-faint-foreground uppercase"
                      >
                        {entry.group}
                      </div>
                    )}
                    <div
                      id={`${menuId}-${i}`}
                      role="option"
                      aria-selected={i === highlighted}
                      // The box keeps focus, so typing goes on filtering.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        entry.pick();
                      }}
                      onMouseMove={() => setActive(i)}
                      className={`flex h-9 w-full cursor-default items-center gap-2.5 rounded-md px-2.5 text-left text-body ${i === highlighted ? "bg-hover" : ""}`}
                    >
                      <span className="grid size-4 shrink-0 place-items-center text-muted-foreground [&_img]:size-4 [&_svg]:size-4">
                        {entry.icon}
                      </span>
                      <span data-label className="max-w-[55%] shrink-0 truncate font-medium">
                        {entry.label}
                      </span>
                      {entry.hint && (
                        <span className="shrink-0 font-mono text-caption text-faint-foreground">
                          {entry.hint}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-meta text-faint-foreground">
                        {entry.description}
                      </span>
                      {entry.badge && (
                        <span className="flex max-w-[30%] shrink-0 items-center gap-1.5 truncate rounded-md bg-hover px-1.5 py-0.5 text-caption text-muted-foreground [&_svg]:size-3.5">
                          {entry.badge}
                        </span>
                      )}
                      {entry.meta && (
                        <span className="w-7 shrink-0 text-right text-meta text-faint-foreground tabular-nums">
                          {entry.meta}
                        </span>
                      )}
                    </div>
                  </ReactFragment>
                ))}
                {loading && (
                  <p
                    role="status"
                    className="flex items-center gap-2 px-2.5 py-2 text-meta text-faint-foreground"
                  >
                    <LoaderCircle className="size-3.5 animate-spin" />
                    {loading}
                  </p>
                )}
              </div>
              <ScrollThumb target={menuDom} />
            </div>
            {entries.length > 0 && (
              <div className="flex items-start gap-3 border-t border-border px-3.5 py-2 text-meta text-faint-foreground">
                <p className="line-clamp-2 min-w-0 flex-1 text-muted-foreground">
                  {entries[highlighted]?.detail}
                </p>
                <span aria-hidden className="flex shrink-0 items-center gap-2.5">
                  {[
                    ["↑↓", "move"],
                    ["↵", "pick"],
                    ["esc", "close"],
                  ].map(([key, what]) => (
                    <span key={key} className="flex items-center gap-1">
                      <kbd className="rounded-sm border border-border px-1 font-sans text-caption leading-4">
                        {key}
                      </kbd>
                      {what}
                    </span>
                  ))}
                </span>
              </div>
            )}
          </div>
        )}
        {(images.length > 0 || files.length > 0) && (
          <fieldset
            // Locked while files upload: what's there now is what's sent.
            disabled={uploading}
            className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 px-4 pt-3.5"
          >
            {images.map((image, i) => (
              <span key={i} className="relative">
                <button
                  type="button"
                  aria-label={`Open image ${i + 1}`}
                  onClick={() => setShown(image)}
                  className="block cursor-zoom-in rounded-xl"
                >
                  <img
                    src={imageUrl(image)}
                    alt={`Image ${i + 1}`}
                    className="size-14 rounded-xl border border-border object-cover"
                  />
                </button>
                <button
                  type="button"
                  aria-label={`Remove image ${i + 1}`}
                  onClick={() => removeImage(i)}
                  className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border border-border bg-surface text-muted-foreground shadow-sm hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            {files.map((f, i) => (
              <FileCard
                key={`${f.name}-${f.lastModified}-${i}`}
                file={f}
                progress={sending?.file === f ? sending.share : undefined}
                failed={sending?.file === f && sending.failed}
                onRemove={() => setFiles((all) => all.filter((_, j) => j !== i))}
              />
            ))}
            {files.length > 0 && !canUpload && (
              <span className="text-meta text-faint-foreground">Not sent to the agent yet</span>
            )}
          </fieldset>
        )}
        {shown && images.includes(shown) && (
          <Lightbox
            images={images.map((image, i) => ({ src: imageUrl(image), name: `Image ${i + 1}` }))}
            index={images.indexOf(shown)}
            onIndex={(i) => setShown(images[i])}
            onClose={() => setShown(undefined)}
          />
        )}
        <div ref={textArea} className="group/scroll relative">
          {!text && (
            <p
              aria-hidden
              className="pointer-events-none absolute inset-x-5 top-4.5 truncate text-reading leading-relaxed text-faint-foreground"
            >
              {placeholder}
            </p>
          )}
          <RefsContext.Provider value={{ images, threads: attach?.state }}>
            <EditorContent editor={editor} />
          </RefsContext.Provider>
          <ScrollThumb target={editorDom} />
        </div>
        <div className="flex items-center gap-0.5 px-3 pt-1 pb-3">
          {run && (
            // A disabled fieldset turns off every control in it, and its title says why.
            <fieldset
              ref={controls}
              disabled={!!optionsDisabled}
              title={optionsDisabled}
              className="flex min-w-0 items-center gap-0.5"
            >
              {/* Every provider, and an open run can't pick those it can't move to. */}
              {model && (
                <ModelMenu
                  key={backend}
                  catalog={catalog}
                  unavailable={blocked}
                  value={model}
                  onChange={setModel}
                />
              )}
              {efforts && (
                <>
                  {divider}
                  <EffortMenu
                    value={effort}
                    onChange={setEffort}
                    contexts={contexts}
                    context={context}
                    onContext={setContext}
                    fastMode={hasFast ? instanceOf(model!.provider)?.kind : undefined}
                    fast={fast}
                    onFast={setFast}
                  />
                </>
              )}
              {/* One permission is no choice, so there's nothing to show. */}
              {permissions.length > 1 && (
                <>
                  {divider}
                  <Picker
                    label="Access"
                    value={permission}
                    onChange={(value) => setPermission(value as AgentPermission)}
                    options={permissions.map((p) =>
                      p === "manual" && manualDenied
                        ? { ...accessOptions[p], description: manualDenials[manualDenied] }
                        : accessOptions[p],
                    )}
                    panelClassName="w-[25rem]"
                  />
                </>
              )}
            </fieldset>
          )}
          <input
            ref={filePicker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          {usage?.summary && <UsageRing data={usage} />}
          <button
            type="button"
            aria-label="Attach files"
            title="Attach files"
            onClick={() => filePicker.current?.click()}
            className={`mr-1.5 ${usage?.summary ? "" : "ml-auto"} grid size-9 place-items-center rounded-full text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4`}
          >
            <Paperclip />
          </button>
          {showStop ? (
            <button
              type="button"
              aria-label={stopping ? "Stopping" : "Stop"}
              disabled={stopping}
              onClick={() => void stop()}
              className="grid size-9 place-items-center rounded-full bg-danger text-background disabled:opacity-50"
            >
              {stopping ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Square className="size-3.5 fill-current" />
              )}
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              disabled={!canSend}
              className="send-sky grid size-9 place-items-center rounded-full bg-send text-send-foreground disabled:bg-selected disabled:text-faint-foreground"
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </form>
      {tab && (
        // Tucked under the box, so what it shows reads as part of it.
        <div className="tucked mx-5 -mt-4 flex min-w-0 items-center justify-between gap-2 rounded-b-xl border border-t-0 border-border bg-surface px-3 pt-5 pb-1.5">
          {tab}
        </div>
      )}
      {footer}
    </div>
  );
}
