import { SquareSlash } from "lucide-react";
import type { ReactNode } from "react";

// Each kind of mention's colors: a skill in violet, a file in the accent, a thread or an image in
// the text's own color, faintly filled and outlined, and cited text outlined in the accent.
const tones = {
  skill: "bg-project-violet/12 text-project-violet",
  file: "bg-accent/10 text-foreground",
  thread: "bg-foreground/[0.06] text-foreground ring-1 ring-foreground/10 ring-inset",
  image: "bg-foreground/[0.06] text-foreground ring-1 ring-foreground/10 ring-inset",
  cite: "bg-accent/10 text-foreground ring-1 ring-accent/40 ring-inset",
};

/** A mention in a message, as the composer draws one: icons and a name, kept whole, with `end`
 * muted after the name. Its text is the text around it, at the same size and on the same baseline,
 * with the chip drawn behind it, so a line reads the same with or without one. A long name is cut
 * short. */
export function Chip({
  icon,
  tone = "skill",
  title,
  end,
  children,
}: {
  icon: ReactNode;
  tone?: keyof typeof tones;
  title?: string;
  end?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span
      contentEditable={false}
      title={title}
      // Baseline-aligned items make the chip's baseline its text's. Icons, which have none, sit a
      // little below it, as glyphs do. Its padding stays inside the line's height.
      className={`mx-[0.1em] inline-flex max-w-[24em] items-baseline gap-[0.3em] rounded-sm px-[0.35em] py-[0.12em] leading-none whitespace-nowrap [&_img]:relative [&_img]:top-[0.14em] [&_img]:size-3.5 [&_img]:shrink-0 [&_svg]:relative [&_svg]:top-[0.14em] [&_svg]:size-3.5 [&_svg]:shrink-0 ${tones[tone]}`}
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
      {end && (
        // Its icons a mark's size (0085), over the sizes they bring with them.
        <span className="ml-[0.05em] inline-flex shrink-0 items-baseline gap-[0.35em] text-muted-foreground [&>*]:size-3!">
          {end}
        </span>
      )}
    </span>
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

/** A `/skill` or `@path` token as a chip: the skill's name, or the file's name with its path on
 * hover. What the token says is what's sent; the chip only draws it. */
export function Mention({ token }: { token: string }) {
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

/** `/name` and `@path` tokens in sent text: a slash command or skill (no further `/`), or a path
 * ending in an extension, so `/usr/bin`, `@someone`, and `@types/node` stay text. Either may end a
 * sentence or clause. */
const tokens = /(?<=^|\s)(\/[\w:-]+|@[\w./-]*\.\w+)(?=$|\s|[,;:!?)]|\.(?:\s|$))/g;

/** The `/skill` and `@path` tokens in sent text. */
export const mentionsOf = (text: string) => text.match(tokens) ?? [];

/** A sent prompt's text with its `known` `/skill` and `@path` tokens drawn as chips. */
export function withMentions(text: string, known: (token: string) => boolean): ReactNode[] {
  return text
    .split(tokens)
    .map((part, i) => (i % 2 && known(part) ? <Mention key={i} token={part} /> : part));
}
