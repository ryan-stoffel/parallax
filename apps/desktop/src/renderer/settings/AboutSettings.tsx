import {
  ArrowLeft,
  ArrowUpRight,
  Bug,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Copy,
  Download,
  Lightbulb,
  LoaderCircle,
  RefreshCw,
  RefreshCwOff,
  RotateCw,
  Search,
} from "lucide-react";
import { t } from "i18next";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { msg } from "../../i18n";
import type { UpdateState } from "../../preload/bridge";
import { useCopy } from "../AgentChat";
import { useConnectedNow, useShownConnection } from "../ConnectionStatus";
import { localId } from "../hosts";
import { GitHubStarIcon, KoFiLogo, ParallaxMark } from "../logos";
import { age } from "../Sidebar";
import { IconButton, searchField, Segmented } from "../ui";
import { reviewUpdates } from "../Update";
import { artwork, notices } from "./licenses";
import { Row, Section } from "./parts";
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

/** A package group's name as shown. */
const groupName = (group: (typeof groups)[number]) =>
  ({ All: t("All"), App: t("App"), plxd: "plxd", Sidecars: t("Sidecars") })[group];

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
          <IconButton label={t("Back to About")} onClick={() => setCredits(undefined)}>
            <ArrowLeft aria-hidden />
          </IconButton>
          <h1 className="text-heading font-semibold">
            {
              {
                code: t("Code"),
                fonts: t("Fonts"),
                artwork: t("Logos and icons"),
                models: t("Models"),
              }[credits]
            }
          </h1>
        </div>
        {credits === "code" ? (
          <CodeLicenses />
        ) : credits === "models" ? (
          <ModelNotices />
        ) : (
          <Section title={t("Notices")}>
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
            {t("Run coding agents on computers you own, and check on them from anywhere.")}
          </p>
          <div data-setting="version" className="mt-1">
            {version && <CopyVersion version={version} />}
          </div>
        </div>
      </header>

      <UpdateCard version={version} />

      <section
        aria-label={t("Get involved")}
        data-setting={anchorOf("Get involved")}
        className="mb-10"
      >
        <h2 className="mb-3 text-reading font-semibold">{t("Get involved")}</h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-2">
          <LinkTile
            href={`${repository}/issues/new?${bugReport.toString()}`}
            icon={<Bug aria-hidden className="text-danger" />}
            title={t("Report a bug")}
            detail={t("Open a GitHub issue with your version.")}
          />
          <LinkTile
            href={`${repository}/discussions/new?category=ideas`}
            icon={<Lightbulb aria-hidden className="text-project-yellow" />}
            title={t("Share an idea")}
            detail={t("Start a discussion on GitHub.")}
          />
          <LinkTile
            href={repository}
            icon={<GitHubStarIcon />}
            title={t("Star on GitHub")}
            detail={t("A star helps people find Parallax.")}
          />
          <LinkTile
            href="https://ko-fi.com/parallax_team"
            icon={<KoFiLogo />}
            title={t("Support on Ko-fi")}
            detail={t("Help fund the work.")}
          />
        </div>
      </section>

      <Section title={t("This computer")}>
        {connection?.status === "connected" && (
          <Row title="plxd">
            <Value>{connection.plxd}</Value>
          </Row>
        )}
        {os && (
          <Row title={t("Operating system")}>
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

      <Section title={t("Open source")}>
        <Row title={t("License")} description={t("Parallax is free and open source.")}>
          <OutLink href={`${repository}/blob/develop/LICENSE`}>Apache License 2.0</OutLink>
        </Row>
        <Row title={t("Source code")} description={t("Where Parallax is built, in the open.")}>
          <OutLink href={repository}>ryan-stoffel/parallax</OutLink>
        </Row>
      </Section>

      <Section title={t("Licenses and credits")}>
        <ChoiceRow
          title={t("Code")}
          detail={t("The packages in the app and plxd, each with its license")}
          onClick={() => setCredits("code")}
        />
        <ChoiceRow
          title={t("Fonts")}
          detail={t("{{count}} fonts that ship with Parallax", {
            count: notices.length,
            defaultValue_one: "{{count}} font that ships with Parallax",
          })}
          onClick={() => setCredits("fonts")}
        />
        <ChoiceRow
          title={t("Logos and icons")}
          detail={t("Whose marks these are, and where they come from")}
          onClick={() => setCredits("artwork")}
        />
        <ChoiceRow
          title={t("Models")}
          detail={t("Voice dictation's speech model and the Device panel's device models")}
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
      aria-label={t("Copy version {{version}}", { version })}
      title={t("Copy version")}
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

// What About says when the sidebar's Update button can't review a restart for it, shown with `t`.
const inSidebar = msg("Restart from the Update button in the sidebar.");

/**
 * The updater as About knows it: its `state` from main, and the last press's `answer` from
 * `update` with when it came. A newer state drops the answer, which was about the one before.
 */
type UpdateSeen = { state: UpdateState; answer?: string; checkedAt?: string };

/** What the updates card shows. */
type UpdateView = {
  icon: keyof typeof updateIcons;
  title: string;
  detail?: string;
  /** `detail` is a failure's line. */
  failed?: boolean;
  /** The release's page, linked when there is no `detail`. */
  notes?: string;
  /** The download's percent, drawn as a bar in place of `detail`. */
  progress?: number;
  button?: { label: string; primary?: boolean; busy?: boolean };
};

const updateIcons = {
  check: <RefreshCw />,
  current: <CircleCheck className="text-added" />,
  release: <Download className="text-accent" />,
  restart: <RotateCw className="text-accent" />,
  failed: <CircleAlert className="text-danger" />,
  off: <RefreshCwOff className="text-faint-foreground" />,
};

/**
 * The updates card for what the updater says: an icon, a title, one line of detail, and a button
 * that names what a press does. `checking` is true while a press's `update` runs, and `version`
 * is this copy's.
 */
function updateView(
  { state, answer, checkedAt }: UpdateSeen,
  checking: boolean,
  version?: string,
): UpdateView {
  const off = { icon: "off", title: t("Updates aren't available in this build") } as const;
  if (!window.parallax.updatable)
    return { ...off, detail: t("Only the packaged app updates itself.") };
  const { available, progress, ready, note, unsupported } = state;
  if (unsupported) return { ...off, detail: note };
  // The updater's line about a check or download that failed.
  const failure =
    note === undefined ? undefined : ({ icon: "failed", detail: note, failed: true } as const);
  if (progress !== undefined)
    return {
      icon: "release",
      title: available
        ? t("Downloading {{version}}…", { version: available.version })
        : t("Downloading the update…"),
      progress,
      button: { label: t("Downloading…"), primary: true, busy: true },
    };
  if (available && ready !== undefined) {
    const view = {
      title: t("Parallax {{version}} is ready to install", { version: available.version }),
      button: { label: t("Restart to install"), primary: true },
    };
    if (answer === inSidebar) return { icon: "restart", detail: t(inSidebar), ...view };
    return { icon: "restart", detail: t("Parallax restarts to finish."), ...failure, ...view };
  }
  if (available)
    return {
      icon: "release",
      title: t("Parallax {{version}} is available", { version: available.version }),
      notes: available.url,
      ...failure,
      button: { label: t("Download"), primary: true, busy: checking },
    };
  // Under `pnpm dev`, the commits to take. `update` answers why it didn't take them.
  if (ready !== undefined)
    return {
      icon: "release",
      title: ready[0]!.toUpperCase() + ready.slice(1),
      detail: answer ?? t("Update moves this checkout to main and rebuilds it."),
      button: { label: checking ? t("Updating…") : t("Update"), primary: true, busy: checking },
    };
  const idle = t("Parallax checks for new releases on its own.");
  if (checking)
    return {
      icon: "check",
      title: t("Checking for updates…"),
      detail: idle,
      button: { label: t("Checking…"), busy: true },
    };
  if (failure)
    return {
      ...failure,
      title: t("Couldn't check for updates"),
      button: { label: t("Try again") },
    };
  const button = { label: t("Check for updates") };
  // `update` answers "Up to date" when nothing is newer, and otherwise why it didn't update.
  if (answer !== "Up to date")
    return { icon: "check", title: t("Updates"), detail: answer ?? idle, button };
  const checked =
    checkedAt &&
    (Date.now() - Date.parse(checkedAt) < 60_000
      ? t("Checked just now.")
      : t("Checked {{ago}} ago.", { ago: age(checkedAt) }));
  return {
    icon: "current",
    title: t("Parallax is up to date"),
    detail: [version && t("{{version}} is the latest.", { version }), checked]
      .filter(Boolean)
      .join(" "),
    button,
  };
}

// The card's button: one width whatever it reads, which its widest labels set from ::before and
// ::after (`widestLabels`), so the card holds still while a check runs.
const updateButton =
  "col-start-2 inline-flex shrink-0 flex-col items-center justify-self-start rounded-md border px-2.5 py-1 text-body whitespace-nowrap disabled:opacity-50 @md:col-start-3 before:invisible before:h-0 before:font-medium before:content-(--widest-a) after:invisible after:h-0 after:font-medium after:content-(--widest-b)";

/** The update button's widest labels in the app's language, as the CSS strings `updateButton` reads. */
const widestLabels = () =>
  ({
    "--widest-a": JSON.stringify(t("Check for updates")),
    "--widest-b": JSON.stringify(t("Restart to install")),
  }) as CSSProperties;

/**
 * The updates card under the header (PLX-1522): where Parallax stands with its updates, and one
 * button. A press runs `update`, as the sidebar's Update button does: it checks now, then
 * downloads the release it found. Once that's downloaded, a press opens the sidebar's review of
 * the restart (`reviewUpdates`), which counts the running threads a restart cuts off, and never
 * restarts on its own. What changes fades in, unless motion is reduced.
 */
function UpdateCard({ version }: { version?: string }) {
  const [seen, setSeen] = useState<UpdateSeen>({ state: {} });
  const [checking, setChecking] = useState(false);
  // "Checked 3m ago" stays true while the page is open.
  const [, setMinute] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setMinute((n) => n + 1), 60_000);
    const stop = window.parallax.updatable
      ? window.parallax.onUpdateState((state) => setSeen({ state }))
      : undefined;
    return () => {
      clearInterval(timer);
      stop?.();
    };
  }, []);
  const view = updateView(seen, checking, version);
  const { button } = view;
  const press = async () => {
    if (seen.state.available && seen.state.ready !== undefined) {
      const answer = reviewUpdates() ? undefined : inSidebar;
      return setSeen((old) => ({ ...old, answer }));
    }
    setChecking(true);
    const answer = await window.parallax.update();
    setSeen((old) => ({ ...old, answer, checkedAt: new Date().toISOString() }));
    setChecking(false);
  };
  return (
    <section
      aria-label={t("Updates")}
      data-setting="check-for-updates"
      className="@container mb-10 scroll-mt-6 rounded-xl border border-border/50 bg-(--pane-card) p-3"
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 @md:grid-cols-[auto_minmax(0,1fr)_auto]">
        <span className="grid size-9 place-items-center rounded-lg bg-hover [&_svg]:size-5">
          <span key={view.icon} aria-hidden className="animate-fade-in">
            {updateIcons[view.icon]}
          </span>
        </span>
        <div className="min-w-0" aria-live="polite">
          <p key={view.title} className="animate-fade-in text-body font-medium text-pretty">
            {view.title}
          </p>
          {view.progress !== undefined ? (
            <div className="flex items-center gap-2 text-meta text-muted-foreground">
              <div
                role="progressbar"
                aria-label={t("Download")}
                aria-valuenow={view.progress}
                className="h-1 max-w-64 flex-1 overflow-hidden rounded-full bg-selected"
              >
                <div
                  className="h-full rounded-full bg-accent transition-[width]"
                  style={{ width: `${view.progress}%` }}
                />
              </div>
              <span className="tabular-nums">{view.progress}%</span>
            </div>
          ) : view.detail ? (
            <p
              key={view.detail}
              role={view.failed ? "alert" : undefined}
              className="animate-fade-in text-meta text-pretty text-muted-foreground"
            >
              {view.detail}
            </p>
          ) : (
            view.notes && (
              <a
                href={view.notes}
                target="_blank"
                rel="noreferrer"
                className="flex w-fit animate-fade-in items-center gap-1 text-meta text-muted-foreground hover:text-foreground hover:underline"
              >
                {t("What's new")}
                <ArrowUpRight aria-hidden className="size-3" />
              </a>
            )
          )}
        </div>
        {button && (
          <button
            type="button"
            disabled={button.busy}
            onClick={() => void press()}
            style={widestLabels()}
            className={`${updateButton} ${
              button.primary
                ? "border-transparent bg-primary font-medium text-primary-foreground enabled:hover:opacity-90"
                : "border-border text-foreground enabled:hover:bg-hover"
            }`}
          >
            <span key={button.label} className="flex animate-fade-in items-center gap-1.5">
              {button.busy && <LoaderCircle aria-hidden className="size-3.5 animate-spin" />}
              {button.label}
            </span>
          </button>
        )}
      </div>
    </section>
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
    <Section title={t("Notices")}>
      <NoticeRow name={t("Voice dictation")} license="Apache-2.0" text={voice ?? t("Loading…")} />
      <NoticeRow
        name={t("Device models")}
        license={t("See notice")}
        text={devices ?? t("Loading…")}
      />
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
        {t(
          "What ships in Parallax. Sidecars are listed from their lockfiles, so they show a license name without its text.",
        )}
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className={`${searchField} min-w-48 flex-1`}>
          <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
          <input
            type="search"
            aria-label={t("Search packages")}
            placeholder={
              licenses
                ? t("Search {{count}} packages", {
                    count: licenses.packages.length,
                    defaultValue_one: "Search {{count}} package",
                  })
                : t("Loading…")
            }
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-body placeholder:text-faint-foreground focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
        </label>
        <Segmented
          label={t("Where it's used")}
          options={groups.map((g) => ({ value: g, name: groupName(g) }))}
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
          <p className="px-4 py-3 text-body text-muted-foreground">{t("No packages match.")}</p>
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
            {showGroup && ` · ${groupName(entry.group)}`}
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
              {t("This package's own files have its license text.")}
            </p>
          )}
        </div>
      )}
    </details>
  );
}
