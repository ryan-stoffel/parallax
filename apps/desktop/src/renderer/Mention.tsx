import { Package } from "lucide-react";
import type { ReactNode } from "react";

/** A mention in a message, as the composer draws one: an icon and a name, kept whole. Its box is
 * inline code's (index.css), in ems, so it scales with the text around it. */
export function Chip({
  icon,
  tone = "skill",
  title,
  children,
}: {
  icon: ReactNode;
  tone?: "skill" | "file";
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      contentEditable={false}
      title={title}
      className={`mx-[0.1em] inline-flex items-center gap-[0.3em] rounded-[5px] border px-[0.4em] py-[0.1em] align-baseline text-[0.93em] leading-tight whitespace-nowrap text-foreground [&_img]:size-[1.05em] [&_img]:shrink-0 [&_svg]:size-[1.05em] [&_svg]:shrink-0 ${
        tone === "file"
          ? "border-accent/30 bg-accent/10"
          : "border-project-violet/30 bg-project-violet/10"
      }`}
    >
      {icon}
      {children}
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
function fileIcon(path: string): ReactNode {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const look = name === "Dockerfile" ? "docker" : (byExtension[ext] ?? "file");
  return <img src={icon(look)} alt="" />;
}

/** A `/skill` or `@path` token as a chip: the skill's name, or the file's name with its path on
 * hover. What the token says is what's sent; the chip only draws it. */
export function Mention({ token }: { token: string }) {
  if (token[0] === "/") return <Chip icon={<Package />}>{token.slice(1)}</Chip>;
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

/** A sent prompt's text with its `/skill` and `@path` tokens drawn as chips. */
export function withMentions(text: string): ReactNode[] {
  return text.split(tokens).map((part, i) => (i % 2 ? <Mention key={i} token={part} /> : part));
}
