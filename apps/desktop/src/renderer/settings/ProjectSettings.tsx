import { t } from "i18next";
import { Check, ChevronRight, Copy, RotateCcw } from "lucide-react";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";

import type { AgentPermission, ChosenIcon, Repo, RepoRef } from "../../protocol/generated/protocol";
import { accessPrefs } from "../accessPrefs";
import { useCopy } from "../AgentChat";
import { accessOptions } from "../Composer";
import { EffortMenu } from "../EffortMenu";
import { useHosts, type Host } from "../hosts";
import { IconPicker } from "../IconPicker";
import { readIcon } from "../images";
import { ModelMenu } from "../ModelMenu";
import { useCatalog, type Provider } from "../models";
import { notify } from "../notifications";
import { newThreadPrefs, setRepoPrefs, useRepoPrefs, type RepoPrefs } from "../prefs";
import { defaultIcon, iconColors, projectIcons } from "../projectIcons";
import { workspaces } from "../RunTargetMenu";
import { RepoIcon, SharedRepoIcons } from "../Sidebar";
import { isRepository, repoIconOf, setRepoIcons, type ThreadsView } from "../threads";
import { IconButton, Picker, type PickerOption } from "../ui";
import {
  allHosts,
  field,
  HostPicker,
  outlineButton,
  PageTitle,
  Row,
  rowField,
  Section,
} from "./parts";
import { RepoScripts } from "./ScriptSettings";

/** The menu's choice for the list of them all, which no entry's id can be. */
const allProjects = "#all";

/** What search can pick on a repository's page. */
const repoAnchors = ["new-thread-defaults", "scripts", "from-parallax-json", "git"];

/** The composer's own menus are borderless; on a settings row they get a field's outline. */
const pickerBox = "rounded-lg border border-border bg-background";

/** A repository or Project on a computer, with that computer's view of it. */
type Entry = { host: Host; view: ThreadsView; repo: Repo };

const keyOf = (e: Entry) => `${e.host.id}/${e.repo.id}`;

/** An option from a table marked with `msg`, in the shown language. */
const shown = (o: PickerOption): PickerOption => ({
  ...o,
  label: t(o.label),
  description: o.description && t(o.description),
});

/**
 * Settings > Projects: the repositories and Projects of every computer, or the one picked, opening
 * on the list of them. Choosing one shows its icon and its own settings. A repository has its own
 * new thread defaults and scripts, and a Project its name and instructions. On All computers, a
 * repository's defaults go to its copies on each.
 */
