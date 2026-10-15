import { Atom, File, Package } from "lucide-react";
import type { ReactNode } from "react";

/** A mention in a message, as the composer draws one: an icon and a name, kept whole. */
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
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 align-baseline text-[0.93em] leading-normal whitespace-nowrap text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0 ${
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

// Drawn as an SVG like the other icons, so every chip sits on the text's baseline alike.
const badge = (text: string) => (
  <svg viewBox="0 0 16 16" aria-hidden>
    <text x="8" y="11.5" textAnchor="middle" fontSize="9.5" fontWeight="700" fill="currentColor">
      {text}
    </text>
  </svg>
);

/** The icon for a file, by its extension. */
function fileIcon(path: string): ReactNode {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "tsx" || ext === "jsx") return <Atom />;
  if (ext === "ts" || ext === "mts" || ext === "cts") return badge("TS");
  if (ext === "js" || ext === "mjs" || ext === "cjs") return badge("JS");
  return <File />;
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
 * with a `.` or `/` in it, so `/usr/bin` and `@someone` stay text. */
const tokens = /(?<=^|\s)(\/[\w:.-]+|@[\w.-]*[./][\w./-]*)(?=\s|$)/g;

/** A sent prompt's text with its `/skill` and `@path` tokens drawn as chips. */
export function withMentions(text: string): ReactNode[] {
  return text.split(tokens).map((part, i) => (i % 2 ? <Mention key={i} token={part} /> : part));
}
