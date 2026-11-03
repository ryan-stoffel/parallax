import { Network } from "lucide-react";
import { useEffect, useState } from "react";

import type { Orchestrator, RepoRef } from "../../protocol/generated/protocol";
import { useConnection } from "../ConnectionStatus";
import { localId, useHosts, type Host } from "../hosts";
import { notify } from "../notifications";
import { autonomyLevels } from "../OrchestratorPermission";
import { orchestratorPrefs } from "../prefs";
import type { ThreadsView } from "../threads";
import { Picker } from "../ui";
import {
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
const autonomyOptions = autonomyLevels.map((a) => ({
  value: a.value,
  label: a.name,
  description: a.detail,
}));

/**
 * Settings > Orchestrators: on the left, what a new orchestrator starts with and each of a host's
 * orchestrators, and on the right the chosen one's settings, which save as they change.
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
  const [hostId, setHostId] = useState(localId);
  const [chosen, setChosen] = useState(newOnes);
  const view = listed.find((l) => l.host.id === hostId)?.view;
  const orchestrators = view?.state.orchestrators ?? [];
  const current = orchestrators.find((o) => o.id === chosen);
  const first = orchestrators[0]?.id;
  useEffect(() => {
    if (focus && first) setChosen(defaultAnchors.includes(focus.anchor) ? newOnes : first);
  }, [focus]);

  return (
    <ListPane
      bar={<HostPicker hosts={hosts} value={hostId} onChange={setHostId} always />}
      list={
        <div
          role="tablist"
          aria-label="Orchestrators"
          aria-orientation="vertical"
          onKeyDown={moveTab}
        >
          <div className="pt-2">
            <ListItem
              chosen={!current}
              onClick={() => setChosen(newOnes)}
              title="New orchestrators"
              detail="What each one starts with"
            />
          </div>
          <ListHeading>On this host</ListHeading>
          {orchestrators.map((o) => (
            <ListItem
              key={o.id}
              chosen={o === current}
              onClick={() => setChosen(o.id)}
              icon={<Network aria-hidden className="text-faint-foreground" />}
              title={o.name}
              detail={
                o.repoPath ? o.repoPath.slice(o.repoPath.lastIndexOf("/") + 1) : "No repository"
              }
            />
          ))}
          {orchestrators.length === 0 && (
            <p className="px-4 py-2 text-meta text-faint-foreground">None yet.</p>
          )}
        </div>
      }
    >
      <div className="mx-auto max-w-3xl px-8 pt-6 pb-16">
        {current && view ? (
          <OrchestratorPane key={current.id} hostId={hostId} orchestrator={current} view={view} />
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
      <PageTitle title="New orchestrators">
        What a new orchestrator&apos;s form starts with. Its form can change each one.
      </PageTitle>
      <Section title="Defaults">
        <Row
          title="Full access"
          description="It and its children run without asking. Off, they stay in Auto, which asks before risky commands."
        >
          <Switch
            label="Full access"
            checked={prefs.fullAccess}
            onChange={(fullAccess) => orchestratorPrefs.set({ ...prefs, fullAccess })}
          />
        </Row>
        <Row
          title="Autonomy"
          description={autonomyLevels.find((a) => a.value === prefs.autonomy)?.detail}
        >
          <Picker
            field
            label="Autonomy"
            value={prefs.autonomy}
            onChange={(value) =>
              orchestratorPrefs.set({ ...prefs, autonomy: value as typeof prefs.autonomy })
            }
            options={autonomyOptions}
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
function OrchestratorPane({
  hostId,
  orchestrator,
  view,
}: {
  hostId: string;
  orchestrator: Orchestrator;
  view: ThreadsView;
}) {
  const connection = useConnection(hostId);
  const capabilities = connection?.status === "connected" ? connection.capabilities : {};
  const [refs, setRefs] = useState<RepoRef[]>();
  const repoId = view.state.repos.find((r) => r.path === orchestrator.repoPath)?.id;
  const canRef = "integrationBranch" in capabilities && "repoRefs" in capabilities;
  useEffect(() => {
    if (!canRef || !repoId) return;
    let stale = false;
    void window.parallax.request(hostId, "repo/refs", { repo: repoId }).then((answer) => {
      if (!stale && "result" in answer) setRefs(answer.result.refs);
    });
    return () => {
      stale = true;
    };
  }, [hostId, canRef, repoId]);

  type Change = Parameters<ThreadsView["updateOrchestrator"]>[1];
  const save = async (change: Change) => {
    const failed = await view.updateOrchestrator(orchestrator.id, change);
    if (failed)
      notify({ tone: "error", title: `Couldn't save ${orchestrator.name}`, body: failed });
  };
  const [name, setName] = useState(orchestrator.name);
  // Asking before the one-way move to Bypass (0042), as the sidebar's Full access does.
  const [confirming, setConfirming] = useState(false);
  const [checks, setChecks] = useState(orchestrator.checks ?? "");
  const base = orchestrator.baseBranch;

  return (
    <>
      <PageTitle title={orchestrator.name}>
        {orchestrator.repoPath || "An orchestrator with no repository."}
      </PageTitle>
      <Section title="General">
        <Row title="Name" description="How the sidebar names it.">
          <input
            aria-label="Name"
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
            title="Permissions"
            description={
              orchestrator.permission === "bypass"
                ? "Full access: it and its children run without asking. This can't be turned back."
                : confirming
                  ? "It and its children will run without asking. This can't be turned back."
                  : "Auto: it and its children ask before risky commands."
            }
          >
            {orchestrator.permission === "bypass" ? (
              <span className="text-body text-muted-foreground">Full access</span>
            ) : (
              <>
                {confirming ? (
                  <>
                    <button
                      type="button"
                      className={dangerButton}
                      onClick={() => void save({ permission: "bypass" })}
                    >
                      Give full access
                    </button>
                    <button
                      type="button"
                      autoFocus
                      className={quietButton}
                      onClick={() => setConfirming(false)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className={outlineButton}
                    onClick={() => setConfirming(true)}
                  >
                    Give full access
                  </button>
                )}
              </>
            )}
          </Row>
        )}
        {"orchestratorAutonomy" in capabilities && (
          <Row
            title="Autonomy"
            description={
              autonomyLevels.find((a) => a.value === (orchestrator.autonomy ?? "routine"))?.detail
            }
          >
            <Picker
              field
              label="Autonomy"
              value={orchestrator.autonomy ?? "routine"}
              onChange={(value) => void save({ autonomy: value as Orchestrator["autonomy"] })}
              options={autonomyOptions}
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
            title="Base branch"
            description="Its integration branch is cut from this, and its pull request targets it. One already cut stays where it is."
          >
            <Picker
              field
              label="Base branch"
              placeholder="Default branch"
              value={base ?? ""}
              onChange={(baseBranch) => void save({ baseBranch })}
              options={[
                ...(base && !refs?.some((r) => r.name === base)
                  ? [{ value: base, label: base }]
                  : []),
                ...(refs ?? []).map((r) => ({ value: r.name, label: r.name })),
              ]}
              search={(refs?.length ?? 0) > 8 ? "Search branches" : undefined}
              align="end"
              className="w-56"
              panelClassName="w-72"
            />
          </Row>
          {orchestrator.integrationBranch && (
            <Row title="Integration branch" description="Where its children land.">
              <code className="font-mono text-meta text-muted-foreground">
                {orchestrator.integrationBranch}
              </code>
            </Row>
          )}
          {"landing" in capabilities && (
            <Row
              title="Land automatically"
              description="Its children land without waiting for your approval. Those waiting keep waiting."
            >
              <Switch
                label="Land automatically"
                checked={orchestrator.autoLand ?? false}
                onChange={(autoLand) => void save({ autoLand })}
              />
            </Row>
          )}
        </Section>
      )}
      {"orchestratorPlacement" in capabilities && (
        <Section title="Children">
          <Row
            title="Children at once"
            description="How many run together. Over it, a new child waits in its queue."
          >
            <input
              key={orchestrator.maxChildren}
              type="number"
              aria-label="Children at once"
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
            title="Allow API keys"
            description="Off, a child never starts on an API key account, nor falls back to one at a usage limit."
          >
            <Switch
              label="Allow API keys"
              checked={orchestrator.allowApiKeys ?? false}
              onChange={(allowApiKeys) => void save({ allowApiKeys })}
            />
          </Row>
        </Section>
      )}
      {"checks" in capabilities && !!orchestrator.repoPath && (
        <Section title="Checks">
          <div data-setting="checks" className="px-4 py-3">
            <span className="block text-meta text-muted-foreground">
              Runs in the integration worktree after each landing, for up to 30 minutes. Empty means
              a clean merge is enough.
              {orchestrator.proposedChecks &&
                ` It proposed: ${orchestrator.proposedChecks}. It never runs until you set it here.`}
            </span>
            <textarea
              aria-label="Checks command"
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