export function ProjectSettings({
  listed,
  focus,
}: {
  listed: { host: Host; view: ThreadsView }[];
  /** The setting search picked, which only a chosen repository or Project has. */
  focus?: { anchor: string };
}) {
  const hosts = useHosts();
  const [scope, setScope] = useState(allHosts);
  const entries = listed
    .filter((l) => scope === allHosts || l.host.id === scope)
    .flatMap(({ host, view }) => view.state.repos.map((repo) => ({ host, view, repo })));
  const repos = entries.filter((e) => isRepository(e.repo));
  const chats = entries.filter((e) => e.repo.project);
  const all = [...repos, ...chats];
  const named = new Set(all.map((e) => e.host.id)).size > 1;
  const [chosen, setChosen] = useState<string>();
  const current = all.find((e) => keyOf(e) === chosen);
  useEffect(() => {
    if (!focus) return;
    const among = (rows: Entry[]) => (was?: string) =>
      rows.some((e) => keyOf(e) === was) ? was : rows[0] && keyOf(rows[0]);
    if (focus.anchor === "instructions") setChosen(among(chats));
    else if (focus.anchor === "project-icon") setChosen(among(all));
    else if (repoAnchors.includes(focus.anchor)) setChosen(among(repos));
  }, [focus]);

  return (
    <>
      <div className="mb-8">
        <HostPicker
          hosts={hosts}
          value={scope}
          onChange={setScope}
          always
          all
          scope={
            <Picker
              field
              label={t("Project")}
              value={current ? keyOf(current) : allProjects}
              onChange={(key) => setChosen(key === allProjects ? undefined : key)}
              options={[
                { value: allProjects, label: t("All projects") },
                ...all.map((e) => ({
                  value: keyOf(e),
                  label: e.repo.name,
                  icon: <RepoIcon repo={e.repo} />,
                  hint: named ? e.host.name : undefined,
                })),
              ]}
              search={all.length > 8 ? t("Search projects") : undefined}
              className="max-w-56"
              panelClassName="min-w-56"
            />
          }
        />
      </div>
      {current?.repo.project ? (
        <ChatProject key={keyOf(current)} repo={current.repo} view={current.view} listed={listed} />
      ) : current ? (
        <Repository
          key={keyOf(current)}
          entry={current}
          named={named}
          listed={listed}
          copies={
            scope === allHosts ? repos.filter((e) => e.repo.name === current.repo.name) : [current]
          }
        />
      ) : (
        <>
          <p className="mb-4 text-reading text-muted-foreground">
            {all.length
              ? t("Choose a project to manage its icon and its own settings.")
              : t("Add a repository from the sidebar, and its settings show here.")}
          </p>
          {repos.length > 0 && (
            <ProjectList
              title={t("Repositories")}
              rows={repos}
              detail={(e) => <RepoDetail entry={e} named={named} />}
              onChoose={setChosen}
            />
          )}
          {chats.length > 0 && (
            <ProjectList
              title={t("Projects")}
              rows={chats}
              detail={(e) =>
                `${named ? `${e.host.name} · ` : ""}${t("Chats with their own instructions")}`
              }
              onChoose={setChosen}
            />
          )}
        </>
      )}
    </>
  );
}

/** A section of repositories or Projects, each with its icon, opening its own settings. */
function ProjectList({
  title,
  rows,
  detail,
  onChoose,
}: {
  title: string;
  rows: Entry[];
  detail: (entry: Entry) => ReactNode;
  onChoose: (key: string) => void;
}) {
  return (
    <Section title={title}>
      {rows.map((e) => (
        <button
          key={keyOf(e)}
          type="button"
          onClick={() => onChoose(keyOf(e))}
          className="flex w-full items-center gap-3 border-b border-border/40 px-4 py-2.5 text-left first:rounded-t-xl last:rounded-b-xl last:border-b-0 hover:bg-hover"
        >
          <RepoIcon repo={e.repo} size="size-5" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body font-medium">{e.repo.name}</span>
            <span className="block truncate text-meta text-muted-foreground">{detail(e)}</span>
          </span>
          <ChevronRight aria-hidden className="size-4 shrink-0 text-faint-foreground" />
        </button>
      ))}
    </Section>
  );
}

/** A repository's computer, where there are several, path, and defaults it sets of its own. */
function RepoDetail({ entry, named }: { entry: Entry; named: boolean }) {
  const count = Object.keys(useRepoPrefs(entry.host.id, entry.repo.id)).length;
  return (
    <>
      {named && `${entry.host.name} · `}
      {entry.repo.path}
      {count > 0 &&
        ` · ${t("{{count}} defaults changed", { count, defaultValue_one: "{{count}} default changed" })}`}
    </>
  );
}

/**
 * A repository's or Project's icon: what's on it now, Choose icon, which opens the picker in the
 * card under it, and Choose file where the host keeps images. A repository's goes to its copies on
 * every computer, as the sidebar's does (0033). Each pick saves at once.
 */
