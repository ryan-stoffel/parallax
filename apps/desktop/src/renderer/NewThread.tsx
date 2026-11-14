import { t } from "i18next";
import { Folder, MessagesSquare, Plus, SquareDashed } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { PromptImage, Repo } from "../protocol/generated/protocol";
import { CloneDialog } from "./AddDialog";
import { parseProgress } from "./CloneProgress";
import { TranscriptView } from "./AgentChat";
import type { CloneAsk } from "./clone";
import { Composer } from "./Composer";
import { useConnectedNow, useRealConnections, useShownConnection } from "./ConnectionStatus";
import { drafts, isEmpty, type ComposerContents } from "./drafts";
import { describeError } from "./errors";
import type { Host } from "./hosts";
import { imageCaps } from "./images";
import {
  answerMs,
  askComputer,
  assess,
  loadBalancer,
  pickComputer,
  tiesOf,
  whyText,
  type Candidate,
} from "./loadBalancer";
import { uploadBytes } from "./uploads";
import type { RunOptions } from "./models";
import { dismiss, notify, update } from "./notifications";
import { newThreadPrefs, useRepoPrefs } from "./prefs";
import { RefMenu } from "./RefMenu";
import { accountOptions, defaultBackend, type AccountOption } from "./settings/shared";
import { RunTargetMenu, type Workspace } from "./RunTargetMenu";
import {
  attachThreads,
  ThreadLinksContext,
  type Mentions,
  type ThreadLinks,
} from "./threadContext";
import {
  noRepo,
  repoless,
  type OtherRepo,
  type ThreadGroup,
  type ThreadStart,
  type ThreadsView,
} from "./threads";
import { ariaKeyshortcut, bindingOf, useShortcutLabel } from "./keybindings";
import { Picker } from "./ui";
import { uuidv7 } from "./uuidv7";

// The picker's value that opens the folder picker instead of choosing a group.
const addRepository = "add-repository";
// The picker's value for another computer's repository: entry ids are only unique per computer.
const elsewhereValue = (o: OtherRepo) => `${o.host.id}/${o.repo.id}`;

interface NewThreadProps {
  hostId: string;
  /** The computers a thread can run on. */
  hosts: Host[];
  /**
   * Called when the user picks another computer to run the thread on, which may clone the
   * repository there (PLX-905), sending git's progress to `onProgress`, or add it `at` the path
   * the clone dialog put it. Resolves to why New Thread couldn't move there, for people, to where
   * to ask to clone the repository there, or to its entry there once it added or cloned it. New
   * Thread shows the clone's progress and a failure as notifications (PLX-930).
   */
  onHostChange: (
    hostId: string,
    how?: { at?: string; onProgress?: (line: string) => void },
  ) => Promise<string | CloneAsk | Repo | undefined>;
  /** Repositories and Chat, as the sidebar groups them. */
  groups: ThreadGroup[];
  groupId: string;
  onGroupChange: (groupId: string) => void;
  /** The other computers' repositories, which the repository menu lists after the host's own. */
  elsewhere: OtherRepo[];
  /** Called when the user picks one of `elsewhere`: New Thread opens on its computer with it. */
  onPickElsewhere: (hostId: string, groupId: string) => void;
  /** The computers, by id, that lack the picked repository, for the Computer menu. */
  missing?: ReadonlySet<string>;
  /** The computers, by id, that list the picked repository, which the Load Balancer can pick. */
  listing?: ReadonlySet<string>;
  /** Whether this is a new draft the Load Balancer places, not one opened on a computer on purpose. */
  balanced?: boolean;
  /** Whether the open host's repositories are in, so the Load Balancer knows which it's placing. */
  listed?: boolean;
  /** Opens Settings where the Load Balancer's computers are chosen. */
  onOpenLoadBalancer?: () => void;
  /** Whether another computer has a repository of this name, so the heading names the computer. */
  shared?: boolean;
  /** Whether the host is this computer, so its folders can be picked. */
  local: boolean;
  addRepo: (path: string) => Promise<Repo | string>;
  start: ThreadsView["start"];
  /** Whether the host's plxd takes a thread's model, effort, and permission (`runOptions`). */
  runOptions: boolean;
  /** Called once plxd has the thread. `background` when Cmd/Ctrl+Enter started it, so New Thread stays open. */
  onStarted: (runId: string, background: boolean) => void;
  disabledReason?: string;
  /** The host's threads, which the composer attaches where plxd takes them (PLX-378). */
  threadLinks?: ThreadLinks;
  /** The draft it reopens (PLX-788), by id. Read once, as it mounts. */
  draftId?: string;
  /** How many times Settings has closed. The default is read again each time, as it may have changed there. */
  settingsClosed?: number;
  /** Shown under the composer until a thread starts, as a Project's page (0090). */
  below?: ReactNode;
  /** Shown over the composer in place of its question, as a Project's header (0090). */
  header?: ReactNode;
  /** A Project's tray under the composer: the computers it can run on (0090). */
  tray?: ReactNode;
  /**
   * A column beside `below`, as a Project's instructions and files beside its threads (0090). With
   * it, New thread lays out as a page: the header, the composer at full width, then `below` and
   * this side by side.
   */
  aside?: ReactNode;
}

