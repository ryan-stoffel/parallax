import { SquareSlash } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

import type { PullRequest } from "../protocol/generated/protocol";
import { numberOf } from "./github";
import { GitHubLogo } from "./logos";
import { lookOf } from "./pr/parts";
import type { PullRequests } from "./PullRequests";

/** A thread's pull requests, for the `#` menu and the state each chip of one shows. */
export const PullRequestsContext = createContext<Pick<PullRequests, "urls" | "get"> | undefined>(
  undefined,
);

// Each kind of mention's colors: a skill in violet, a file in the accent, and a thread, a computer,
// an image, or a pull request faintly filled and outlined. A thread's, a computer's, and an
// image's text is the text's own color, with a thread's and a computer's icon muted, and a pull
// request's number takes its state's.
const tones = {
  pullRequest: "bg-foreground/[0.06] ring-1 ring-foreground/10 ring-inset",
  skill: "bg-project-violet/12 text-project-violet",
  file: "bg-accent/10 text-foreground",
  thread:
    "bg-foreground/[0.06] text-foreground ring-1 ring-foreground/10 ring-inset [&>svg]:text-muted-foreground",
  image: "bg-foreground/[0.06] text-foreground ring-1 ring-foreground/10 ring-inset",
};

/** A mention in a message, as the composer draws one: icons and a name, kept whole, with `end`
 * muted after the name. Its text is the text around it, at the same size and on the same baseline,
 * with the chip drawn behind it, so a line reads the same with or without one. A long name is cut
 * short. With `onOpen` it's a button. */
export function Chip({
  icon,
  tone = "skill",
  title,
  end,
  onOpen,
  children,
}: {
  icon: ReactNode;
  tone?: keyof typeof tones;
  title?: string;
  end?: ReactNode;
  onOpen?: () => void;
  children: ReactNode;
}) {
  const Box = onOpen ? "button" : "span";
  // A thread's computer, in `end`, gives way first, so a long name leaves the title readable.
  const yields = tone === "thread";
  return (
    <Box
      {...(onOpen ? { type: "button" as const, onClick: onOpen } : { contentEditable: false })}
      title={title}
      // Baseline-aligned items make the chip's baseline its text's. Icons, which have none, sit a
      // little below it, as glyphs do. Its padding stays inside the line's height.
      className={`group/chip mx-[0.1em] inline-flex max-w-[24em] items-baseline gap-[0.3em] rounded-sm py-[0.12em] leading-none whitespace-nowrap [&_img]:relative [&_img]:top-[0.14em] [&_img]:size-3.5 [&_img]:shrink-0 [&_svg]:relative [&_svg]:top-[0.14em] [&_svg]:size-3.5 [&_svg]:shrink-0 px-[0.35em] ${onOpen ? "cursor-pointer hover:bg-foreground/10" : ""} ${tones[tone]}`}
    >
      {icon}
      {/* Clipped only across, since `leading-none` leaves descenders outside the line. */}
      <span className="min-w-0 overflow-x-clip text-ellipsis">{children}</span>
      {end && (
        // Its icons a mark's size (0085), over the sizes they bring with them.
        <span
          className={`ml-[0.05em] inline-flex items-baseline gap-[0.35em] text-muted-foreground [&>:not(span)]:size-3! ${yields ? "min-w-[3em] shrink-[1000] [&>span]:min-w-0 [&>span]:overflow-x-clip [&>span]:text-ellipsis" : "shrink-0"}`}
        >
          {end}
        </span>
      )}
    </Box>
  );
}

// VS Code's Material file icons (material-icon-theme, MIT), by name: only these are bundled.
const icons = import.meta.glob<string>(
  "../../node_modules/material-icon-theme/icons/{c,console,cpp,csharp,css,database,docker,file,go,html,image,java,javascript,json,kotlin,lock,markdown,pdf,php,python,react,react_ts,ruby,rust,sass,svelte,svg,swift,toml,typescript,vue,xml,yaml}.svg",
  { eager: true, import: "default" },
);
const icon = (name: string) => icons[`../../node_modules/material-icon-theme/icons/${name}.svg`]!;

// Each extension's icon, as VS Code's Material theme draws it.
const byExtension: Record<string, string> = {
  rs: "rust",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "react_ts",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "react",
  html: "html",
  htm: "html",
  css: "css",
  scss: "sass",
  sass: "sass",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  swift: "swift",
  kt: "kotlin",
  rb: "ruby",
  php: "php",
  sh: "console",
  bash: "console",
  zsh: "console",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  lock: "lock",
  svg: "svg",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  pdf: "pdf",
  vue: "vue",
  svelte: "svelte",
  xml: "xml",
  sql: "database",
};

/** The icon for a file, by its extension, or Dockerfile by name. */
export function fileIcon(path: string): ReactNode {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const look = name === "Dockerfile" ? "docker" : (byExtension[ext] ?? "file");
  return <img src={icon(look)} alt="" />;
}

/** A pull request as a chip: GitHub's mark and its number, the number's text in its state's color,
 * with its title on hover. One not read yet is neutral. */
export function PullRequestChip({ url, pr }: { url: string; pr?: PullRequest }) {
  return (
    <Chip
      tone="pullRequest"
      title={pr?.title ?? url}
      icon={<GitHubLogo className="text-foreground" />}
    >
      <span className={`tabular-nums ${lookOf(pr).color}`}>#{numberOf(url)}</span>
    </Chip>
  );
}

/** A `/skill`, `@path`, or pull request URL token as a chip: the skill's name, the file's name with
 * its path on hover, or the pull request's. What the token says is what's sent; the chip only draws
 * it. */
export function Mention({ token }: { token: string }) {
  const pullRequests = useContext(PullRequestsContext);
  if (token.startsWith("https://"))
    return <PullRequestChip url={token} pr={pullRequests?.get(token)?.pr} />;
  if (token[0] === "/") {
    // A plugin's skill, `plugin:name`, shows its plugin dimmed.
    const at = token.lastIndexOf(":");
    return (
      <Chip icon={<SquareSlash />} title={token}>
        {at > 0 && <span className="opacity-60">{token.slice(1, at + 1)}</span>}
        {token.slice(at > 0 ? at + 1 : 1)}
      </Chip>
    );
  }
  const path = token.slice(1);
  return (
    <Chip icon={fileIcon(path)} tone="file" title={path}>
      {path.slice(path.lastIndexOf("/") + 1)}
    </Chip>
  );
}

/** `/name`, `@path`, and pull request URL tokens in sent text: a slash command or skill (no further
 * `/`), a path ending in an extension, so `/usr/bin`, `@someone`, and `@types/node` stay text, or
 * a pull request's GitHub URL. Any may end a sentence or clause. */
const tokens =
  /(?<=^|\s)(\/[\w:-]+|@[\w./-]*\.\w+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)(?=$|\s|[,;:!?)]|\.(?:\s|$))/g;

/** The `/skill`, `@path`, and pull request URL tokens in sent text. */
export const mentionsOf = (text: string) => text.match(tokens) ?? [];

/** A sent prompt's text with its `known` tokens drawn as chips. */
export function withMentions(text: string, known: (token: string) => boolean): ReactNode[] {
  return text
    .split(tokens)
    .map((part, i) => (i % 2 && known(part) ? <Mention key={i} token={part} /> : part));
}
