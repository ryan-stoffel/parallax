// What sits over a thread's composer, as on the desktop (AgentChat.tsx): the requests waiting on the
// user, pinned so they can't scroll away (the oldest permission request, then a secret the agent
// asks for), and the tabs tucked behind the box (ComposerTabs.tsx): whose child the thread is, its
// subagents at work, what a settled turn still waits on, the goal, the plan, and the queue. The
// first tab shows in full and the rest compact, on one row; a tap opens a tab's details above it.
import * as Haptics from "expo-haptics";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bot,
  Check,
  Circle,
  CornerUpRight,
  KeyRound,
  Pencil,
  Target,
  X,
} from "lucide-react-native";
import { useRef, useState, type ReactNode } from "react";
import { Alert, LayoutAnimation, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";

import type {
  AgentBackgroundTask,
  AgentTodoItem,
  OrchestrationCommand,
  QueuedMessage,
} from "../../desktop/src/protocol/generated/protocol";
import { latestPlan } from "../../desktop/src/renderer/plans";
import { inputText, toolKind } from "../../desktop/src/renderer/steps";
import {
  backgroundCalls,
  nativeTitle,
  pursuedGoal,
  subagentLabels,
  subagentState,
  waitingApprovals,
  waitingSecrets,
  type Approval,
  type Item,
  type Subagent,
  type SubagentState,
} from "../../desktop/src/renderer/transcript";
import { presentWaiting } from "../../desktop/src/renderer/waiting";
import { DiffView } from "./Diff";
import { editRows } from "./diffLogic";
import { font } from "./theme";
import { Button, Dot, Icon, KindIcon, T, useColors, WorkingMark } from "./ui";

/** A request that failed, in an alert, as the desktop's notification says it. */
const failed = (title: string, message: string) => Alert.alert(title, message);

/** The oldest permission request waiting, with how many wait, and Deny and Allow. */
function ApprovalCard({
  hostId,
  runId,
  item,
  count,
  onAnswered,
}: {
  hostId: string;
  runId: string;
  item: Approval;
  count: number;
  onAnswered: () => void;
}) {
  const c = useColors();
  const [answering, setAnswering] = useState(false);
  const { request } = item;
  const diff = editRows(request.toolName, request.input);
  const detail = inputText(request.input ?? "").slice(0, 600);
  async function answer(decision: "allow" | "deny") {
    setAnswering(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const reply = await window.parallax.request(hostId, "agent/approve", {
      runId,
      approvalId: request.approvalId,
      decision,
    });
    setAnswering(false);
    if ("error" in reply) failed("Your answer didn't reach the agent", reply.error.message);
    else onAnswered();
  }
  return (
    <View style={[styles.card, { borderColor: c.warning, backgroundColor: c.surface }]}>
      <View style={styles.line}>
        <KindIcon kind={toolKind(request.toolName)} color={c.warning} />
        <T medium style={{ flex: 1 }}>
          Allow {request.toolName}?
        </T>
        {count > 1 && (
          <T faint style={{ fontSize: 12 }}>
            1 of {count}
          </T>
        )}
      </View>
      {/* Its own box scrolls, so a long edit never pushes the buttons off screen. */}
      {diff ? (
        <ScrollView style={{ maxHeight: 200 }}>
          <DiffView rows={diff} />
        </ScrollView>
      ) : (
        !!detail &&
        detail !== "{}" && (
          <View style={[styles.block, { backgroundColor: c.code, borderColor: c.border }]}>
            <T style={{ fontFamily: font.mono, fontSize: 12, lineHeight: 17 }} numberOfLines={8}>
              {detail}
            </T>
          </View>
        )
      )}
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Button label="Deny" style={{ flex: 1 }} disabled={answering} onPress={() => void answer("deny")} />
        <Button label="Allow" primary style={{ flex: 1 }} disabled={answering} onPress={() => void answer("allow")} />
      </View>
    </View>
  );
}

/** The thread's permission requests, oldest first: one card at a time, gone once answered here. */
function PinnedApprovals({ hostId, runId, items }: { hostId: string; runId: string; items: readonly Item[] }) {
  // Answered here, so the card goes before plxd's `approvalResolved` arrives.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const waiting = waitingApprovals(items).filter((a) => !answered.has(a.request.approvalId));
  const head = waiting[0];
  if (!head) return null;
  const id = head.request.approvalId;
  return (
    <ApprovalCard
      key={id}
      hostId={hostId}
      runId={runId}
      item={head}
      count={waiting.length}
      onAnswered={() => setAnswered((prev) => new Set(prev).add(id))}
    />
  );
}

type SecretItem = Extract<Item, { kind: "secret" }>;

/**
 * The oldest secret the agent waits on (`request_secret`, 0063), as the desktop's SecretCard: a
 * password field whose value goes only to plxd's `secret/answer`, and Decline or Save.
 */
function SecretCard({ hostId, runId, secret }: { hostId: string; runId: string; secret: SecretItem }) {
  const c = useColors();
  const { request } = secret;
  // Held only until it's sent: never in state, the transcript, or the log.
  const value = useRef("");
  const [busy, setBusy] = useState<"save" | "decline">();
  async function send(answer: { type: "save"; secret: string } | { type: "decline" }) {
    setBusy(answer.type);
    const reply = await window.parallax.request(hostId, "secret/answer", {
      runId,
      requestId: request.requestId,
      answer,
    });
    // On success the card goes once plxd logs the answer.
    if ("error" in reply) {
      failed(answer.type === "save" ? "Couldn't save the secret" : "Couldn't decline the secret", reply.error.message);
      setBusy(undefined);
    }
  }
  return (
    <View style={[styles.card, { borderColor: c.border, backgroundColor: c.surface }]}>
      <View style={styles.line}>
        <Icon icon={KeyRound} size={15} color={c.faintForeground} />
        <T medium numberOfLines={1} style={{ flex: 1 }}>
          {request.label}
        </T>
        <T faint style={{ fontSize: 12 }}>
          The agent asks for a secret
        </T>
      </View>
      {!!request.reason && (
        <T muted style={{ fontSize: 13.5, lineHeight: 19 }}>
          {request.reason}
        </T>
      )}
      <TextInput
        accessibilityLabel={request.label}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        placeholder={request.placeholder ?? "Paste the secret"}
        placeholderTextColor={c.faintForeground}
        onChangeText={(text) => (value.current = text)}
        style={[styles.input, { borderColor: c.border, backgroundColor: c.code, color: c.foreground }]}
      />
      <T faint style={{ fontSize: 12, lineHeight: 16 }}>
        Kept in this computer's keychain. The agent gets a one-time reference, never the value.
      </T>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Button
          label={busy === "decline" ? "Declining…" : "Decline"}
          style={{ flex: 1 }}
          disabled={!!busy}
          onPress={() => void send({ type: "decline" })}
        />
        <Button
          label={busy === "save" ? "Saving…" : "Save"}
          primary
          style={{ flex: 1 }}
          disabled={!!busy}
          onPress={() => value.current.trim() && void send({ type: "save", secret: value.current })}
        />
      </View>
    </View>
  );
}

/** One tab over the composer: its full row, its compact form beside others, and what a tap does. */
interface Tab {
  key: string;
  label: string;
  full: ReactNode;
  compact: ReactNode;
  /** What a tap opens above the row. */
  panel?: ReactNode;
  /** What a tap does instead, such as opening the parent thread. */
  onPress?: () => void;
}

/**
 * The tabs tucked behind the composer, as the desktop's ComposerTabs: one row, never more, the
 * first in full and the rest compact after it. A tap opens one tab's details above the row.
 */
function Tabs({ tabs }: { tabs: readonly Tab[] }) {
  const c = useColors();
  const [open, setOpen] = useState<string>();
  if (tabs.length === 0) return null;
  const shown = tabs.find((t) => t.key === open && t.panel);
  const press = (tab: Tab) => {
    void Haptics.selectionAsync();
    if (tab.onPress) return tab.onPress();
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpen(shown?.key === tab.key ? undefined : tab.key);
  };
  return (
    <View style={[styles.tabs, { borderColor: c.border, backgroundColor: c.surface }]}>
      {shown && (
        <ScrollView style={[styles.panel, { borderBottomColor: c.border }]} contentContainerStyle={{ padding: 14, gap: 8 }}>
          {shown.panel}
        </ScrollView>
      )}
      <View style={styles.tabRow}>
        {tabs.map((tab, i) => (
          <Pressable
            key={tab.key}
            accessibilityRole="button"
            accessibilityLabel={tab.label}
            accessibilityState={tab.panel ? { expanded: shown?.key === tab.key } : undefined}
            onPress={() => press(tab)}
            style={({ pressed }) => [
              styles.tab,
              i === 0 ? { flex: 1, minWidth: 0 } : { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: c.border },
              (pressed || shown?.key === tab.key) && { backgroundColor: c.hover },
            ]}
          >
            {i === 0 ? tab.full : tab.compact}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** A count in a quiet chip, as the desktop's tabs show one. */
function Count({ n }: { n: number }) {
  const c = useColors();
  return (
    <View style={[styles.count, { backgroundColor: c.hover }]}>
      <T style={{ fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] }}>{n}</T>
    </View>
  );
}

/** A thin bar of how much of the plan is done. */
function Progress({ done, total }: { done: number; total: number }) {
  const c = useColors();
  return (
    <View style={[styles.bar, { backgroundColor: c.border }]}>
      <View style={{ width: `${total ? (done / total) * 100 : 0}%`, height: "100%", backgroundColor: c.added }} />
    </View>
  );
}

/** A plan step's mark: done, under way, or to do. */
function StepMark({ status }: { status: AgentTodoItem["status"] }) {
  const c = useColors();
  if (status === "completed") return <Icon icon={Check} size={14} color={c.faintForeground} />;
  if (status === "inProgress") return <WorkingMark size={14} />;
  return <Icon icon={Circle} size={13} color={c.faintForeground} />;
}

/** A subagent's dot, by where it stands. */
function StateDot({ state }: { state: SubagentState }) {
  const c = useColors();
  const colors = { running: c.accent, completed: c.added, failed: c.danger, stopped: c.faintForeground };
  return <Dot color={colors[state]} size={7} />;
}

const text = { fontSize: 13, lineHeight: 18 };

/** A small icon button in the queue's list. */
function Action({ icon, label, disabled, onPress }: { icon: typeof X; label: string; disabled?: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [styles.action, (pressed || disabled) && { opacity: 0.4 }]}
    >
      <Icon icon={icon} size={15} color={c.mutedForeground} />
    </Pressable>
  );
}

/**
 * The queued messages, editable until plxd delivers them, through `orchestration/dispatch`'s
 * queued-run commands (0059): move, edit, steer now while the run goes, or cancel. A held queue
 * waits for Resume (0060).
 */
function QueueList({
  hostId,
  runId,
  messages,
  held,
  running,
  connected,
}: {
  hostId: string;
  runId: string;
  messages: QueuedMessage[];
  held: boolean;
  running: boolean;
  connected: boolean;
}) {
  const c = useColors();
  const [busy, setBusy] = useState(false);
  const off = busy || !connected;
  async function change(command: OrchestrationCommand) {
    setBusy(true);
    const answer = await window.parallax.request(hostId, "orchestration/dispatch", command);
    setBusy(false);
    if ("error" in answer) failed("Couldn't change the queue", answer.error.message);
  }
  function move(id: string, to: number) {
    const ids = messages.map((m) => m.id);
    ids.splice(ids.indexOf(id), 1);
    ids.splice(to, 0, id);
    void change({ type: "queued-run.reorder", threadId: runId, runIds: ids });
  }
  const edit = (m: QueuedMessage) =>
    Alert.prompt(
      "Edit queued message",
      undefined,
      (next) => void change({ type: "queued-run.edit", threadId: runId, runId: m.id, text: next }),
      "plain-text",
      m.text,
    );
  return (
    <>
      <View style={styles.line}>
        <T faint style={{ ...text, flex: 1 }}>
          {held ? "Paused" : "Next turn"}
        </T>
        {held && (
          <Pressable
            accessibilityRole="button"
            disabled={off}
            onPress={() => void change({ type: "queue.resume", threadId: runId })}
          >
            <T medium style={{ ...text, color: c.accent }}>
              Resume
            </T>
          </Pressable>
        )}
      </View>
      {messages.map((m, i) => (
        <View key={m.id} style={styles.line}>
          <T numberOfLines={2} style={{ ...text, flex: 1 }}>
            {m.text || "Image message"}
          </T>
          <Action icon={ArrowUp} label={`Move queued message ${i + 1} up`} disabled={off || i === 0} onPress={() => move(m.id, i - 1)} />
          <Action
            icon={ArrowDown}
            label={`Move queued message ${i + 1} down`}
            disabled={off || i === messages.length - 1}
            onPress={() => move(m.id, i + 1)}
          />
          <Action icon={Pencil} label={`Edit queued message ${i + 1}`} disabled={off} onPress={() => edit(m)} />
          <Action
            icon={CornerUpRight}
            label={`Steer queued message ${i + 1} now`}
            disabled={off || !running}
            onPress={() => void change({ type: "queued-message.promote-to-steer", threadId: runId, runId: m.id })}
          />
          <Action
            icon={X}
            label={`Cancel queued message ${i + 1}`}
            disabled={off}
            onPress={() => void change({ type: "queued-run.cancel", threadId: runId, runId: m.id })}
          />
        </View>
      ))}
    </>
  );
}

/** What a settled turn waits on, in full, and Stop, which ends it all. */
function WaitingList({
  hostId,
  runId,
  background,
  watching,
  items,
}: {
  hostId: string;
  runId: string;
  background: AgentBackgroundTask[];
  watching: string[];
  items: { kind: string; label: string }[];
}) {
  const [stopping, setStopping] = useState(false);
  async function stop() {
    setStopping(true);
    const answers = await Promise.all([
      ...background.map((task) => window.parallax.request(hostId, "agent/stopTask", { runId, taskId: task.taskId })),
      ...watching.map((url) => window.parallax.request(hostId, "pr/unwatch", { runId, url })),
    ]);
    // What ends leaves with plxd's events, and what didn't can be stopped again.
    setStopping(false);
    const wrong = answers.find((a) => "error" in a);
    if (wrong && "error" in wrong) failed("Couldn't stop waiting", wrong.error.message);
  }
  return (
    <>
      <T muted style={text}>
        The agent picks up when one of these ends or changes.
      </T>
      {items.map((item, i) => (
        <View key={i} style={[styles.line, { alignItems: "flex-start" }]}>
          <T faint style={{ ...text, width: 96, textTransform: "capitalize" }}>
            {item.kind}
          </T>
          <T style={{ ...text, flex: 1 }}>{item.label}</T>
        </View>
      ))}
      <Button label={stopping ? "Stopping…" : "Stop"} disabled={stopping} onPress={() => void stop()} />
    </>
  );
}

// How many finished subagents the list shows under those still going, as the desktop's.
const finishedShown = 5;

export function ThreadStrips({
  hostId,
  runId,
  items,
  subagents,
  background,
  watching,
  queue,
  held,
  running,
  stalled,
  connected,
  parent,
}: {
  hostId: string;
  runId: string;
  items: readonly Item[];
  subagents?: Readonly<Record<string, Subagent>>;
  background: AgentBackgroundTask[];
  watching: string[];
  queue: QueuedMessage[];
  held: boolean;
  /** Whether the run is going. */
  running: boolean;
  /** Whether the transcript stopped updating or the computer is away, so nothing shows in progress. */
  stalled: boolean;
  connected: boolean;
  /** The thread this one is a child of, and how to open it. */
  parent?: { name: string; open: () => void };
}) {
  const c = useColors();
  const live = running && !stalled;
  const secret = waitingSecrets(items)[0];
  const tabs: Tab[] = [];

  if (parent)
    tabs.push({
      key: "parent",
      label: `A child thread of ${parent.name}. Open parent`,
      onPress: parent.open,
      full: (
        <>
          <Icon icon={ArrowLeft} size={14} color={c.mutedForeground} />
          <T muted numberOfLines={1} style={{ ...text, flex: 1 }}>
            A child thread of <T style={text}>{parent.name}</T>
          </T>
        </>
      ),
      compact: (
        <>
          <Icon icon={ArrowLeft} size={14} color={c.mutedForeground} />
          <T muted style={text}>
            Parent
          </T>
        </>
      ),
    });

  // The thread's own subagents, nested ones left out: those still going first, newest first.
  const calls = backgroundCalls(stalled ? [] : background);
  const agents = Object.values(subagents ?? {})
    .filter((s) => s.at !== undefined && !s.parent)
    .map((s) => ({ id: s.callId, title: nativeTitle(s), state: subagentState(s, live, calls) }))
    .reverse();
  const going = agents.filter((a) => a.state === "running");
  if (going.length > 0) {
    const working = (
      <T muted style={{ ...text, fontVariant: ["tabular-nums"] }}>
        {going.length} working
      </T>
    );
    const row = (a: (typeof agents)[number]) => (
      <View key={a.id} style={styles.line}>
        <StateDot state={a.state} />
        <T numberOfLines={1} style={{ ...text, flex: 1 }}>
          {a.title}
        </T>
        <T faint style={{ fontSize: 12 }}>
          {subagentLabels[a.state]}
        </T>
      </View>
    );
    const finished = agents.filter((a) => a.state !== "running").slice(0, finishedShown);
    tabs.push({
      key: "subagents",
      label: `Subagents: ${going.length} working`,
      full: (
        <>
          <Icon icon={Bot} size={14} color={c.mutedForeground} />
          <T numberOfLines={1} style={{ ...text, flex: 1 }}>
            {going[0]!.title}
          </T>
          {working}
        </>
      ),
      compact: (
        <>
          <Icon icon={Bot} size={14} color={c.mutedForeground} />
          {working}
        </>
      ),
      panel: (
        <>
          <T faint style={{ fontSize: 12 }}>
            Working {going.length}
          </T>
          {going.map(row)}
          {finished.length > 0 && (
            <T faint style={{ fontSize: 12, marginTop: 4 }}>
              Done {finished.length}
            </T>
          )}
          {finished.map(row)}
        </>
      ),
    });
  }

  // Once its turn settles, as on the desktop: a turn's own work shows in the transcript.
  const waiting = running ? undefined : presentWaiting(background, watching, going.length > 0);
  if (waiting) {
    // As the title counts them: the subagents the tab beside it lists only when they're all there is.
    const others = waiting.items.filter((item) => going.length === 0 || item.kind !== "subagent");
    const counted = others.length > 0 ? others : waiting.items;
    const kinds = new Set(counted.map((item) => item.kind));
    const verb =
      kinds.size === 1 && kinds.has("command") ? "Running" : kinds.size === 1 && kinds.has("pull request") ? "Monitoring" : "Waiting";
    tabs.push({
      key: "waiting",
      label: waiting.title,
      full: (
        <>
          <Dot color={c.foreground} size={6} />
          <T medium numberOfLines={1} style={{ ...text, flexShrink: 1 }}>
            {waiting.title}
          </T>
          <T muted numberOfLines={1} style={{ ...text, flex: 1 }}>
            {waiting.labels}
          </T>
        </>
      ),
      compact: (
        <>
          <Dot color={c.foreground} size={6} />
          <T muted style={text}>
            {verb}
          </T>
          <Count n={counted.length} />
        </>
      ),
      panel: <WaitingList hostId={hostId} runId={runId} background={background} watching={watching} items={waiting.items} />,
    });
  }

  const goal = live ? pursuedGoal(items) : undefined;
  if (goal)
    tabs.push({
      key: "goal",
      label: `Pursuing goal: ${goal}`,
      full: (
        <>
          <Icon icon={Target} size={14} color={c.mutedForeground} />
          <T medium style={text}>
            Pursuing goal
          </T>
          <T muted numberOfLines={1} style={{ ...text, flex: 1 }}>
            {goal}
          </T>
        </>
      ),
      compact: (
        <>
          <Icon icon={Target} size={14} color={c.mutedForeground} />
          <T muted style={text}>
            Goal
          </T>
        </>
      ),
      panel: (
        <T selectable style={{ fontSize: 14, lineHeight: 20 }}>
          {goal}
        </T>
      ),
    });

  // The latest turn's plan, while the run works on it.
  const plan = live ? latestPlan(items) : undefined;
  if (plan) {
    const done = plan.items.filter((s) => s.status === "completed").length;
    const now = plan.items.find((s) => s.status === "inProgress");
    const next = now ?? plan.items.find((s) => s.status !== "completed");
    const tally = (
      <>
        <T muted style={{ fontSize: 12, fontVariant: ["tabular-nums"] }}>
          {done} of {plan.items.length}
        </T>
        <Progress done={done} total={plan.items.length} />
      </>
    );
    tabs.push({
      key: "plan",
      label: `Plan: ${done} of ${plan.items.length} done`,
      full: (
        <>
          <StepMark status={now ? "inProgress" : next ? "pending" : "completed"} />
          <T numberOfLines={1} style={{ ...text, flex: 1 }}>
            {next ? (now ? (plan.active ?? now.text) : next.text) : "All steps done"}
          </T>
          {tally}
        </>
      ),
      compact: tally,
      panel: plan.items.map((step, i) => (
        <View key={i} style={[styles.line, { alignItems: "flex-start" }]}>
          <View style={{ width: 16, alignItems: "center", paddingTop: 2 }}>
            <StepMark status={step.status} />
          </View>
          <T
            style={{
              ...text,
              flex: 1,
              color: step.status === "completed" ? c.faintForeground : step.status === "inProgress" ? c.foreground : c.mutedForeground,
            }}
          >
            {step.text}
          </T>
        </View>
      )),
    });
  }

  if (queue.length > 0) {
    const queued = (
      <>
        <T muted style={text}>
          Queued
        </T>
        <Count n={queue.length} />
        {held && (
          <T faint style={text}>
            Paused
          </T>
        )}
      </>
    );
    tabs.push({
      key: "queue",
      label: `${queue.length} queued${held ? ", paused" : ""}`,
      full: queued,
      compact: queued,
      panel: <QueueList hostId={hostId} runId={runId} messages={queue} held={held} running={running} connected={connected} />,
    });
  }

  return (
    <View>
      <View style={{ paddingHorizontal: 10, gap: 8 }}>
        <PinnedApprovals hostId={hostId} runId={runId} items={items} />
        {secret && <SecretCard key={secret.key} hostId={hostId} runId={runId} secret={secret} />}
      </View>
      <Tabs tabs={tabs} />
    </View>
  );
}

// How far the tabs tuck behind the composer: its top padding and a little of its box.
const tuck = 20;

const styles = StyleSheet.create({
  line: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 24 },
  card: { borderWidth: 1, borderRadius: 18, padding: 14, gap: 10 },
  block: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 8 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  tabs: {
    marginTop: 8,
    marginHorizontal: 26,
    marginBottom: -tuck,
    paddingBottom: tuck,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    overflow: "hidden",
  },
  panel: { maxHeight: 260, borderBottomWidth: StyleSheet.hairlineWidth },
  tabRow: { flexDirection: "row", alignItems: "stretch" },
  tab: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36, paddingHorizontal: 12 },
  count: { borderRadius: 5, paddingHorizontal: 6 },
  bar: { width: 36, height: 3, borderRadius: 2, overflow: "hidden" },
  action: { width: 26, height: 26, alignItems: "center", justifyContent: "center" },
});
