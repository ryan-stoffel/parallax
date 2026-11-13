// Threads attached to a message as context (PLX-378, decision 0047): how one looks as a chip, in
// the composer and in the sent message, and what attaching takes.
import { t } from "i18next";
import { MessagesSquare, Server } from "lucide-react";
import {
  createContext,
  Fragment,
  useContext,
  type ComponentType,
  type ReactNode,
  type SVGProps,
} from "react";

import type { ConnectionState } from "../preload/bridge";
import type { RemoteThreadRef } from "../protocol/generated/protocol";
import { lastPrompt } from "./attention";
import type { Host } from "./hosts";
import { Chip, withMentions } from "./Mention";
import { hostIcon } from "./RunTargetMenu";
import { age, backendLogos } from "./Sidebar";
import { memory } from "./stored";
import type { ThreadsState } from "./threads";

export type { Mentions } from "./threads";

/** One of the account's other computers (0101), which a message can name by its relay id. */
export interface OtherComputer {
  host: Host;
  relayId: string;
  connected: boolean;
  /** Whether its plxd has `agentWork`. */
  capable: boolean;
  /** Its threads, as the sidebar has them. */
  state: ThreadsState;
}

/** The open host's threads, for each one's title, provider, and time, and how to open one. */
export interface ThreadLinks {
  hostId: string;
  state: ThreadsState;
  open: (runId: string) => void;
  /** The other computers a message can name, and how to open a thread on one. */
  others?: readonly OtherComputer[];
  openOther?: (hostId: string, runId: string) => void;
}

/** What the composer needs to attach threads: the most a message takes, and the open thread, which can't attach itself. */
export interface AttachThreads extends ThreadLinks {
  max: number;
  self?: string;
}

/**
 * `links` for the composer, on a host whose plxd takes threads with a message (`threadContext`).
 * Undefined otherwise, which leaves the composer without them.
 */
export function attachThreads(
  connection: ConnectionState | undefined,
  links: ThreadLinks | undefined,
  self?: string,
): AttachThreads | undefined {
  const capabilities = connection?.status === "connected" ? connection.capabilities : undefined;
  const max = capabilities?.["threadContext"]?.["maxThreads"];
  if (!links || typeof max !== "number") return undefined;
  // A plxd without `agentWork` can't take a message naming them.
  const others = capabilities && "agentWork" in capabilities ? links.others : undefined;
  return { ...links, max, self, others };
}

/** Whether each other computer has `agentWork` on, by host id, as last read. */
export const agentWorkOn = memory<Readonly<Record<string, boolean>>>({});

/** Reads whether `hostId` has `agentWork` on. */
export async function readAgentWork(hostId: string) {
  const answer = await window.parallax
    .request(hostId, "host/settings/get", {})
    .catch(() => undefined);
  if (answer && "result" in answer)
    agentWorkOn.set({ ...agentWorkOn.get(), [hostId]: !!answer.result.agentWork });
}

/** A computer as a chip: its icon and name, or a server's and `name` for one no longer listed. */
export function ComputerChip({ host, name }: { host?: Host; name: string }) {
  return (
    <Chip
      tone="thread"
      title={t("Computer: {{name}}", { name })}
      icon={host ? hostIcon(host) : <Server />}
    >
      {name}
    </Chip>
  );
}

/** The open host's threads, for the transcript's chips, which open the thread they name. */
export const ThreadLinksContext = createContext<ThreadLinks | undefined>(undefined);

/** How a thread's chip and `@` row show it. `known` is false for one the host doesn't list. */
interface ThreadLook {
  title: string;
  Logo: ComponentType<SVGProps<SVGSVGElement>>;
  /** How long ago its newest message was sent, as the sidebar writes it: "3h". */
  age?: string;
  known: boolean;
}

/** Thread `runId` as the sidebar shows it: its title, its provider's logo, and when it was last prompted. */
export function lookOf(state: ThreadsState | undefined, runId: string): ThreadLook {
  const thread = state?.threads.find((t) => t.id === runId);
  const backend = state?.runs[runId]?.backend;
  return {
    title: state?.titles[runId] ?? thread?.title ?? (thread ? t("Untitled") : t("Unavailable")),
    Logo: (backend && backendLogos[backend]) || MessagesSquare,
    age: thread && age(lastPrompt(thread)),
    known: !!thread,
  };
}

/**
 * An attached thread as a chip, in the composer and in sent messages: its title, as `state` has it
 * now or else `saved`, then muted the other computer it's `on`. Its repository is in its tooltip.
 * With `onOpen` it's a button that opens the thread.
 */
