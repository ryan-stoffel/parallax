import { t } from "i18next";
import { renderAsync } from "pele/lazy";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Trans } from "react-i18next";

import type { PrGuideHunk } from "../../protocol/generated/protocol";
import { icons } from "../icons";
import { Badge, Button, EmptyState, IconButton, Spinner } from "../ui";
import type { GuideView } from "./model";

/**
 * The PR view's Guide tab (PLX-1188, 0095): an agent-written walkthrough, the overview first
 * (`page` 0) and then one step at a time, with Prev and Next or Left and Right. The view keeps
 * `page`, so it survives a trip to Code. A step's hunks open in Code with one click (`onOpen`). An
 * older head's guide shows marked out of date while the new one is written. `onRegenerate` writes
 * a new one, or tries again after a failure, with a spinner while it runs.
 */
export function Guide({
  view,
  page,
  onPage,
  onOpen,
  onRegenerate,
}: {
  view: GuideView;
  page: number;
  onPage: (page: number) => void;
  onOpen: (hunk: PrGuideHunk) => void;
  onRegenerate: () => void;
}) {
  if (view.kind === "loading")
    return (
      <div className="grid flex-1 place-items-center pb-16">
        <EmptyState
          icon={<Spinner size="lg" />}
          title={t("Writing a guide")}
          body={t("An agent is reading the diff. It's usually ready in a minute or two.")}
        />
      </div>
    );
  if (view.kind === "error")
    return (
      <div className="grid flex-1 place-items-center pb-16">
        <EmptyState
          icon={<icons.error aria-hidden />}
          title={t("Couldn't write a guide")}
          body={<span role="alert">{view.error}</span>}
          action={
            <Button variant="outline" size="sm" onClick={onRegenerate}>
              {t("Try again")}
            </Button>
          }
        />
      </div>
    );

  const { guide } = view;
  const last = guide.steps.length;
  const at = Math.min(page, last);
  const step = at > 0 ? guide.steps[at - 1] : undefined;
  const go = (to: number) => onPage(Math.max(0, Math.min(last, to)));
  const keys = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "ArrowLeft") go(at - 1);
    else if (e.key === "ArrowRight") go(at + 1);
    else return;
    e.preventDefault();
  };
  const generating = view.generating;

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto px-4 outline-none"
      tabIndex={-1}
      onKeyDown={keys}
      aria-label={t("Guide")}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-4 py-4">
        {view.kind === "stale" && (
          <p className="flex items-center gap-2 text-meta text-muted-foreground">
            <Badge tone="warning">{t("Out of date")}</Badge>
            <span className="min-w-0 flex-1 truncate" role={view.error ? "alert" : undefined}>
              {generating
                ? t("Written for an older commit. A new guide is on its way.")
                : view.error
                  ? t("Couldn't write one for the new commit: {{error}}", { error: view.error })
                  : t("Written for an older commit.")}
            </span>
          </p>
        )}

        <nav aria-label={t("Guide steps")} className="flex items-center gap-1">
          <IconButton label={t("Previous step")} disabled={at === 0} onClick={() => go(at - 1)}>
            <icons.back aria-hidden />
          </IconButton>
          <IconButton label={t("Next step")} disabled={at === last} onClick={() => go(at + 1)}>
            <icons.forward aria-hidden />
          </IconButton>
          <span className="ml-1 text-meta text-muted-foreground tabular-nums" aria-live="polite">
            {at === 0 ? t("Overview") : t("Step {{step}} of {{count}}", { step: at, count: last })}
          </span>
          <span className="flex-1" />
          {generating && <Spinner size="sm" label={t("Writing a new guide")} />}
          <IconButton
            label={generating ? t("Writing a new guide") : t("Regenerate")}
            disabled={generating}
            onClick={onRegenerate}
          >
            <icons.refresh aria-hidden />
          </IconButton>
        </nav>

        {step ? (
          <article key={at} className="flex flex-col gap-3">
            <h3 className="text-heading font-semibold">{step.title}</h3>
            <p className="text-body whitespace-pre-wrap">{step.explanation}</p>
            {step.diagram && <Diagram source={step.diagram} />}
            {step.hunks.length > 0 && (
              <ul aria-label={t("Changes in this step")} className="flex flex-wrap gap-1.5">
                {step.hunks.map((h, i) => (
                  <li key={i}>
                    <Button
                      size="sm"
                      variant="outline"
                      title={t("Open {{path}} at line {{line}} in Code", {
                        path: h.path,
                        line: h.start,
                      })}
                      onClick={() => onOpen(h)}
                    >
                      <icons.diff aria-hidden className="size-3.5" />
                      <span className="font-mono text-meta">
                        {h.path.split("/").pop()}
                        <span className="text-faint-foreground">
                          :{h.start}
                          {h.end > h.start && `–${h.end}`}
                        </span>
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </article>
        ) : (
          <article className="flex flex-col gap-3">
            <p className="text-body whitespace-pre-wrap">{guide.overview}</p>
            {guide.diagram && <Diagram source={guide.diagram} />}
            <ol className="flex flex-col">
              {guide.steps.map((s, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => go(i + 1)}
                    className="flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left text-body hover:bg-hover"
                  >
                    <span className="w-4 shrink-0 text-right text-meta text-faint-foreground tabular-nums">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">{s.title}</span>
                  </button>
                </li>
              ))}
            </ol>
          </article>
        )}

        {guide.omitted && guide.omitted.length > 0 && (
          <p className="text-meta text-muted-foreground">
            {guide.omitted.length > 5 ? (
              <Trans
                values={{
                  files: guide.omitted.slice(0, 5).join(", "),
                  more: guide.omitted.length - 5,
                }}
              >
                Left out for size, so the guide doesn't cover them:{" "}
                <span className="font-mono">{"{{files}}"}</span> and {"{{more}}"} more.
              </Trans>
            ) : (
              <Trans values={{ files: guide.omitted.join(", ") }}>
                Left out for size, so the guide doesn't cover them:{" "}
                <span className="font-mono">{"{{files}}"}</span>.
              </Trans>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Mermaid `source` drawn by Pele at the width it has, vertical when that's narrow, colored by the theme through `.pele`'s
 * variables (index.css). Links and images are off, since an agent wrote it. One that doesn't
 * render leaves nothing.
 */
function Diagram({ source }: { source: string }) {
  const box = useRef<HTMLDivElement>(null);
  const prefix = `d${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [svg, setSvg] = useState("");
  useEffect(() => {
    let live = true;
    // The box is hidden while empty, so its parent says how wide it can be.
    const el = box.current?.parentElement;
    renderAsync(source, {
      links: false,
      images: false,
      idPrefix: prefix,
      maxWidth: el ? el.clientWidth - 26 : undefined,
      fontSize: 13,
      fontFamily: el ? getComputedStyle(el).fontFamily : undefined,
    }).then(
      (drawn) => live && setSvg(drawn.svg),
      () => live && setSvg(""),
    );
    return () => {
      live = false;
    };
  }, [source, prefix]);
  return (
    <div
      ref={box}
      role={svg ? "img" : undefined}
      aria-label={svg ? t("Diagram") : undefined}
      className="overflow-x-auto rounded-lg border border-border bg-surface p-3 empty:hidden [&>svg]:mx-auto [&>svg]:block"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
