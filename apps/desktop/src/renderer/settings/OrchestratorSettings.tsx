import { t } from "i18next";
import { useEffect, useState } from "react";

import type { Orchestrator, RepoRef } from "../../protocol/generated/protocol";
import { useConnectedNow, useShownConnection } from "../ConnectionStatus";
import { useHosts, type Host } from "../hosts";
import { notify } from "../notifications";
import { autonomyLevels } from "../OrchestratorPermission";
import { orchestratorPrefs } from "../prefs";
import { ProjectIcon } from "../Sidebar";
import type { ThreadsView } from "../threads";
import { Picker } from "../ui";
import {
  allHosts,
  dangerButton,
  field,
  HostPicker,
  ListHeading,
  ListItem,
  ListPane,
  moveTab,
  outlineButton,
  PageTitle,
  quietButton,
  Row,
  rowField,
  Section,
  Switch,
} from "./parts";

const newOnes = "new";

/** What search can pick on New orchestrators' pane, rather than an orchestrator's. */
const defaultAnchors = ["full-access", "autonomy", "defaults"];

/** The autonomy levels as a Picker's options. */
const autonomyOptions = () =>
  autonomyLevels.map((a) => ({
    value: a.value,
    label: t(a.name),
    description: t(a.detail),
  }));

/** The line on who answers at `autonomy`, shown under its Row. */
const autonomyDetail = (autonomy: string) => {
  const detail = autonomyLevels.find((a) => a.value === autonomy)?.detail;
  return detail && t(detail);
};

/**
 * Settings > Orchestrators: on the left, what a new orchestrator starts with and the orchestrators of
 * every computer, or the one picked, and on the right the chosen one's settings, which save as they change.
 */
export function OrchestratorSettings({
  listed,
  focus,
}: {
  listed: { host: Host; view: ThreadsView }[];
  /** The setting search picked, which may be one only an orchestrator's pane has. */
  focus?: { anchor: string };
}) {
  const hosts = useHosts();
  const [scope, setScope] = useState(allHosts);
  const [chosen, setChosen] = useState(newOnes);
  const entries = listed
    .filter((l) => scope === allHosts || l.host.id === scope)
    .flatMap(({ host, view }) =>
      view.state.orchestrators.map((orchestrator) => ({ host, view, orchestrator })),
    );
  const keyOf = (e: (typeof entries)[number]) => `${e.host.id}/${e.orchestrator.id}`;
  const named = new Set(entries.map((e) => e.host.id)).size > 1;
  const current = entries.find((e) => keyOf(e) === chosen);
  const first = entries[0] && keyOf(entries[0]);
  useEffect(() => {
    if (focus && first) setChosen(defaultAnchors.includes(focus.anchor) ? newOnes : first);
  }, [focus]);

  return (
    <ListPane
      bar={<HostPicker hosts={hosts} value={scope} onChange={setScope} always all />}
      list={
        <div
          role="tablist"
          aria-label={t("Orchestrators")}
          aria-orientation="vertical"
          onKeyDown={moveTab}
        >
          <div className="pt-2">
            <ListItem
              chosen={!current}
              onClick={() => setChosen(newOnes)}
              title={t("New orchestrators")}
              detail={t("What each one starts with")}
            />
          </div>
          <ListHeading>{t("Orchestrators")}</ListHeading>
          {entries.map((e) => {
            const { orchestrator: o } = e;
            const place = o.repoPath
              ? o.repoPath.slice(o.repoPath.lastIndexOf("/") + 1)
              : t("No repository");
            return (
              <ListItem
                key={keyOf(e)}
                chosen={e === current}
                onClick={() => setChosen(keyOf(e))}
                icon={<ProjectIcon icon={o.icon} />}
                title={o.name}
                detail={named ? `${e.host.name} · ${place}` : place}
              />
            );
          })}
          {entries.length === 0 && (
            <p className="px-4 py-2 text-meta text-faint-foreground">{t("None yet.")}</p>
          )}
        </div>
      }
    >
      <div className="mx-auto max-w-3xl px-8 pt-6 pb-16">
        {current ? (
          <OrchestratorPane
            key={keyOf(current)}
            hostId={current.host.id}
            orchestrator={current.orchestrator}
            view={current.view}
          />
        ) : (
          <NewOrchestrators />
        )}
      </div>
    </ListPane>
  );
}