export function ThreadRefChip({
  state,
  runId,
  saved,
  on,
  onOpen,
}: {
  state: ThreadsState | undefined;
  runId: string;
  saved: string;
  on?: Host;
  onOpen?: () => void;
}) {
  const look = lookOf(state, runId);
  const repoId = state?.threads.find((t) => t.id === runId)?.repo;
  const repo = state?.repos.find((r) => r.id === repoId);
  const shown = look.known ? look.title : saved || look.title;
  const named = { title: shown, computer: on?.name, repo: repo?.name };
  const inRepo = !!repo && !repo.scratch;
  const title = onOpen
    ? on
      ? t("Open {{title}} on {{computer}}", named)
      : t("Open {{title}}", named)
    : on
      ? inRepo
        ? t("Thread on {{computer}}: {{title}} in {{repo}}", named)
        : t("Thread on {{computer}}: {{title}}", named)
      : inRepo
        ? t("Thread: {{title}} in {{repo}}", named)
        : t("Thread: {{title}}", named);
  return (
    <Chip
      tone="thread"
      title={title}
      icon={<MessagesSquare aria-hidden />}
      onOpen={onOpen}
      end={on && <span>{t("on {{computer}}", { computer: on.name })}</span>}
    >
      {shown}
    </Chip>
  );
}

/** A thread a sent message attached, which opens while its computer lists it. */
function SentThreadChip({
  runId,
  saved,
  computer,
}: {
  runId: string;
  saved: string;
  computer?: string;
}) {
  const links = useContext(ThreadLinksContext);
  const other = computer ? links?.others?.find((o) => o.relayId === computer) : undefined;
  const state = computer ? other?.state : links?.state;
  const open =
    !state?.threads.some((t) => t.id === runId) || !links
      ? undefined
      : other
        ? () => links.openOther?.(other.host.id, runId)
        : () => links.open(runId);
  return <ThreadRefChip state={state} runId={runId} saved={saved} on={other?.host} onOpen={open} />;
}

/** `list`'s first item that `is` picks, taken out of it. */
function take<T>(list: T[], is: (item: T) => boolean): T | undefined {
  const at = list.findIndex(is);
  return at < 0 ? undefined : list.splice(at, 1)[0];
}

/**
 * A sent message's text, with its known tokens as chips, and each `@"Name"` it attached as that
 * chip where it was typed. Each token takes the next attachment of its name: a computer by its name,
 * a thread on another computer by its saved title, and a thread here by its title now. A token holds
 * the title at sending, so one left over goes to the next thread here, which is one renamed or
 * deleted since. What no token took leads the text. A token nothing takes stays text.
 */
export function SentText({
  text,
  threads,
  computers,
  remoteThreads,
  known,
}: {
  text: string;
  threads?: readonly string[];
  computers?: readonly string[];
  remoteThreads?: readonly RemoteThreadRef[];
  known: (token: string) => boolean;
}): ReactNode {
  const links = useContext(ThreadLinksContext);
  if (!threads?.length && !computers?.length && !remoteThreads?.length)
    return withMentions(text, known);
  const hosts = (computers ?? []).flatMap((id) => {
    const other = links?.others?.find((o) => o.relayId === id);
    return other ? [other.host] : [];
  });
  const remote = [...(remoteThreads ?? [])];
  const here = [...(threads ?? [])];
  const titleHere = (id: string) => {
    const look = lookOf(links?.state, id);
    return look.known ? look.title : undefined;
  };
  // Attachments' own titles first, longest first, since one may hold a `"` or read as a skill.
  const titles = [
    ...hosts.map((h) => h.name),
    ...remote.map((t) => t.title),
    ...here.flatMap((id) => titleHere(id) ?? []),
  ].sort((a, b) => b.length - a.length);
  const exact = titles.map((t) => `@"${t}"`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pieces = text.split(new RegExp(`(${[...exact, '@"[^"]*"'].join("|")})`));
  const titleAt = (i: number) => pieces[i]!.slice(2, -1);
  const chips: ReactNode[] = [];
  for (let i = 1; i < pieces.length; i += 2) {
    const title = titleAt(i);
    const host = take(hosts, (h) => h.name === title);
    const thread = host ? undefined : take(remote, (t) => t.title === title);
    const runId = host || thread ? undefined : take(here, (id) => titleHere(id) === title);
    if (host) chips[i] = <ComputerChip key={i} host={host} name={host.name} />;
    else if (thread)
      chips[i] = (
        <SentThreadChip key={i} runId={thread.runId} saved={title} computer={thread.computer} />
      );
    else if (runId) chips[i] = <SentThreadChip key={i} runId={runId} saved={title} />;
  }
  for (let i = 1; i < pieces.length; i += 2) {
    const runId = chips[i] ? undefined : here.shift();
    if (runId) chips[i] = <SentThreadChip key={i} runId={runId} saved={titleAt(i)} />;
  }
  return [
    ...hosts.map((h) => <ComputerChip key={h.id} host={h} name={h.name} />),
    ...remote.map((t) => (
      <SentThreadChip key={t.runId} runId={t.runId} saved={t.title} computer={t.computer} />
    )),
    ...here.map((runId) => <SentThreadChip key={runId} runId={runId} saved="" />),
    ...pieces.map((piece, i) =>
      i % 2 ? (chips[i] ?? piece) : <Fragment key={i}>{withMentions(piece, known)}</Fragment>,
    ),
  ];
}