function IconRow({
  repo,
  view,
  listed,
}: {
  repo: Repo;
  view: ThreadsView;
  listed: { view: ThreadsView }[];
}) {
  const [choosing, setChoosing] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const icon = repoIconOf(repo, useContext(SharedRepoIcons));
  const maxBytes = view.iconImageBytes;
  const save = (next: ChosenIcon) => {
    if (repo.project)
      void view.updateRepo(repo.id, { icon: next }).then((failed) => {
        if (failed)
          notify({
            tone: "error",
            title: t("Couldn't save {{name}}'s icon", { name: repo.name }),
            body: failed,
          });
      });
    else
      setRepoIcons(
        listed.map((l) => l.view),
        repo.name,
        next,
      );
  };
  // An image keeps the glyph and color under it, for an app that doesn't draw images (0038).
  const upload = async (chosen: File) => {
    const image = await readIcon(chosen, maxBytes!);
    if (typeof image === "string")
      notify({ tone: "error", title: t("Couldn't use that image"), body: image });
    else {
      const { name, color } = icon ?? defaultIcon;
      save({ name, ...(color && { color }), image });
    }
  };
  const glyph = projectIcons.find((i) => i.name === icon?.name)?.label ?? icon?.name;
  const colorLabel = iconColors.find((c) => c.key === icon?.color)?.label;
  const color = colorLabel && t(colorLabel);
  return (
    <>
      <Row
        title={t("Project icon")}
        description={
          !icon
            ? repo.project
              ? t("The Project glyph")
              : t("Its initials")
            : icon.image
              ? t("An uploaded image")
              : [glyph, color].filter(Boolean).join(" · ")
        }
      >
        <span className="grid size-8 place-items-center rounded-lg bg-hover">
          <RepoIcon repo={repo} size="size-5" />
        </span>
        <button
          type="button"
          aria-expanded={choosing}
          className={outlineButton}
          onClick={() => setChoosing(!choosing)}
        >
          {choosing ? t("Done") : t("Choose icon")}
        </button>
        {maxBytes !== undefined && (
          <>
            <button type="button" className={outlineButton} onClick={() => file.current?.click()}>
              {t("Choose file")}
            </button>
            <input
              ref={file}
              type="file"
              hidden
              aria-label={t("Image for {{name}}'s icon", { name: repo.name })}
              accept="image/png,image/jpeg,image/gif,image/webp"
              onChange={(e) => {
                const chosen = e.currentTarget.files?.[0];
                // Cleared, so picking the same file again reads it again.
                e.currentTarget.value = "";
                if (chosen) void upload(chosen);
              }}
            />
          </>
        )}
      </Row>
      {choosing && <IconPicker value={icon} onPick={save} onClose={() => setChoosing(false)} />}
    </>
  );
}

/** Resets a default to follow the global one, shown only once it's set. `label` names the button. */
function ResetDefault({ label, set, reset }: { label: string; set: boolean; reset: () => void }) {
  return (
    set && (
      <IconButton label={label} onClick={reset}>
        <RotateCcw aria-hidden />
      </IconButton>
    )
  );
}

/** A fact about a repository's git, as code, or what's missing in plain words. */
function GitValue({ text, missing }: { text?: string; missing: string }) {
  return text ? (
    <code className="max-w-80 truncate font-mono text-meta text-muted-foreground" title={text}>
      {text}
    </code>
  ) : (
    <span className="text-body text-faint-foreground">{missing}</span>
  );
}

/**
 * A repository's path, its icon, its own new thread defaults, its scripts, and its git. A default
 * changed here goes to each of `copies`, this one among them.
 */
