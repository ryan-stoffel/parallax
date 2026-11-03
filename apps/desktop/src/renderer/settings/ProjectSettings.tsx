import { Check, ChevronRight, Copy, RotateCcw } from "lucide-react";
import { useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { AgentPermission, ChosenIcon, Repo, RepoRef } from "../../protocol/generated/protocol";
import { accessPrefs } from "../accessPrefs";
import { useCopy } from "../AgentChat";
import { accessOptions } from "../Composer";
import { EffortMenu } from "../EffortMenu";
import { localId, useHosts, type Host } from "../hosts";
import { IconPicker } from "../IconPicker";
import { readIcon } from "../images";
import { ModelMenu } from "../ModelMenu";
import { useCatalog, type Provider } from "../models";
import { notify } from "../notifications";
import { newThreadPrefs, setRepoPrefs, useRepoPrefs, type RepoPrefs } from "../prefs";
import { defaultIcon } from "../projectIcons";
import { workspaces } from "../RunTargetMenu";
import { RepoIcon, SharedRepoIcons } from "../Sidebar";
import { isRepository, repoIconOf, setRepoIcons, type ThreadsView } from "../threads";
import { IconButton, Picker } from "../ui";
import { field, HostPicker, outlineButton, PageTitle, Row, rowField, Section } from "./parts";
import { RepoScripts } from "./ScriptSettings";

/** The menu's choice for the list of them all, which no entry's id can be. */
const allProjects = "#all";

/** What search can pick on a repository's page. */
const repoAnchors = ["new-thread-defaults", "scripts", "from-parallax-json", "git"];

/** The composer's own menus are borderless; on a settings row they get a field's outline. */
const pickerBox = "rounded-lg border border-border bg-background";

/**
 * Settings > Projects: a menu of the host's repositories and Projects, opening on the list of them.
 * Choosing one shows its icon and its own settings. A repository has its own new thread defaults
 * and scripts, and a Project its name and instructions.
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
  const [hostId, setHostId] = useState(localId);
  const view = listed.find((l) => l.host.id === hostId)?.view;
  const entries = view?.state.repos ?? [];
  const repos = entries.filter(isRepository);
  const chats = entries.filter((r) => r.project);
  const all = [...repos, ...chats];
  const [chosen, setChosen] = useState<string>();
  const current = all.find((r) => r.id === chosen);
  useEffect(() => {
    if (!focus) return;
    const among = (rows: Repo[]) => (was?: string) =>
      rows.some((r) => r.id === was) ? was : rows[0]?.id;
    if (focus.anchor === "instructions") setChosen(among(chats));
    else if (focus.anchor === "project-icon") setChosen(among(all));
    else if (repoAnchors.includes(focus.anchor)) setChosen(among(repos));
  }, [focus]);

  return (
    <>
      <div className="mb-8">
        <HostPicker
          hosts={hosts}
          value={hostId}
          onChange={setHostId}
          always
          scope={
            <Picker
              field
              label="Project"
              value={current?.id ?? allProjects}
              onChange={(id) => setChosen(id === allProjects ? undefined : id)}
              options={[
                { value: allProjects, label: "All projects" },
                ...all.map((r) => ({
                  value: r.id,
                  label: r.name,
                  icon: <RepoIcon repo={r} />,
                })),
              ]}
              search={all.length > 8 ? "Search projects" : undefined}
              className="max-w-56"
              panelClassName="min-w-56"
            />
          }
        />
      </div>
      {!view ? (
        <PageTitle title="Projects">This host isn&apos;t connected.</PageTitle>
      ) : current?.project ? (
        <ChatProject key={current.id} repo={current} view={view} listed={listed} />
      ) : current ? (
        <Repository
          key={`${hostId}/${current.id}`}
          hostId={hostId}
          repo={current}
          view={view}
          listed={listed}
        />
      ) : (
        <>
          <p className="mb-4 text-reading text-muted-foreground">
            {all.length
              ? "Choose a project to manage its icon and its own settings."
              : "Add a repository from the sidebar, and its settings show here."}
          </p>
          {repos.length > 0 && (
            <ProjectList
              title="Repositories"
              rows={repos}
              detail={(r) => <RepoDetail hostId={hostId} repo={r} />}
              onChoose={setChosen}
            />
          )}
          {chats.length > 0 && (
            <ProjectList
              title="Projects"
              rows={chats}
              detail={() => "Chats with their own instructions"}
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
  rows: Repo[];
  detail: (repo: Repo) => ReactNode;
  onChoose: (id: string) => void;
}) {
  return (
    <Section title={title}>
      {rows.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => onChoose(r.id)}
          className="flex w-full items-center gap-3 border-b border-border/70 px-4 py-2.5 text-left first:rounded-t-xl last:rounded-b-xl last:border-b-0 hover:bg-hover"
        >
          <RepoIcon repo={r} size="size-5" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body font-medium">{r.name}</span>
            <span className="block truncate text-meta text-muted-foreground">{detail(r)}</span>
          </span>
          <ChevronRight aria-hidden className="size-4 shrink-0 text-faint-foreground" />
        </button>
      ))}
    </Section>
  );
}

/** A repository's path, and how many defaults it sets of its own. */
function RepoDetail({ hostId, repo }: { hostId: string; repo: Repo }) {
  const count = Object.keys(useRepoPrefs(hostId, repo.id)).length;
  return (
    <>
      {repo.path}
      {count > 0 && ` · ${count} ${count === 1 ? "default" : "defaults"} changed`}
    </>
  );
}

/**
 * A repository's or Project's icon, with what's on it now, Choose icon, and Choose file where the
 * host keeps images. A repository's goes to its copies on every computer, as the sidebar's does
 * (0033). Each pick saves at once.
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
  const picker = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const pickerId = useId();
  const icon = repoIconOf(repo, useContext(SharedRepoIcons));
  const maxBytes = view.iconImageBytes;
  const save = (next: ChosenIcon) => {
    if (repo.project)
      void view.updateRepo(repo.id, { icon: next }).then((failed) => {
        if (failed)
          notify({ tone: "error", title: `Couldn't save ${repo.name}'s icon`, body: failed });
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
      notify({ tone: "error", title: "Couldn't use that image", body: image });
    else {
      const { name, color } = icon ?? defaultIcon;
      save({ name, ...(color && { color }), image });
    }
  };
  return (
    <Row
      title="Project icon"
      description={
        !icon
          ? repo.project
            ? "The Project glyph"
            : "Its initials"
          : icon.image
            ? "An uploaded image"
            : [icon.name, icon.color].filter(Boolean).join(" · ")
      }
    >
      <RepoIcon repo={repo} size="size-6" />
      <button
        type="button"
        className={outlineButton}
        onClick={(e) => picker.current?.showPopover({ source: e.currentTarget })}
      >
        Choose icon
      </button>
      {maxBytes !== undefined && (
        <>
          <button type="button" className={outlineButton} onClick={() => file.current?.click()}>
            Choose file
          </button>
          <input
            ref={file}
            type="file"
            hidden
            aria-label={`Image for ${repo.name}'s icon`}
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
      <IconPicker ref={picker} id={pickerId} value={icon} onPick={save} maxImageBytes={maxBytes} />
    </Row>
  );
}

/** Resets a default to follow the global one, shown only once it's set. */
function ResetDefault({ label, set, reset }: { label: string; set: boolean; reset: () => void }) {
  return (
    set && (
      <IconButton label={`Use the default ${label}`} onClick={reset}>
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

/** A repository's path, its icon, its own new thread defaults, its scripts, and its git. */
function Repository({
  hostId,
  repo,
  view,
  listed,
}: {
  hostId: string;
  repo: Repo;
  view: ThreadsView;
  listed: { view: ThreadsView }[];
}) {
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
  const set = (change: RepoPrefs) => setRepoPrefs(hostId, repo.id, change);

  const blocked: Partial<Record<Provider, string>> = {};
  for (const i of catalog.instances)
    if (!i.enabled) blocked[i.id] = `${i.name} is turned off in Settings > Providers.`;
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
          <span className="truncate">{repo.path}</span>
          <IconButton size="sm" label="Copy path" onClick={() => copy(repo.path)}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          </IconButton>
        </span>
      </PageTitle>
      {"threadAttention" in view.capabilities && (
        <Section title="General">
          <IconRow repo={repo} view={view} listed={listed} />
        </Section>
      )}
      <Section title="New thread defaults">
        <Row title="Model" description="The model a new thread here starts on.">
          <ResetDefault
            label="model"
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
            <span className="text-body text-muted-foreground">No models</span>
          )}
        </Row>
        {model && instance?.efforts !== false && (
          <Row title="Reasoning" description="How hard it thinks, and its context and fast mode.">
            <ResetDefault
              label="reasoning"
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
          <Row title="Permissions" description="What a new thread here may do without asking.">
            <ResetDefault
              label="permissions"
              set={!!prefs.permission}
              reset={() => set({ permission: undefined })}
            />
            <Picker
              field
              label="Permissions"
              value={permission}
              onChange={(value) => set({ permission: value as AgentPermission })}
              options={permissions.map((p) => accessOptions[p])}
              align="end"
              className="w-56"
              panelClassName="w-[25rem]"
            />
          </Row>
        )}
        <Row title="Workspace" description="Where a new thread here works.">
          <ResetDefault
            label="workspace"
            set={!!prefs.workspace}
            reset={() => set({ workspace: undefined })}
          />
          <Picker
            field
            label="Workspace"
            value={workspace}
            onChange={(value) => set({ workspace: value as RepoPrefs["workspace"] })}
            options={workspaces}
            align="end"
            className="w-56"
            panelClassName="w-[24rem]"
          />
        </Row>
        <Row title="Base branch" description="The branch a new worktree here starts from.">
          <ResetDefault
            label="base branch"
            set={!!prefs.base}
            reset={() => set({ base: undefined })}
          />
          <Picker
            field
            label="Base branch"
            value={prefs.base ?? ""}
            onChange={(base) => set({ base: base || undefined })}
            options={[
              {
                value: "",
                label: global.worktreeBase === "current" ? "Current branch" : "Default branch",
                hint: "default",
              },
              ...(prefs.base && !refs?.some((r) => r.name === prefs.base)
                ? [{ value: prefs.base, label: prefs.base }]
                : []),
              ...(refs ?? []).map((r) => ({ value: r.name, label: r.name })),
            ]}
            search={(refs?.length ?? 0) > 8 ? "Search branches" : undefined}
            align="end"
            className="w-56"
            panelClassName="w-72"
          />
        </Row>
      </Section>
      <RepoScripts hostId={hostId} repo={repo} />
      <Section title="Git">
        <Row title="Remote" description="Where its pull requests go.">
          <GitValue text={remote} missing="No origin" />
        </Row>
        <Row title="Current branch" description="What its checkout has out.">
          <GitValue text={refs?.find((r) => r.current)?.name} missing="Detached" />
        </Row>
        <Row title="Default branch" description="What origin/HEAD names.">
          <GitValue text={refs?.find((r) => r.default)?.name} missing="Unknown" />
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
    if (failed) notify({ tone: "error", title: `Couldn't save ${repo.name}`, body: failed });
  };
  return (
    <>
      <PageTitle title={repo.name}>A group of chats, with no repository of yours.</PageTitle>
      <Section title="General">
        <Row title="Name" description="How the sidebar names it.">
          <input
            aria-label="Name"
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
      <Section title="Instructions">
        <div className="px-4 py-3">
          <span className="block text-meta text-muted-foreground">
            What every thread in it is told. They&apos;re pinned to its system prompt.
          </span>
          <textarea
            aria-label="Instructions"
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
