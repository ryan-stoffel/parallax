import {
  ArrowLeft,
  ArrowUpRight,
  Bug,
  Check,
  ChevronRight,
  Copy,
  Lightbulb,
  LoaderCircle,
  Search,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { UpdateState } from "../../preload/bridge";
import { useCopy } from "../AgentChat";
import { useConnectedNow, useShownConnection } from "../ConnectionStatus";
import { localId } from "../hosts";
import { GitHubStarIcon, KoFiLogo, ParallaxMark } from "../logos";
import { IconButton, searchField, Segmented } from "../ui";
import { useUpdateState } from "../Update";
import { artwork, notices } from "./licenses";
import { outlineButton, Row, Section } from "./parts";
import { anchorOf } from "./search";

const repository = "https://github.com/ryan-stoffel/parallax";

/** A package in licenses.generated.json, which scripts/licenses.mjs writes. */
type Package = {
  name: string;
  version: string;
  license: string;
  url?: string;
  group: "App" | "plxd" | "Sidecars";
  /** Indexes into the file's texts. */
  texts: number[];
};
type Licenses = { packages: Package[]; texts: string[] };

const groups = ["All", "App", "plxd", "Sidecars"] as const;

/**
 * Settings > About: Parallax's version and whether a newer one is out, where to get involved, and
 * what it's made from.
 */
export function AboutSettings() {
  const [credits, setCredits] = useState<"code" | "fonts" | "artwork" | "models">();
  const [version, setVersion] = useState<string>();
  const [os, setOs] = useState<string>();
  const connection = useShownConnection(localId);
  const connectedNow = useConnectedNow(localId);
  useEffect(() => void window.parallax.version().then(setVersion), []);
  useEffect(() => {
    if (!connectedNow) return;
    void window.parallax.request(localId, "host/version", {}).then((answer) => {
      if ("result" in answer) setOs(answer.result.os);
    });
  }, [connectedNow]);

  if (credits)
    return (
      <>
        <div className="mb-6 flex items-center gap-2">
          <IconButton label="Back to About" onClick={() => setCredits(undefined)}>
            <ArrowLeft aria-hidden />
          </IconButton>
          <h1 className="text-heading font-semibold">
            {
              {
                code: "Code",
                fonts: "Fonts",
                artwork: "Logos and icons",
                models: "Models",
              }[credits]
            }
          </h1>
        </div>
        {credits === "code" ? (
          <CodeLicenses />
        ) : credits === "models" ? (
          <ModelNotices />
        ) : (
          <Section title="Notices">
            {(credits === "fonts" ? notices : artwork).map((n) => (
              <NoticeRow key={n.name} name={n.name} license={n.license} text={n.text} />
            ))}
          </Section>
        )}
      </>
    );

  const bugReport = new URLSearchParams({
    template: "bug-report.yml",
    ...(version && { version }),
    ...(os && { os }),
  });
  const electron = /Electron\/([\d.]+)/.exec(navigator.userAgent)?.[1];
  const chromium = /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1];
  return (
    <>
      <header className="mb-10 flex items-center gap-4">
        <span className="grid size-16 shrink-0 place-items-center rounded-[1rem] border border-border/50 bg-(--pane-card)">
          <ParallaxMark className="size-10" />
        </span>
        <div className="min-w-0">
          <h1 className="text-heading font-semibold">Parallax</h1>
          <p className="text-body text-muted-foreground">
            Run coding agents on computers you own, and check on them from anywhere.
          </p>
          <div data-setting="version" className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            {version && <CopyVersion version={version} />}
            <UpdateCheck />
          </div>
        </div>
      </header>

      <section aria-label="Get involved" data-setting={anchorOf("Get involved")} className="mb-10">
        <h2 className="mb-3 text-reading font-semibold">Get involved</h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-2">
          <LinkTile
            href={`${repository}/issues/new?${bugReport.toString()}`}
            icon={<Bug aria-hidden className="text-danger" />}
            title="Report a bug"
            detail="Open a GitHub issue with your version."
          />
          <LinkTile
            href={`${repository}/discussions/new?category=ideas`}
            icon={<Lightbulb aria-hidden className="text-project-yellow" />}
            title="Share an idea"
            detail="Start a discussion on GitHub."
          />
          <LinkTile
            href={repository}
            icon={<GitHubStarIcon />}
            title="Star on GitHub"
            detail="A star helps people find Parallax."
          />
          <LinkTile
            href="https://ko-fi.com/parallax_team"
            icon={<KoFiLogo />}
            title="Support on Ko-fi"
            detail="Help fund the work."
          />
        </div>
      </section>

      <Section title="This computer">
        {connection?.status === "connected" && (
          <Row title="plxd">
            <Value>{connection.plxd}</Value>
          </Row>
        )}
        {os && (
          <Row title="Operating system">
            <Value>{os}</Value>
          </Row>
        )}
        {electron && (
          <Row title="Electron">
            <Value>{electron}</Value>
          </Row>
        )}
        {chromium && (
          <Row title="Chromium">
            <Value>{chromium}</Value>
          </Row>
        )}
      </Section>

      <Section title="Open source">
        <Row title="License" description="Parallax is free and open source.">
          <OutLink href={`${repository}/blob/develop/LICENSE`}>Apache License 2.0</OutLink>
        </Row>
        <Row title="Source code" description="Where Parallax is built, in the open.">
          <OutLink href={repository}>ryan-stoffel/parallax</OutLink>
        </Row>
      </Section>

      <Section title="Licenses and credits">
        <ChoiceRow
          title="Code"
          detail="The packages in the app and plxd, each with its license"
          onClick={() => setCredits("code")}
        />
        <ChoiceRow
          title="Fonts"
          detail={`${notices.length} fonts that ship with Parallax`}
          onClick={() => setCredits("fonts")}
        />
        <ChoiceRow
          title="Logos and icons"
          detail="Whose marks these are, and where they come from"
          onClick={() => setCredits("artwork")}
        />
        <ChoiceRow
          title="Models"
          detail="Voice dictation's speech model and the Device panel's device models"
          onClick={() => setCredits("models")}
        />
      </Section>
    </>
  );
}