/** One start of a thread. Retrying it reuses its run id, so plxd never makes a second thread (0007). */
type Attempt = ThreadStart & {
  /** Started with Cmd/Ctrl+Enter, leaving New Thread open. */
  background: boolean;
};

const noAccounts = () =>
  t(
    "No account can run this thread yet. Sign in to Claude Code, or add an API key, then try again.",
  );

// Each host's worker backend once read, so New Thread shows its choices on its first render.
const workerBackends = new Map<string, string | undefined>();

/**
 * Where the Load Balancer (0101) stands for a draft. `new` hasn't asked yet, `checking` is asking,
 * `picked` holds its pick, and `none` found no computer, saying why of each. `pinned` left the draft
 * where it is, since what it holds is tied there. `manual` is the user's own pick, or a draft opened
 * on a computer on purpose.
 */
type Balance =
  | { state: "new" | "manual" }
  | { state: "checking"; id: number }
  | { state: "picked"; why: Record<string, string> }
  | { state: "none"; why: Record<string, string>; leftOut: boolean }
  | { state: "pinned"; pinned: "threads" | "files" };

// What each draft's Load Balancer last settled on, since opening a tab again mounts its screen anew.
const balances = new Map<string, Balance>();
let checks = 0;

// Stands in for the heading's repository button while its sentence is translated.
const buttonMark = "\u0000";

const noRoom = () => t("No computer can take this thread. Pick one under the box.");

/**
 * The New Thread screen: a centered composer, and under it where the thread runs. When the host
 * has no usable default account for threads, it picks the only one there is (and says so), or asks
 * which to use, sets it as the default, and retries the same start. plxd never picks one itself, so it never spends
 * a subscription the user didn't choose.
 */