function Repository({
  entry,
  named,
  listed,
  copies,
}: {
  entry: Entry;
  named: boolean;
  listed: { view: ThreadsView }[];
  copies: Entry[];
}) {
  const { host, view, repo } = entry;
  const hostId = host.id;
  const prefs = useRepoPrefs(hostId, repo.id);
  const global = newThreadPrefs.use();
  const legacyPlan = accessPrefs.use().legacyPlan;
  const catalog = useCatalog(hostId);
  const [copied, copy] = useCopy();
  const [refs, setRefs] = useState<RepoRef[]>();
  const [remote, setRemote] = useState<string>();
  useEffect(() => {
    let stale = false;
    void window.parallax.request(hostId, "repo/refs", { repo: repo.id }).then((answer) => {
      if (!stale && "result" in answer) setRefs(answer.result.refs);
    });
    void window.parallax.request(hostId, "repo/remote", { repo: repo.id }).then((answer) => {
      if (!stale && "result" in answer) setRemote(answer.result.url);
    });
    return () => {
      stale = true;
    };
  }, [hostId, repo.id]);
  const set = (change: RepoPrefs) => {
    for (const copy of copies) setRepoPrefs(copy.host.id, copy.repo.id, change);
  };

  const blocked: Partial<Record<Provider, string>> = {};
  for (const i of catalog.instances)
    if (!i.enabled)
      blocked[i.id] = t("{{name}} is turned off in Settings > Providers.", { name: i.name });
  const choices = catalog.models.filter((m) => !blocked[m.provider]);
  const wanted = prefs.model ?? global.model;
  const model =
    choices.find((m) => m.provider === wanted?.provider && m.id === wanted.id) ?? choices[0];
  const instance = catalog.instances.find((i) => i.id === model?.provider);
  const permissions = (instance?.permissions ?? []).filter((p) => p !== "plan" || legacyPlan);
  const wantedPermission = prefs.permission ?? global.permission;
  const permission = permissions.includes(wantedPermission) ? wantedPermission : "edit";
  const workspace = prefs.workspace ?? global.workspace;
  const contexts = model?.contexts ?? [];
  const wantedContext = prefs.context ?? global.context;
  const context =
    wantedContext !== undefined && contexts.includes(wantedContext) ? wantedContext : contexts[0];
  const hasFast = !!model?.fast;
  const reasoningSet =
    prefs.effort !== undefined || prefs.context !== undefined || prefs.fast !== undefined;

  return (
    <>
      <PageTitle title={repo.name}>
        <span className="flex items-center gap-1 font-mono text-meta">
          <span className="truncate">
            {named && `${host.name} · `}
            {repo.path}
          </span>
          <IconButton size="sm" label={t("Copy path")} onClick={() => copy(repo.path)}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          </IconButton>
        </span>
      </PageTitle>
      {"threadAttention" in view.capabilities && (
        <Section title={t("General")}>
          <IconRow repo={repo} view={view} listed={listed} />
        </Section>
      )}
      <Section
        title={t("New thread defaults")}
        action={
          copies.length > 1 && (
            <span className="text-meta text-muted-foreground">
              {t("On {{count}} computers", {
                count: copies.length,
                defaultValue_one: "On {{count}} computer",
              })}
            </span>
          )
        }
      >
        <Row title={t("Model")} description={t("The model a new thread here starts on.")}>
          <ResetDefault
            label={t("Use the default model")}
            set={!!prefs.model}
            reset={() => set({ model: undefined, context: undefined })}
          />
          {model ? (
            <span className={pickerBox}>
              <ModelMenu
                catalog={catalog}
                unavailable={blocked}
                value={model}
                onChange={(m) =>
                  set({ model: { provider: m.provider, id: m.id }, context: undefined })
                }
              />
            </span>
          ) : (
            <span className="text-body text-muted-foreground">{t("No models")}</span>
          )}
        </Row>
        {model && instance?.efforts !== false && (
          <Row
            title={t("Reasoning")}
            description={t("How hard it thinks, and its context and fast mode.")}
          >
            <ResetDefault
              label={t("Use the default reasoning")}
              set={reasoningSet}
              reset={() => set({ effort: undefined, context: undefined, fast: undefined })}
            />
            <span className={pickerBox}>
              <EffortMenu
                value={prefs.effort ?? global.effort}
                onChange={(effort) => set({ effort })}
                contexts={contexts}
                context={context}
                onContext={(next) => set({ context: next })}
                fastMode={hasFast ? instance?.kind : undefined}
                fast={hasFast && (prefs.fast ?? global.fast)}
                onFast={(fast) => set({ fast })}
              />
            </span>
          </Row>
        )}
        {permissions.length > 1 && (
          <Row
            title={t("Permissions")}
            description={t("What a new thread here may do without asking.")}
          >
            <ResetDefault
              label={t("Use the default permissions")}
              set={!!prefs.permission}
              reset={() => set({ permission: undefined })}
            />
            <Picker
              field
              label={t("Permissions")}
              value={permission}
              onChange={(value) => set({ permission: value as AgentPermission })}
              options={permissions.map((p) => shown(accessOptions[p]))}
              align="end"
              className="w-56"
              panelClassName="w-[25rem]"
            />
          </Row>
        )}
        <Row title={t("Workspace")} description={t("Where a new thread here works.")}>
          <ResetDefault
            label={t("Use the default workspace")}
            set={!!prefs.workspace}
            reset={() => set({ workspace: undefined })}
          />
          <Picker
            field
            label={t("Workspace")}
            value={workspace}
            onChange={(value) => set({ workspace: value as RepoPrefs["workspace"] })}
            options={workspaces.map(shown)}
            align="end"
            className="w-56"
            panelClassName="w-[24rem]"
          />
        </Row>
        <Row
          title={t("Base branch")}
          description={t("The branch a new worktree here starts from.")}
        >
          <ResetDefault
            label={t("Use the default base branch")}
            set={!!prefs.base}
            reset={() => set({ base: undefined })}
          />
          <Picker
            field
            label={t("Base branch")}
            value={prefs.base ?? ""}
            onChange={(base) => set({ base: base || undefined })}
            options={[
              {
                value: "",
                label:
                  global.worktreeBase === "current" ? t("Current branch") : t("Default branch"),
                hint: t("default"),
              },
              ...(prefs.base && !refs?.some((r) => r.name === prefs.base)
                ? [{ value: prefs.base, label: prefs.base }]
                : []),
              ...(refs ?? []).map((r) => ({ value: r.name, label: r.name })),
            ]}
            search={(refs?.length ?? 0) > 8 ? t("Search branches") : undefined}
            align="end"
            className="w-56"
            panelClassName="w-72"
          />
        </Row>
      </Section>
      <RepoScripts hostId={hostId} repo={repo} />
      <Section title="Git">
        <Row title={t("Remote")} description={t("Where its pull requests go.")}>
          <GitValue text={remote} missing={t("No origin")} />
        </Row>
        <Row title={t("Current branch")} description={t("What its checkout has out.")}>
          <GitValue text={refs?.find((r) => r.current)?.name} missing={t("Detached")} />
        </Row>
        <Row title={t("Default branch")} description={t("What origin/HEAD names.")}>
          <GitValue text={refs?.find((r) => r.default)?.name} missing={t("Unknown")} />
        </Row>
      </Section>
    </>
  );
}

