import { Check, Copy, FolderGit2, MessagesSquare, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import type { AgentPermission, Repo, RepoRef } from "../../protocol/generated/protocol";
import { accessPrefs } from "../accessPrefs";
import { useCopy } from "../AgentChat";
import { accessOptions } from "../Composer";
import { EffortMenu } from "../EffortMenu";
import { localId, useHosts, type Host } from "../hosts";
import { ModelMenu } from "../ModelMenu";
import { useCatalog, type Provider } from "../models";
import { notify } from "../notifications";
import { newThreadPrefs, setRepoPrefs, useRepoPrefs, type RepoPrefs } from "../prefs";
import { workspaces } from "../RunTargetMenu";
import { isRepository, type ThreadsView } from "../threads";
import { IconButton, Picker } from "../ui";
import {
  field,
  HostPicker,
  ListHeading,
  ListItem,
  ListPane,
  moveTab,
  PageTitle,
  Row,
  rowField,
  Section,
} from "./parts";
import { RepoScripts } from "./ScriptSettings";

/** The composer's own menus are borderless; on a settings row they get a field's outline. */
const pickerBox = "rounded-lg border border-border bg-background";

/**
 * Settings > Projects: a host's repositories and Projects on the left, and the chosen one's own
 * settings on the right. A repository has its own new thread defaults and scripts, and a Project
 * its name and instructions.
 */
export function ProjectSettings({
  listed,
  focus,
}: {
  listed: { host: Host; view: ThreadsView }[];
  /** The setting search picked: Instructions is only a Project's. */
  focus?: { anchor: string };
}) {
  const hosts = useHosts();
  const [hostId, setHostId] = useState(localId);
  const view = listed.find((l) => l.host.id === hostId)?.view;
  const entries = view?.state.repos ?? [];
  const repos = entries.filter(isRepository);
  const chats = entries.filter((r) => r.project);
  const [chosen, setChosen] = useState<string>();
  const current = [...repos, ...chats].find((r) => r.id === chosen) ?? repos[0] ?? chats[0];
  const firstChat = chats[0]?.id;
  useEffect(() => {
    if (focus?.anchor === "instructions" && firstChat) setChosen(firstChat);
  }, [focus]);

  return (
    <ListPane
      bar={<HostPicker hosts={hosts} value={hostId} onChange={setHostId} always />}
      list={
        <div role="tablist" aria-label="Projects" aria-orientation="vertical" onKeyDown={moveTab}>
          <ListHeading>Repositories</ListHeading>
          {repos.map((r) => (
            <ListItem
              key={r.id}
              chosen={r === current}
              onClick={() => setChosen(r.id)}
              icon={<FolderGit2 aria-hidden className="text-faint-foreground" />}
              title={r.name}
              detail={<RepoOverrides hostId={hostId} repo={r.id} />}
            />
          ))}
          {repos.length === 0 && (
            <p className="px-4 py-2 text-meta text-faint-foreground">None on this host yet.</p>
          )}
          {chats.length > 0 && <ListHeading>Projects</ListHeading>}
          {chats.map((r) => (
            <ListItem
              key={r.id}
              chosen={r === current}
              onClick={() => setChosen(r.id)}
              icon={<MessagesSquare aria-hidden className="text-faint-foreground" />}
              title={r.name}
            />
          ))}
        </div>
      }
    >
      <div className="mx-auto max-w-3xl px-8 pt-6 pb-16">
        {!current || !view ? (
          <PageTitle title="Projects">
            Add a repository from the sidebar, and its settings show here.
          </PageTitle>
        ) : current.project ? (
          <ChatProject key={current.id} repo={current} view={view} />
        ) : (
          <Repository key={`${hostId}/${current.id}`} hostId={hostId} repo={current} />
        )}
      </div>
    </ListPane>
  );
}

/** How many defaults a repository sets of its own, for its row. */
function RepoOverrides({ hostId, repo }: { hostId: string; repo: string }) {
  const count = Object.keys(useRepoPrefs(hostId, repo)).length;
  return (
    <>{count ? `${count} ${count === 1 ? "default" : "defaults"} changed` : "Using defaults"}</>
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

/** A repository's path, its own new thread defaults, its scripts, and its git. */
function Repository({ hostId, repo }: { hostId: string; repo: Repo }) {
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

/** A Project's name and instructions, which every thread in it gets (0090). */
function ChatProject({ repo, view }: { repo: Repo; view: ThreadsView }) {
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