export function NewThread({
  hostId,
  hosts,
  onHostChange,
  groups,
  groupId,
  onGroupChange,
  elsewhere,
  onPickElsewhere,
  missing,
  listing,
  balanced = false,
  listed = true,
  onOpenLoadBalancer,
  shared,
  local,
  addRepo,
  start,
  runOptions,
  onStarted,
  disabledReason,
  threadLinks,
  settingsClosed,
  draftId: reopened,
  below,
  header,
  tray,
  aside,
}: NewThreadProps) {
  // The no-repo start's shortcut, as Settings > Keybindings has it.
  const noRepoKeys = useShortcutLabel("noRepoThread");
  const noRepoBinding = bindingOf("noRepoThread");
  // ponytail: read as the screen opens and as Settings closes, since plxd has no event for a
  // changed default. One changed elsewhere shows once New Thread opens again. Until then plxd refuses an effort or
  // permission the new backend can't run, but not the old backend's model: that run fails in the CLI.
  // The backend shown, with the host it was read for: another host's stands in until this one's is.
  const [read, setRead] = useState(() =>
    workerBackends.has(hostId) ? { hostId, backend: workerBackends.get(hostId) } : undefined,
  );
  const connectedNow = useConnectedNow(hostId);
  const backend = read?.backend;
  useEffect(() => {
    if (!runOptions || !connectedNow) return;
    let live = true;
    void defaultBackend(hostId, "worker").then((b) => {
      workerBackends.set(hostId, b);
      if (live) setRead({ hostId, backend: b });
    });
    return () => {
      live = false;
    };
  }, [hostId, runOptions, connectedNow, settingsClosed]);
  const connection = useShownConnection(hostId);
  const connected = connection?.status === "connected";
  // Open while the host needs an account for the failed start.
  const [choices, setChoices] = useState<AccountOption[]>();
  const [picked, setPicked] = useState(0);
  const [choosing, setChoosing] = useState(false);
  // The prompt, images, and threads of a start in flight. Starting takes plxd a moment (a
  // worktree, a worker), so the screen shows them as the thread it opens meanwhile.
  const [starting, setStarting] = useState<{
    prompt: string;
    images: PromptImage[];
    threads: string[];
    mentions: Mentions;
  }>();
  const failed = useRef<Attempt>(undefined);
  // The screen stays mounted when another computer is picked, so the Composer keeps its draft.
  // What belongs to the old host goes: its failed start and account chooser. Its default backend
  // stays until the new host's is read, so the box's choices don't blink out.
  useEffect(() => {
    failed.current = undefined;
    if (workerBackends.has(hostId)) setRead({ hostId, backend: workerBackends.get(hostId) });
    setChoices(undefined);
  }, [hostId]);
  const group = groups.find((g) => g.id === groupId) ?? groups.at(-1)!;
  // The draft this screen edits (PLX-788): out of the sidebar's list while it's open, and back in
  // as it closes, unless the box is empty or a thread it starts opens. The pair nets out under
  // StrictMode's extra mount.
  const [draftId] = useState(() => reopened ?? uuidv7());
  const [draft] = useState(() => drafts.get().find((d) => d.id === draftId));
  const contents = useRef<ComposerContents>(undefined);
  // Set as a start that opens its thread begins, since the box may not render empty before it opens.
  const opening = useRef(false);
  const where = useRef({ hostId, groupId: group.id });
  useEffect(() => {
    where.current = { hostId, groupId: group.id };
  });
  useEffect(() => {
    drafts.remove(draftId);
    return () => {
      const box = contents.current;
      if (box && !isEmpty(box) && !opening.current)
        drafts.put({ ...box, ...where.current, id: draftId });
      if (opening.current) balances.delete(draftId);
    };
  }, [draftId]);
  // The repository's own defaults (Settings > Projects), over the global ones.
  const repoDefaults = useRepoPrefs(hostId, group.id);
  const globalDefaults = newThreadPrefs.use();
  // Starts as Settings says; picking one here is for this thread only.
  const [pickedWorkspace, setWorkspace] = useState<Workspace>();
  const workspace = pickedWorkspace ?? repoDefaults.workspace ?? globalDefaults.workspace;
  // Only a repository has a checkout, and only a plxd that takes `checkout` would use it: an
  // older one would make a worktree anyway.
  const checkoutUnavailable =
    connected && !("checkout" in connection.capabilities) ? t("needs a newer plxd") : undefined;
  const checkout = workspace === "checkout" && !checkoutUnavailable && !repoless(group);
  // Only a plxd with `repoRefs` lists refs or starts from one, and only a repository has them.
  const refsAvailable = !repoless(group) && connected && "repoRefs" in connection.capabilities;
  // The picked ref, kept with its repository and workspace, so picking another drops it: a new
  // worktree's base never becomes a checkout's switch.
  const [pickedRef, setPickedRef] = useState<{ groupId: string; checkout: boolean; ref: string }>();
  // A changed default (Settings floats over this screen) picks its base again.
  const baseDefaults = `${repoDefaults.base ?? ""}/${globalDefaults.worktreeBase}`;
  const [seenDefaults, setSeenDefaults] = useState(baseDefaults);
  if (seenDefaults !== baseDefaults) {
    setSeenDefaults(baseDefaults);
    setPickedRef(undefined);
  }
  const gitRef =
    refsAvailable && pickedRef?.groupId === group.id && pickedRef.checkout === checkout
      ? pickedRef.ref
      : undefined;

  // Focus the chosen account when the chooser opens, so a screen reader announces it.
  const chooser = useRef<HTMLFieldSetElement>(null);
  // The heading's repository name opens the same menu as the picker under the box.
  const repoMenu = useId();
  useEffect(() => {
    if (choices) chooser.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
  }, [choices]);

  // Starts `attempt`. Resolves to an error message, or "" when the account chooser opened.
  const attemptStart = async (
    attempt: Attempt,
    askForAccount = true,
  ): Promise<string | undefined> => {
    const error = await start(attempt);
    failed.current = error ? attempt : undefined;
    if (!error) {
      onStarted(attempt.runId, attempt.background);
      // New Thread stays open, and the next thread is a new one to place.
      if (attempt.background && balance.state === "picked") checkBalance();
      return undefined;
    }
    // No default, or one naming a removed key account: both need an account picked. Asks once
    // per Send, so a default that doesn't take can't loop.
    const kind = error.data?.kind;
    if ((kind !== "noDefaultAccount" && kind !== "accountNotFound") || !askForAccount)
      return describeError(error);
    const options = await accountOptions(hostId);
    if (typeof options === "string") return options;
    if (options.length === 0) return noAccounts();
    if (options.length === 1) return runOn(attempt, options[0]!);
    setPicked(0);
    setChoices(options);
    return "";
  };

  // Makes `option` the worker default, then retries `attempt` with its run id.
  const runOn = async (attempt: Attempt, option: AccountOption): Promise<string | undefined> => {
    const set = await window.parallax.request(hostId, "accounts/defaults/set", {
      role: "worker",
      account: option.account,
    });
    if ("error" in set) return describeError(set.error);
    return attemptStart(attempt, false);
  };

  const send = async (
    prompt: string,
    options: RunOptions,
    images: PromptImage[],
    threads: string[],
    background: boolean,
    mentions: Mentions = {},
  ): Promise<string | undefined> => {
    if (moving || asking) {
      // One held send at a time: a second, as after Cmd/Ctrl+Enter, goes back in the box.
      if (held)
        return t("Waiting for {{repo}} to be ready on {{computer}}", {
          repo: group.name,
          computer: hostName((moving ?? asking)!.hostId),
        });
      if (!background) setStarting({ prompt, images, threads, mentions });
      opening.current = !background;
      return new Promise((done) =>
        setHeld({ send: [prompt, options, images, threads, background, mentions], done }),
      );
    }
    // It found no computer, so nothing starts until the user picks one or it finds one.
    if (balanceOn && balance.state === "none") {
      setStarting(undefined);
      opening.current = false;
      return noRoom();
    }
    setChoices(undefined);
    const last = failed.current;
    // plxd refuses a run id reused with other options, so changing one starts afresh. It doesn't
    // compare images or threads, so this does: a failed send puts back the very same ones.
    const same =
      last &&
      last.groupId === group.id &&
      last.prompt === prompt &&
      last.images.length === images.length &&
      last.images.every((image, i) => image === images[i]) &&
      last.threads.join() === threads.join() &&
      JSON.stringify(last.mentions) === JSON.stringify(mentions) &&
      JSON.stringify(last.options) === JSON.stringify(options) &&
      last.checkout === checkout &&
      last.gitRef === gitRef
        ? last
        : undefined;
    // A background start leaves the box empty for the next thread.
    if (!background) setStarting({ prompt, images, threads, mentions });
    opening.current = !background;
    const error = await attemptStart({
      runId: same?.runId ?? uuidv7(),
      groupId: group.id,
      prompt,
      images,
      threads,
      mentions,
      options,
      checkout,
      gitRef,
      background,
    });
    // On success the app opens the thread instead.
    if (error !== undefined) {
      setStarting(undefined);
      opening.current = false;
    }
    return error;
  };

  const continueWith = async (option: AccountOption) => {
    dismiss("account");
    setChoosing(true);
    opening.current = true;
    // Continue is a click on New Thread, so the thread opens, even after a Cmd/Ctrl+Enter.
    const error = await runOn({ ...failed.current!, background: false }, option);
    setChoosing(false);
    if (error) {
      notify({
        key: "account",
        tone: "error",
        title: t("Couldn't start the thread"),
        body: error,
      });
      opening.current = false;
    }
  };

  // The computer picked while it adds or clones the repository (PLX-905), which the menu shows
  // picked at once while a notification follows git's progress (PLX-930). A send meanwhile is
  // held, so it starts there once the move is done, rather than on the computer being left, and
  // fails if the move does.
  const [moving, setMoving] = useState<{ hostId: string }>();
  // Whether the last move failed, which a held send then does too.
  const [moveFailed, setMoveFailed] = useState(false);
  // Where to clone the repository on the computer picked, when its path won't do there.
  const [asking, setAsking] = useState<{ hostId: string; ask: CloneAsk }>();
  // The entry the move added or cloned, which a held send waits to see in `groups`.
  const [arriving, setArriving] = useState<string>();
  const [held, setHeld] = useState<{
    send: Parameters<typeof send>;
    done: (error: string | undefined) => void;
  }>();
  const pickHost = async (id: string, at?: string) => {
    setMoveFailed(false);
    // Its accounts are this computer's, and its Continue would start the thread here.
    setChoices(undefined);
    setMoving({ hostId: id });
    const repo = group.name;
    const key = `setup/${id}`;
    let cloning = false;
    const result = await onHostChange(id, {
      at,
      onProgress: (line) => {
        const { phase, percent, detail } = parseProgress(line);
        // Shown once, then updated while it's open, so one the user closed stays closed.
        (cloning ? update : notify)({
          key,
          tone: "info",
          title: t("Cloning {{repo}} onto {{computer}}", { repo, computer: hostName(id) }),
          body: line ? [phase, detail].filter(Boolean).join(" · ") : t("Connecting…"),
          progress: { percent },
        });
        cloning = true;
      },
    });
    setMoving((m) => (m?.hostId === id ? undefined : m));
    if (typeof result === "string") {
      setMoveFailed(true);
      notify({
        key,
        tone: "error",
        title: t("Couldn't set up {{repo}} on {{computer}}", { repo, computer: hostName(id) }),
        body: result,
        action: { label: t("Try again"), run: () => void pickHost(id, at) },
      });
    } else if (result && "url" in result) {
      dismiss(key);
      setAsking({ hostId: id, ask: result });
    } else {
      // No entry when the computer had it, or another pick came first.
      if (result && cloning)
        notify({
          key,
          tone: "success",
          title: t("{{repo}} is ready on {{computer}}", { repo, computer: hostName(id) }),
        });
      else dismiss(key);
      setArriving(result?.id);
    }
  };
  const hostName = (id: string) => hosts.find((h) => h.id === id)?.name ?? t("that computer");
  // The computer the thread runs on as far as the user can tell: the one picked, while it's set up.
  const shownHostId = moving?.hostId ?? asking?.hostId ?? hostId;
  // A held send goes once the move is over, from this render's props: the new computer's.
  useEffect(() => {
    if (!held || moving || asking) return;
    if (arriving && !groups.some((g) => g.id === arriving)) return;
    setHeld(undefined);
    setArriving(undefined);
    if (moveFailed) {
      // A notification says why.
      setStarting(undefined);
      opening.current = false;
      held.done("");
    } else void send(...held.send).then(held.done);
  });

  // The Load Balancer (0101): a new draft starts on it, and its pick holds for the draft until a
  // manual pick, or choosing it again.
  const balanceSettings = loadBalancer.use();
  const balanceOn = balanceSettings.on && hosts.length > 1 && !group.project;
  const [balance, setBalance] = useState<Balance>(
    () => balances.get(draftId) ?? { state: balanced ? "new" : "manual" },
  );
  useEffect(() => {
    if (balance.state !== "checking") balances.set(draftId, balance);
  }, [draftId, balance]);
  const reading = runOptions && read?.hostId !== hostId;
  // Until the draft is on its pick and knows that computer's backend. The box sends nothing
  // meanwhile, since a send uploads its files and fixes its model for the computer it's on.
  const checking =
    balanceOn &&
    (balance.state === "checking" || (balance.state === "picked" && (!!moving || reading)));
  const checkBalance = () => setBalance({ state: "checking", id: ++checks });
  const connections = useRealConnections(hosts.map((h) => h.id));
  // Whether every computer it could pick has said what it can: connected or not, and its repositories.
  const settled = hosts.every((h, i) => {
    const state = connections[i];
    if (balanceSettings.leftOut.includes(h.id)) return true;
    if (!state || state.status === "connecting") return false;
    return (
      state.status !== "connected" ||
      repoless(group) ||
      !!listing?.has(h.id) ||
      !!missing?.has(h.id)
    );
  });
  // A computer that takes its time doesn't hold the check up for long.
  const [waited, setWaited] = useState(false);
  const checkId = balanceOn && balance.state === "checking" ? balance.id : undefined;
  useEffect(() => {
    if (checkId === undefined) return;
    const timer = setTimeout(() => setWaited(true), answerMs);
    return () => {
      clearTimeout(timer);
      setWaited(false);
    };
  }, [checkId]);
  const ready = settled || waited;
  useEffect(() => {
    if (balance.state === "new" && balanceOn && listed) checkBalance();
  }, [balance.state, balanceOn, listed]);
  // What a check decides on once its computers have answered, as it is by then.
  const current = useRef({
    hosts,
    connections,
    balanceSettings,
    listing,
    group,
    shownHostId,
    pickHost,
  });
  useEffect(() => {
    current.current = {
      hosts,
      connections,
      balanceSettings,
      listing,
      group,
      shownHostId,
      pickHost,
    };
  });
  // Asks each computer that could take the thread once, then decides among those that answered, as
  // things are then. Leaving the draft, a manual pick, or a newer check ends it unheard.
  useEffect(() => {
    if (checkId === undefined || !ready) return;
    let live = true;
    const able = hosts.filter(
      (h, i) =>
        connections[i]?.status === "connected" &&
        !balanceSettings.leftOut.includes(h.id) &&
        (repoless(group) || listing?.has(h.id)),
    );
    void (async () => {
      const answers = new Map(
        await Promise.all(able.map(async (h) => [h.id, await askComputer(h.id, true)] as const)),
      );
      if (!live) return;
      const now = current.current;
      const leftOut = now.balanceSettings.leftOut;
      // What the box holds now, since it may have changed while they answered.
      const box = contents.current;
      const { pinned, named } = tiesOf(box);
      if (pinned) return setBalance({ state: "pinned", pinned });
      const candidates = now.hosts.map((h, i): Candidate => ({
        id: h.id,
        preference: now.balanceSettings.preferences[h.id] ?? "normal",
        barred: leftOut.includes(h.id)
          ? "left-out"
          : now.connections[i]?.status !== "connected"
            ? "offline"
            : !repoless(now.group) && !now.listing?.has(h.id)
              ? "no-repository"
              : named.some((relayId) => h.id === `account:${relayId}`)
                ? "named"
                : undefined,
        ...answers.get(h.id),
        provider: box?.provider,
      }));
      const why = Object.fromEntries(
        candidates.flatMap((c) => {
          const verdict = assess(c);
          return "why" in verdict ? [[c.id, t(whyText[verdict.why])]] : [];
        }),
      );
      const pick = pickComputer(candidates);
      if (!pick) {
        return setBalance({
          state: "none",
          why,
          leftOut: now.hosts.every((h) => leftOut.includes(h.id)),
        });
      }
      setBalance({ state: "picked", why });
      if (pick !== now.shownHostId) await now.pickHost(pick);
    })();
    return () => {
      live = false;
    };
  }, [checkId, ready]);
  // Another repository may be on other computers, so picking one checks again, unless the user
  // picked the computer. A Project picks its computer itself (`tray`).
  const pickGroup = (groupId: string) => {
    onGroupChange(groupId);
    if (groups.find((g) => g.id === groupId)?.project) setBalance({ state: "manual" });
    else if (["checking", "picked", "none"].includes(balance.state)) checkBalance();
  };
  const pickManually = (id: string) => {
    setBalance({ state: "manual" });
    return pickHost(id);
  };
  // Picking a branch or worktree keeps the draft where it is, so a check under way ends here.
  const stayPut = () => {
    if (balance.state === "new" || balance.state === "checking") setBalance({ state: "manual" });
  };
  const balancerMenu = balanceOn
    ? {
        on: ["checking", "picked", "none"].includes(balance.state),
        checking,
        none: balance.state === "none",
        why: balance.state === "picked" || balance.state === "none" ? balance.why : undefined,
        problem:
          balance.state === "none"
            ? balance.leftOut
              ? t("Every computer is left out.")
              : t("No computer can take this thread. Pick one.")
            : balance.state === "pinned"
              ? balance.pinned === "threads"
                ? t("Stays here, with threads from this computer attached.")
                : t("Stays here, with files from this computer named.")
              : undefined,
        onChoose: () => {
          setPickedRef(undefined);
          checkBalance();
        },
        onSettings: balance.state === "none" ? onOpenLoadBalancer : undefined,
      }
    : undefined;

  const pickRepository = async () => {
    const path = await window.parallax.pickFolder();
    if (!path) return;
    const repo = await addRepo(path);
    if (typeof repo === "string")
      notify({ tone: "error", title: t("Couldn't add the repository"), body: repo });
    else pickGroup(repo.id);
  };

  const hold = starting !== undefined || reading;

  // While starting, laid out as AgentChat is, so opening the thread doesn't move anything. The
  // Composer keeps its place in the tree either way, so a failed start still puts the text back.
  // Before it starts, it's centered a little above the middle, so as the Composer grows to its
  // seven lines the heading rises by only half as much, never toward the top. With a page under
  // it, it sits at a fixed height instead, and the page scrolls; with a column beside what's under
  // it, it's a page.
  const page = starting === undefined && !!aside;
  // The heading's text before and after its repository button, split where the language puts it.
  const shownHostName = hosts.find((h) => h.id === shownHostId)?.name;
  const heading = (
    group.id === noRepo
      ? t("What should we do on {{computer}}?", { computer: buttonMark })
      : group.project
        ? t("What should we work on in {{project}}?", { project: buttonMark })
        : shared
          ? t("What should we build in {{repo}} on {{computer}}?", {
              repo: buttonMark,
              computer: shownHostName,
            })
          : t("What should we build in {{repo}}?", { repo: buttonMark })
  ).split(buttonMark);
  return (
    <div
      className={
        starting !== undefined
          ? "flex min-h-0 flex-1 flex-col"
          : page
            ? "flex min-h-0 flex-1 flex-col overflow-y-auto"
            : below
              ? "flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-[14vh] pb-16"
              : "flex flex-1 flex-col items-center justify-center-safe px-6 pb-[16vh]"
      }
    >
      {starting !== undefined && (
        <ThreadLinksContext value={threadLinks}>
          <TranscriptView
            rows={[
              {
                kind: "pending",
                key: "pending:prompt",
                text: starting.prompt,
                images: starting.images,
                threads: starting.threads,
                ...starting.mentions,
              },
            ]}
            sent={new Map()}
            live={false}
            // Nothing works on it until the clone is done: a notification says what's going.
            stalled={!!moving}
          />
        </ThreadLinksContext>
      )}
      <div
        className={
          page
            ? "mx-auto w-full max-w-5xl px-10 pt-12 pb-16"
            : starting === undefined
              ? "w-full max-w-3xl"
              : "mx-auto w-full max-w-3xl px-6 pb-5"
        }
      >
        {starting === undefined && header}
        {starting === undefined && !header && (
          <>
            <h1 className="mb-2 flex justify-center-safe text-display font-medium tracking-tight whitespace-pre">
              {heading[0]}
              <button
                type="button"
                popoverTarget={repoMenu}
                aria-haspopup="menu"
                title={group.id === noRepo ? undefined : group.name}
                className="min-w-0 truncate rounded-md underline decoration-muted-foreground decoration-dotted decoration-2 underline-offset-[6px] hover:decoration-foreground hover:decoration-solid"
              >
                {group.id === noRepo ? shownHostName : group.name}
              </button>
              {heading[1]}
            </h1>
            {/* Without a repo, an empty line in its place, so the box doesn't move. */}
            {repoless(group) ? (
              <div aria-hidden className="invisible mb-9 text-reading">
                &nbsp;
              </div>
            ) : (
              <div className="relative mb-9 text-center">
                {/* Its shortcut, Mod+Shift+N unless rebound, shows under it on hover or focus. */}
                <button
                  type="button"
                  onClick={() => {
                    setChoices(undefined);
                    pickGroup(noRepo);
                  }}
                  aria-keyshortcuts={noRepoBinding && ariaKeyshortcut(noRepoBinding)}
                  className="group relative rounded-md text-reading text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:text-foreground"
                >
                  {t("or work without a repo")}
                  {noRepoKeys && (
                    <kbd
                      aria-hidden
                      className="pointer-events-none invisible absolute top-full left-1/2 z-20 mt-1 -translate-x-1/2 rounded-md border border-border bg-surface px-2 py-1 font-sans text-meta text-muted-foreground group-hover:visible group-focus-visible:visible"
                    >
                      {noRepoKeys}
                    </kbd>
                  )}
                </button>
              </div>
            )}
            {/* Menu only: the repository name in the heading opens it. */}
            <Picker
              id={repoMenu}
              button={false}
              label={t("Repository")}
              value={group.id}
              onChange={(value) => {
                if (value === addRepository) return void pickRepository();
                setChoices(undefined);
                const other = elsewhere.find((o) => elsewhereValue(o) === value);
                if (other) {
                  // Another computer's repository, picked on purpose.
                  setBalance({ state: "manual" });
                  onPickElsewhere(other.host.id, other.repo.id);
                } else pickGroup(value);
              }}
              options={[
                ...groups.map((g) => ({
                  value: g.id,
                  label: g.name,
                  icon:
                    g.id === noRepo ? (
                      <SquareDashed />
                    ) : g.project ? (
                      <MessagesSquare />
                    ) : (
                      <Folder />
                    ),
                })),
                ...elsewhere.map((o, i) => ({
                  value: elsewhereValue(o),
                  label: o.repo.name,
                  icon: <Folder />,
                  hint: o.host.name,
                  divider: i === 0,
                })),
                ...(local
                  ? [
                      {
                        value: addRepository,
                        label: t("Add repository…"),
                        icon: <Plus />,
                        divider: true,
                      },
                    ]
                  : []),
              ]}
            />
          </>
        )}
        <Composer
          newThread
          repoDefaults={repoDefaults}
          initial={draft}
          contents={contents}
          // The box looks the same while a start is under way, or while another computer's backend
          // stands in for this one's, so a send meanwhile stays in it.
          onSend={(prompt, options, images, threads, mentions) =>
            hold ? Promise.resolve("") : send(prompt, options, images, threads, false, mentions)
          }
          onSendInBackground={(prompt, options, images, threads, mentions) =>
            hold ? Promise.resolve("") : send(prompt, options, images, threads, true, mentions)
          }
          attach={attachThreads(connection, threadLinks)}
          backend={runOptions ? backend : undefined}
          hostId={hostId}
          connected={connected}
          contextAndFast={connected && "contextAndFast" in connection.capabilities}
          disabledReason={disabledReason}
          sendWaits={checking ? t("The Load Balancer is checking your computers") : undefined}
          imageCaps={imageCaps(connection)}
          uploadBytes={uploadBytes(connection)}
          menus={
            connected && "composerMenus" in connection.capabilities
              ? { hostId, repo: group.id === noRepo || group.project ? undefined : group.id }
              : undefined
          }
          placeholder={
            group.project ? t("Ask anything, paste an image, use /skills or @threads") : undefined
          }
          // A new thread asks only through a plxd that sends its requests (PLX-196).
          manualDenied={connected && !("approvals" in connection.capabilities) ? "host" : undefined}
          // Where it runs, in the bar under the box. Chat picks only its computer here, and a Project only
          // among the computers that have it (`tray`), since its entry is on each computer alone.
          // While a start is under way it stays as it was, but inert, so the thread can't move.
          tab={
            group.project ? (
              tray
            ) : (
              <div inert={starting !== undefined} className="contents">
                {repoless(group) ? (
                  <RunTargetMenu
                    hosts={hosts}
                    hostId={shownHostId}
                    busy={!!moving || checking}
                    onHostChange={pickManually}
                    balancer={balancerMenu}
                  />
                ) : (
                  <>
                    <RunTargetMenu
                      hosts={hosts}
                      hostId={shownHostId}
                      busy={!!moving || checking}
                      onHostChange={pickManually}
                      balancer={balancerMenu}
                      workspace={checkout ? "checkout" : "worktree"}
                      onWorkspaceChange={(next) => {
                        stayPut();
                        setWorkspace(next);
                      }}
                      checkoutUnavailable={checkoutUnavailable}
                      missing={missing && { repo: group.name, hostIds: missing }}
                    />
                    {refsAvailable && (
                      <RefMenu
                        hostId={hostId}
                        repo={group.id}
                        checkout={checkout}
                        value={gitRef}
                        preferred={repoDefaults.base}
                        fromCurrent={globalDefaults.worktreeBase === "current"}
                        onChange={(ref, chosen) => {
                          if (chosen) stayPut();
                          setPickedRef({ groupId: group.id, checkout, ref });
                        }}
                      />
                    )}
                  </>
                )}
              </div>
            )
          }
          footer={
            <div>
              {asking && (
                <CloneDialog
                  hostId={asking.hostId}
                  hostName={hostName(asking.hostId)}
                  ask={asking.ask}
                  onDone={(repo) => {
                    setAsking(undefined);
                    if (repo) void pickHost(asking.hostId, repo.path);
                    // Closed first: a held send goes back to the box.
                    else if (held) {
                      setHeld(undefined);
                      setStarting(undefined);
                      opening.current = false;
                      held.done("");
                    }
                  }}
                />
              )}
              {choices && (
                <fieldset
                  ref={chooser}
                  className="mt-3 w-full rounded-xl border border-border px-4 py-3"
                >
                  <legend className="float-left mb-2.5 w-full">
                    <span className="block text-body font-medium">
                      {t("Choose an account to run this thread")}
                    </span>
                    <span className="block text-body text-muted-foreground">
                      {t("New threads on this host use it from now on.")}
                    </span>
                  </legend>
                  <div className="clear-left flex flex-wrap gap-1">
                    {choices.map((choice, i) => (
                      <label
                        key={i}
                        className="flex items-center rounded-md border border-border px-2.5 py-1 text-body text-muted-foreground hover:text-foreground has-checked:bg-selected has-checked:text-foreground has-focus-visible:outline-2 has-focus-visible:outline-ring"
                      >
                        <input
                          type="radio"
                          name="account"
                          checked={picked === i}
                          onChange={() => setPicked(i)}
                          className="sr-only"
                        />
                        {choice.label}
                      </label>
                    ))}
                  </div>
                  <button
                    type="button"
                    disabled={choosing}
                    onClick={() => void continueWith(choices[picked]!)}
                    className="mt-3 rounded-md bg-primary px-3 py-1.5 text-body font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50"
                  >
                    {t("Continue")}
                  </button>
                </fieldset>
              )}
            </div>
          }
        />
        {page ? (
          <div className="mt-10 grid items-start gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
            <div className="min-w-0">{below}</div>
            <aside>{aside}</aside>
          </div>
        ) : (
          starting === undefined && below
        )}
      </div>
    </div>
  );
}