/** A Project's name, its icon, and its instructions, which every thread in it gets (0090). */
function ChatProject({
  repo,
  view,
  listed,
}: {
  repo: Repo;
  view: ThreadsView;
  listed: { view: ThreadsView }[];
}) {
  const [name, setName] = useState(repo.name);
  const [instructions, setInstructions] = useState(repo.instructions ?? "");
  const save = async (change: { name?: string; instructions?: string }) => {
    const failed = await view.updateRepo(repo.id, change);
    if (failed)
      notify({
        tone: "error",
        title: t("Couldn't save {{name}}", { name: repo.name }),
        body: failed,
      });
  };
  return (
    <>
      <PageTitle title={repo.name}>{t("A group of chats, with no repository of yours.")}</PageTitle>
      <Section title={t("General")}>
        <Row title={t("Name")} description={t("How the sidebar names it.")}>
          <input
            aria-label={t("Name")}
            value={name}
            maxLength={128}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              const next = name.trim();
              if (next && next !== repo.name) void save({ name: next });
              else setName(repo.name);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            className={rowField}
          />
        </Row>
        <IconRow repo={repo} view={view} listed={listed} />
      </Section>
      <Section title={t("Instructions")}>
        <div className="px-4 py-3">
          <span className="block text-meta text-muted-foreground">
            {t("What every thread in it is told. They're pinned to its system prompt.")}
          </span>
          <textarea
            aria-label={t("Instructions")}
            rows={6}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            onBlur={() => {
              if (instructions !== (repo.instructions ?? "")) void save({ instructions });
            }}
            className={field}
          />
        </div>
      </Section>
    </>
  );
}
