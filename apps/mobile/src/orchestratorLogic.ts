// What the phone needs of an orchestrator (0093): its children with their status, the count its row
// folds them under, what a thread links back to, where a new one can be made, and starting one. No
// React Native here, so it's tested without it.
import { t } from "i18next";

import type { AgentRun, Orchestrator, Repo, Thread } from "../../desktop/src/protocol/generated/protocol";
import { childOrder, runAttention, type Attention } from "../../desktop/src/renderer/attention";
import { describeError } from "../../desktop/src/renderer/errors";
import { accountOptions } from "../../desktop/src/renderer/settings/shared";
import {
  asksOf,
  isRepository,
  orchestratorRuns,
  parentOf,
  threadOrchestrators,
  titleOf,
  type ThreadsState,
  type ThreadsView,
} from "../../desktop/src/renderer/threads";
import type { Computer } from "./fleet";

/** One of an orchestrator's child threads, as its row shows it. */
export interface OrchestratorChild {
  run: AgentRun;
  title: string;
  attention: Attention;
}

/**
 * An orchestrator's children, without its own runs, in the desktop's Agents panel's order: Needs
 * you, Working, Done, Failed, newest first within each.
 */
export function orchestratorChildren(
  state: ThreadsState,
  orchestrator: Orchestrator,
  inOrchestrator: ReadonlyMap<string, string>,
): OrchestratorChild[] {
  return orchestratorRuns(state, orchestrator.id, inOrchestrator)
    .filter((run) => run.id !== orchestrator.run && run.policy !== "noWrite")
    .map((run) => ({
      run,
      title: state.titles[run.id] ?? titleOf(run),
      attention: runAttention(run, asksOf(state, run.id)),
    }))
    .sort(
      (a, b) =>
        childOrder.indexOf(a.attention) - childOrder.indexOf(b.attention) ||
        b.run.createdAt.localeCompare(a.run.createdAt),
    );
}

/** "3 agents · 1 working", or nothing with no children. */
export function agentsLine(children: OrchestratorChild[]) {
  if (!children.length) return "";
  const working = children.filter((child) => child.attention === "working").length;
  return `${children.length} agent${children.length === 1 ? "" : "s"}${working ? ` · ${working} working` : ""}`;
}

/**
 * What a thread links back to: the orchestrator it's in, by name, which opens its chat, or else the
 * thread it was forked from. An orchestrator's own chat doesn't link to itself.
 */
export function parentLink(state: ThreadsState, thread: Thread): { name: string; runId: string } | undefined {
  const id = threadOrchestrators(state).get(thread.id);
  const orchestrator = state.orchestrators.find((o) => o.id === id);
  if (orchestrator?.run && orchestrator.run !== thread.id) return { name: orchestrator.name, runId: orchestrator.run };
  const parent = parentOf(state, thread);
  return parent && { name: state.titles[parent.id] ?? t("Thread"), runId: parent.id };
}

/** Whether a computer can run an orchestrator now. Offline, its capabilities are gone. */
export const canOrchestrate = (computer: Computer) => "orchestrator" in computer.view.capabilities;

/** Every repository a new orchestrator can be made on, in the order of `computers`. */
export const orchestratorPlaces = (computers: Computer[]): { computer: Computer; repo: Repo }[] =>
  computers
    .filter(canOrchestrate)
    .flatMap((computer) => computer.view.state.repos.filter(isRepository).map((repo) => ({ computer, repo })));

/**
 * Starts an orchestrator as run `runId` with `prompt`, its first message. As on the desktop, with no
 * orchestrator account on the computer it gets the first Claude account. Resolves to an error
 * message, or undefined.
 */
export async function startOrchestrator(view: ThreadsView, orchestrator: string, runId: string, prompt: string) {
  let error = await view.startOrchestrator(orchestrator, runId, prompt, [], {});
  const kind = error?.data?.kind;
  if (kind === "noDefaultAccount" || kind === "accountNotFound") {
    const accounts = await accountOptions(view.hostId);
    if (typeof accounts === "string") return accounts;
    const first = accounts[0];
    if (!first)
      return t("No account can run the orchestrator yet. Sign in to Claude Code, or add an API key, then try again.");
    error = await view.startOrchestrator(orchestrator, runId, prompt, [], { account: first.account });
  }
  return error && describeError(error);
}
