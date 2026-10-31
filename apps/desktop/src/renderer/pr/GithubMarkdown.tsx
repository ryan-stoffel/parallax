import { memo, useRef, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { codeComponents, highlight } from "../AgentChat";
import { icons } from "../icons";
import { reducedMotion } from "../motion";
import { Kbd } from "../ui";
import {
  rehypeGithubAlerts,
  rehypeGithubHtml,
  rehypeGithubRefs,
  type AlertKind,
} from "./githubHtml";

const alerts: Record<AlertKind, { Icon: typeof icons.info; label: string; tone: string }> = {
  note: { Icon: icons.info, label: "Note", tone: "text-accent border-accent" },
  tip: { Icon: icons.tip, label: "Tip", tone: "text-added border-added" },
  important: {
    Icon: icons.important,
    label: "Important",
    tone: "text-project-violet border-project-violet",
  },
  warning: { Icon: icons.warning, label: "Warning", tone: "text-warning border-warning" },
  caution: { Icon: icons.error, label: "Caution", tone: "text-danger border-danger" },
};

const https = (url?: string) => !!url && /^https:\/\/[^/]/i.test(url);

/**
 * A pull request's description or comment as GitHub renders it: GitHub-flavored Markdown (tables,
 * task lists, footnotes, strikethrough), the HTML GitHub allows (`<details>` folds, centered
 * blocks, `<picture>` and sized images, `<sub>`, `<kbd>`, `<br>`, links), GitHub's alerts, and
 * links for `#12`, `owner/repo#12`, `@user`, and commit hashes in `repo`. Only https images load,
 * as on GitHub, and clicking one is the caller's (the Lightbox). A link opens through `onOpen`, and
 * a footnote's scrolls to its note.
 */
export const GithubMarkdown = memo(function GithubMarkdown({
  text,
  repo,
  onOpen = (url) => window.open(url, "_blank", "noreferrer"),
}: {
  text: string;
  repo: string;
  onOpen?: (url: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const components: Components = {
    ...codeComponents,
    a: ({ node, href, children }) => {
      const ref = node?.properties["dataRef"];
      return (
        <a
          href={href}
          data-ref={ref as string | undefined}
          onClick={(e) => {
            e.preventDefault();
            if (href?.startsWith("#")) {
              root.current?.querySelector(`[id="${CSS.escape(href.slice(1))}"]`)?.scrollIntoView({
                block: "center",
                behavior: reducedMotion() ? "auto" : "smooth",
              });
            } else if (href && /^(https?|mailto):/i.test(href)) onOpen(href);
          }}
          className={ref === "user" ? "font-medium text-foreground!" : undefined}
        >
          {children}
        </a>
      );
    },
    // Only https images load. Another one is a link with its alt text, as before it was read.
    img: ({ src, alt, width, height }) =>
      typeof src === "string" && https(src) ? (
        <img
          src={src}
          alt={alt ?? ""}
          width={width}
          height={height}
          loading="lazy"
          className={`inline-block max-w-full rounded-sm align-middle ${height && !width ? "" : "h-auto"}`}
        />
      ) : typeof src === "string" && src ? (
        <a href={src} onClick={(e) => e.preventDefault()}>
          {alt || "Image"}
        </a>
      ) : (
        <>{alt}</>
      ),
    kbd: ({ children }) => <Kbd className="text-meta!">{children}</Kbd>,
    blockquote: ({ node, children }) => {
      const kind = node?.properties["dataAlert"] as AlertKind | undefined;
      const alert = kind && alerts[kind];
      if (!alert) return <blockquote>{children}</blockquote>;
      return (
        <div
          role="note"
          className={`border-l-[3px] pl-3 [&>*+*]:mt-2 [&>p:not(:first-child)]:text-foreground ${alert.tone}`}
        >
          <p className="flex items-center gap-1.5 font-medium">
            <alert.Icon aria-hidden className="size-4" />
            {alert.label}
          </p>
          <div className="text-foreground [&>*+*]:mt-2">{children}</div>
        </div>
      );
    },
    details: ({ children, open }) => <Fold open={open}>{children}</Fold>,
    summary: ({ children }) => (
      <summary className="-mx-3 flex list-none items-center gap-1.5 rounded-lg px-3 py-2 font-medium hover:bg-hover [&::-webkit-details-marker]:hidden">
        <icons.next
          aria-hidden
          className="size-3.5 shrink-0 text-faint-foreground transition-transform duration-base group-open/fold:rotate-90"
        />
        <span className="min-w-0 [&>*]:inline">{children}</span>
      </summary>
    ),
    section: ({ node, children, className }) =>
      node?.properties["dataFootnotes"] ? (
        <section className="mt-6 border-t border-border pt-3 text-meta text-muted-foreground [&_li+li]:mt-1 [&_ol]:pl-4">
          {children}
        </section>
      ) : (
        <section className={className}>{children}</section>
      ),
  };
  return (
    <div
      ref={root}
      className="gh-markdown markdown [&_img[src^='https://']]:cursor-zoom-in [&_p[align=center]]:text-center"
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          rehypeGithubHtml,
          ...(highlight ?? []),
          rehypeGithubAlerts,
          [rehypeGithubRefs, { repo }],
        ]}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  );
});

/**
 * A `<details>` as a fold: a bordered box whose summary opens it, its content easing open and shut
 * (the browser's `::details-content`, stilled under reduced motion).
 */
function Fold({ open, children }: { open?: boolean; children: ReactNode }) {
  return (
    <details
      open={open}
      className="group/fold rounded-lg border border-border px-3 [interpolate-size:allow-keywords] open:pb-3 [&::details-content]:h-0 [&::details-content]:overflow-clip [&::details-content]:transition-[height,content-visibility] [&::details-content]:duration-base [&::details-content]:ease-in-out [&::details-content]:[transition-behavior:allow-discrete] open:[&::details-content]:h-auto [&>:not(summary)]:mt-2"
    >
      {children}
    </details>
  );
}