/** The version, whose copy icon shows on hover or focus, and a check once it's copied. */
function CopyVersion({ version }: { version: string }) {
  const [copied, copy] = useCopy();
  return (
    <button
      type="button"
      aria-label={`Copy version ${version}`}
      title="Copy version"
      onClick={() => copy(version)}
      className="group -ml-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-meta text-muted-foreground hover:bg-hover hover:text-foreground"
    >
      {version}
      {copied ? (
        <Check aria-hidden className="size-3.5 text-added" />
      ) : (
        <Copy
          aria-hidden
          className="size-3.5 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      )}
    </button>
  );
}

/**
 * What About's update button shows for the updater's `state`: its label, whether it's `busy` or
 * `off`, a failed check's or download's `error`, and a plain `line`, such as why this build can't
 * update. `checking` is true while a press's `update` runs, and `answer` is that press's line once
 * it ends.
 */
function updateButton(
  state: UpdateState,
  checking: boolean,
  answer?: string,
): { label: string; busy?: boolean; off?: boolean; error?: string; line?: string } {
  const check = "Check for updates";
  if (!window.parallax.updatable)
    return { label: check, off: true, line: "Updates run only in the packaged app." };
  const { available, progress, ready, note, unsupported } = state;
  if (unsupported) return { label: check, off: true, line: note };
  const busy = checking || progress !== undefined;
  if (progress !== undefined) return { label: `Downloading… ${progress}%`, busy };
  if (available) {
    const action = ready === undefined ? "Download" : "Restart to install";
    return { label: `${action} ${available.version}`, busy, error: note };
  }
  // `update` answers "Up to date" when nothing is newer, and otherwise why it didn't update.
  const upToDate = answer === "Up to date";
  const line = note === undefined && !upToDate ? answer : undefined;
  // Under `pnpm dev`, the commits to take.
  if (ready !== undefined) return { label: `Update: ${ready}`, busy, error: note, line };
  if (checking) return { label: "Checking…", busy };
  return { label: upToDate && !note ? "Up to date" : check, error: note, line };
}

/**
 * The button beside the version (PLX-1522). A press runs `update`, as the sidebar's Update button
 * does: it checks now, reading Checking… until the check ends and Up to date when nothing is
 * newer. With an update it names it, and a press downloads it, then another restarts to install
 * it. What it has to say goes on a line under the version.
 */
function UpdateCheck() {
  const state = useUpdateState();
  const [checking, setChecking] = useState(false);
  const [answer, setAnswer] = useState<string>();
  const { label, busy, off, error, line } = updateButton(state, checking, answer);
  const press = async () => {
    setChecking(true);
    setAnswer(await window.parallax.update());
    setChecking(false);
  };
  return (
    <>
      <button
        type="button"
        data-setting="check-for-updates"
        disabled={busy || off}
        onClick={() => void press()}
        className={outlineButton}
      >
        {busy && <LoaderCircle aria-hidden className="animate-spin" />}
        {label}
      </button>
      {error && (
        <p role="alert" className="basis-full text-meta text-danger">
          {error}
        </p>
      )}
      {line && <p className="basis-full text-meta text-muted-foreground">{line}</p>}
    </>
  );
}

/** A link that leaves the app, as a tile with its icon and what it's for. */
function LinkTile({
  href,
  icon,
  title,
  detail,
}: {
  href: string;
  icon: ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="group flex items-center gap-3 rounded-xl border border-border/50 bg-(--pane-card) p-3 hover:bg-hover"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-hover [&_svg]:size-5">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium">{title}</span>
        <span className="block text-meta text-muted-foreground">{detail}</span>
      </span>
      <ArrowUpRight
        aria-hidden
        className="size-4 shrink-0 text-faint-foreground group-hover:text-foreground"
      />
    </a>
  );
}

const Value = ({ children }: { children: ReactNode }) => (
  <span className="font-mono text-meta text-muted-foreground">{children}</span>
);

const OutLink = ({ href, children }: { href: string; children: ReactNode }) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    className="inline-flex items-center gap-1 text-body text-muted-foreground hover:text-foreground hover:underline"
  >
    {children}
    <ArrowUpRight aria-hidden className="size-3.5" />
  </a>
);

/** A row that opens a page of its own. */
function ChoiceRow({
  title,
  detail,
  onClick,
}: {
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 border-b border-border/40 px-4 py-2.5 text-left first:rounded-t-xl last:rounded-b-xl last:border-b-0 hover:bg-hover"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium">{title}</span>
        <span className="block text-meta text-muted-foreground">{detail}</span>
      </span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-faint-foreground" />
    </button>
  );
}

/** A notice that opens to its text. */
function NoticeRow({ name, license, text }: { name: string; license: string; text: string }) {
  return (
    <details className="border-b border-border/40 px-4 py-3 last:border-b-0">
      <summary className="flex cursor-pointer items-center justify-between gap-4 text-body font-medium">
        {name}
        <span className="shrink-0 font-mono text-meta font-normal text-muted-foreground">
          {license}
        </span>
      </summary>
      <pre className="mt-2 max-h-64 overflow-auto font-mono text-meta whitespace-pre-wrap text-muted-foreground">
        {text}
      </pre>
    </details>
  );
}

/** The notices of what ships beside the code, loaded when opened. */
function ModelNotices() {
  const [voice, setVoice] = useState<string>();
  const [devices, setDevices] = useState<string>();
  useEffect(() => {
    void import("../../../native/VOICE-NOTICES.txt?raw").then((m) => setVoice(m.default));
    void import("../assets/devices/NOTICE.md?raw").then((m) => setDevices(m.default));
  }, []);
  return (
    <Section title="Notices">
      <NoticeRow name="Voice dictation" license="Apache-2.0" text={voice ?? "Loading…"} />
      <NoticeRow name="Device models" license="See notice" text={devices ?? "Loading…"} />
    </Section>
  );
}

/** The packages in the app, plxd, and its sidecars, loaded when opened, as the list is large. */
function CodeLicenses() {
  const [licenses, setLicenses] = useState<Licenses>();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<(typeof groups)[number]>("All");
  useEffect(() => {
    void import("./licenses.generated.json").then((m) => setLicenses(m.default as Licenses));
  }, []);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = licenses?.packages.filter(
    (p) =>
      (group === "All" || p.group === group) &&
      words.every((w) => `${p.name} ${p.license}`.toLowerCase().includes(w)),
  );
  return (
    <>
      <p className="mb-4 text-body text-muted-foreground">
        What ships in Parallax. Sidecars are listed from their lockfiles, so they show a license
        name without its text.
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className={`${searchField} min-w-48 flex-1`}>
          <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
          <input
            type="search"
            aria-label="Search packages"
            placeholder={licenses ? `Search ${licenses.packages.length} packages` : "Loading…"}
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-body placeholder:text-faint-foreground focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
        </label>
        <Segmented
          label="Where it's used"
          options={groups.map((g) => ({ value: g, name: g }))}
          value={group}
          onChange={setGroup}
        />
      </div>
      <div className="rounded-xl border border-border/50 bg-(--pane-card)">
        {shown?.map((p) => (
          <PackageRow
            key={`${p.group}/${p.name}@${p.version}`}
            entry={p}
            texts={licenses!.texts}
            showGroup={group === "All"}
          />
        ))}
        {shown?.length === 0 && (
          <p className="px-4 py-3 text-body text-muted-foreground">No packages match.</p>
        )}
      </div>
    </>
  );
}

/** A package that opens to its license text, drawn only once opened. */
function PackageRow({
  entry,
  texts,
  showGroup,
}: {
  entry: Package;
  texts: string[];
  showGroup: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="border-b border-border/40 px-4 py-2 last:border-b-0"
    >
      <summary className="flex cursor-pointer items-baseline justify-between gap-4 text-body">
        <span className="min-w-0 truncate font-medium">
          {entry.name}{" "}
          <span className="font-mono text-meta font-normal text-faint-foreground">
            {entry.version}
            {showGroup && ` · ${entry.group}`}
          </span>
        </span>
        <span className="shrink-0 font-mono text-meta text-muted-foreground">{entry.license}</span>
      </summary>
      {open && (
        <div className="mt-2">
          {entry.url && (
            <OutLink href={entry.url}>
              <span className="text-meta">{entry.url.replace(/^https?:\/\//, "")}</span>
            </OutLink>
          )}
          {entry.texts.length > 0 ? (
            entry.texts.map((i) => (
              <pre
                key={i}
                className="mt-2 max-h-64 overflow-auto font-mono text-meta whitespace-pre-wrap text-muted-foreground"
              >
                {texts[i]}
              </pre>
            ))
          ) : (
            <p className="mt-1 text-meta text-muted-foreground">
              This package's own files have its license text.
            </p>
          )}
        </div>
      )}
    </details>
  );
}