/** What New orchestrator's form starts with. */
function NewOrchestrators() {
  const prefs = orchestratorPrefs.use();
  return (
    <>
      <PageTitle title={t("New orchestrators")}>
        {t("What a new orchestrator's form starts with. Its form can change each one.")}
      </PageTitle>
      <Section title={t("Defaults")}>
        <Row
          title={t("Full access")}
          description={t(
            "It and its children run without asking. Off, they stay in Auto, which asks before risky commands.",
          )}
        >
          <Switch
            label={t("Full access")}
            checked={prefs.fullAccess}
            onChange={(fullAccess) => orchestratorPrefs.set({ ...prefs, fullAccess })}
          />
        </Row>
        <Row title={t("Autonomy")} description={autonomyDetail(prefs.autonomy)}>
          <Picker
            field
            label={t("Autonomy")}
            value={prefs.autonomy}
            onChange={(value) =>
              orchestratorPrefs.set({ ...prefs, autonomy: value as typeof prefs.autonomy })
            }
            options={autonomyOptions()}
            align="end"
            className="w-44"
            panelClassName="w-[24rem]"
          />
        </Row>
      </Section>
    </>
  );
}

/** One orchestrator's settings, each behind the capability that takes it. */
export function OrchestratorPane({
  hostId,
  orchestrator,
  view,
}: {
  hostId: string;
  orchestrator: Orchestrator;
  view: ThreadsView;
}) {
  const connection = useShownConnection(hostId);
  const capabilities = connection?.status === "connected" ? connection.capabilities : {};
  const [refs, setRefs] = useState<RepoRef[]>();
  const repoId = view.state.repos.find((r) => r.path === orchestrator.repoPath)?.id;
  const canRef = "integrationBranch" in capabilities && "repoRefs" in capabilities;
  const connectedNow = useConnectedNow(hostId);
  useEffect(() => {
    if (!canRef || !repoId || !connectedNow) return;
    let stale = false;
    void window.parallax.request(hostId, "repo/refs", { repo: repoId }).then((answer) => {
      if (!stale && "result" in answer) setRefs(answer.result.refs);
    });
    return () => {
      stale = true;
    };
  }, [hostId, canRef, repoId, connectedNow]);

  type Change = Parameters<ThreadsView["updateOrchestrator"]>[1];
  const save = async (change: Change) => {
    const failed = await view.updateOrchestrator(orchestrator.id, change);
    if (failed)
      notify({
        tone: "error",
        title: t("Couldn't save {{name}}", { name: orchestrator.name }),
        body: failed,
      });
  };
  const [name, setName] = useState(orchestrator.name);
  // Asking before the one-way move to Bypass (0042), as the sidebar's Full access does.
  const [confirming, setConfirming] = useState(false);
  const [checks, setChecks] = useState(orchestrator.checks ?? "");
  const base = orchestrator.baseBranch;

  return (
    <>
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-hover">
          <ProjectIcon icon={orchestrator.icon} className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <PageTitle title={orchestrator.name}>
            {orchestrator.repoPath || t("An orchestrator with no repository.")}
          </PageTitle>
        </div>
      </div>
      <Section title={t("General")}>
        <Row title={t("Name")} description={t("How the sidebar names it.")}>
          <input
            aria-label={t("Name")}
            value={name}
            maxLength={128}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              const next = name.trim();
              if (next && next !== orchestrator.name) void save({ name: next });
              else setName(orchestrator.name);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            className={rowField}
          />
        </Row>
        {"orchestratorPermission" in capabilities && (
          <Row
            title={t("Permissions")}
            description={
              orchestrator.permission === "bypass"
                ? t(
                    "Full access: it and its children run without asking. This can't be turned back.",
                  )
                : confirming
                  ? t("It and its children will run without asking. This can't be turned back.")
                  : t("Auto: it and its children ask before risky commands.")
            }
          >
            {orchestrator.permission === "bypass" ? (
              <span className="text-body text-muted-foreground">{t("Full access")}</span>
            ) : (
              <>
                {confirming ? (
                  <>
                    <button
                      type="button"
                      className={dangerButton}
                      onClick={() => void save({ permission: "bypass" })}
                    >
                      {t("Give full access")}
                    </button>
                    <button
                      type="button"
                      autoFocus
                      className={quietButton}
                      onClick={() => setConfirming(false)}
                    >
                      {t("Cancel")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className={outlineButton}
                    onClick={() => setConfirming(true)}
                  >
                    {t("Give full access")}
                  </button>
                )}
              </>
            )}
          </Row>
        )}
        {"orchestratorAutonomy" in capabilities && (
          <Row
            title={t("Autonomy")}
            description={autonomyDetail(orchestrator.autonomy ?? "routine")}
          >
            <Picker
              field
              label={t("Autonomy")}
              value={orchestrator.autonomy ?? "routine"}
              onChange={(value) => void save({ autonomy: value as Orchestrator["autonomy"] })}
              options={autonomyOptions()}
              align="end"
              className="w-44"
              panelClassName="w-[24rem]"
            />
          </Row>
        )}
      </Section>
      {"integrationBranch" in capabilities && !!orchestrator.repoPath && (
        <Section title="Git">
          <Row
            title={t("Base branch")}
            description={t(
              "Its integration branch is cut from this, and its pull request targets it. One already cut stays where it is.",
            )}
          >
            <Picker
              field
              label={t("Base branch")}
              placeholder={t("Default branch")}
              value={base ?? ""}
              onChange={(baseBranch) => void save({ baseBranch })}
              options={[
                ...(base && !refs?.some((r) => r.name === base)
                  ? [{ value: base, label: base }]
                  : []),
                ...(refs ?? []).map((r) => ({ value: r.name, label: r.name })),
              ]}
              search={(refs?.length ?? 0) > 8 ? t("Search branches") : undefined}
              align="end"
              className="w-56"
              panelClassName="w-72"
            />
          </Row>
          {orchestrator.integrationBranch && (
            <Row title={t("Integration branch")} description={t("Where its children land.")}>
              <code className="font-mono text-meta text-muted-foreground">
                {orchestrator.integrationBranch}
              </code>
            </Row>
          )}
          {"landing" in capabilities && (
            <Row
              title={t("Land automatically")}
              description={t(
                "Its children land without waiting for your approval. Those waiting keep waiting.",
              )}
            >
              <Switch
                label={t("Land automatically")}
                checked={orchestrator.autoLand ?? false}
                onChange={(autoLand) => void save({ autoLand })}
              />
            </Row>
          )}
        </Section>
      )}
      {"orchestratorPlacement" in capabilities && (
        <Section title={t("Children")}>
          <Row
            title={t("Children at once")}
            description={t("How many run together. Over it, a new child waits in its queue.")}
          >
            <input
              key={orchestrator.maxChildren}
              type="number"
              aria-label={t("Children at once")}
              min={1}
              max={100}
              defaultValue={orchestrator.maxChildren}
              onBlur={(e) => {
                const next = Math.round(Number(e.target.value));
                if (next >= 1 && next <= 100 && next !== orchestrator.maxChildren)
                  void save({ maxChildren: next });
                else e.target.value = String(orchestrator.maxChildren ?? "");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              className={`${rowField} w-24 text-right tabular-nums`}
            />
          </Row>
          <Row
            title={t("Allow API keys")}
            description={t(
              "Off, a child never starts on an API key account, nor falls back to one at a usage limit.",
            )}
          >
            <Switch
              label={t("Allow API keys")}
              checked={orchestrator.allowApiKeys ?? false}
              onChange={(allowApiKeys) => void save({ allowApiKeys })}
            />
          </Row>
        </Section>
      )}
      {"checks" in capabilities && !!orchestrator.repoPath && (
        <Section title={t("Checks")}>
          <div data-setting="checks" className="px-4 py-3">
            <span className="block text-meta text-muted-foreground">
              {t(
                "Runs in the integration worktree after each landing, for up to 30 minutes. Empty means a clean merge is enough.",
              )}
              {orchestrator.proposedChecks &&
                ` ${t("It proposed: {{checks}}. It never runs until you set it here.", { checks: orchestrator.proposedChecks })}`}
            </span>
            <textarea
              aria-label={t("Checks command")}
              rows={2}
              spellCheck={false}
              maxLength={4096}
              placeholder={orchestrator.proposedChecks ?? "pnpm test"}
              value={checks}
              onChange={(e) => setChecks(e.target.value)}
              onBlur={() => {
                if (checks !== (orchestrator.checks ?? "")) void save({ checks });
              }}
              className={`${field} font-mono`}
            />
          </div>
        </Section>
      )}
    </>
  );
}
