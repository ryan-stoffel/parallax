// One thread, as the desktop's transcript shows it: the user's messages in bubbles, the agent's
// text, its tools in a line each, permission requests to answer, and a composer that queues a
// message or, while the agent works, steers it now. Messages go through the outbox, and wait in
// plxd's queue while the agent works, as the desktop's QueueStrip shows them.
import { useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

import {
  failureText,
  field,
  isRunning,
  statusLabel,
  type Approval,
  type Item,
} from "../../desktop/src/renderer/transcript";
import { useAgentRun } from "../../desktop/src/renderer/useAgentRun";
import { uuidv7 } from "../../desktop/src/renderer/uuidv7";
import { HOST } from "./host";
import type { Outbox } from "./outbox";
import { font } from "./theme";
import { Button, Markdown, SwipeBack, T, useColors } from "./ui";

/** What a tool call or permission request is about, in a few words: its command, file, or url. */
const about = (input: Parameters<typeof field>[0]) =>
  field(input, "description") ??
  field(input, "command") ??
  field(input, "file_path") ??
  field(input, "url") ??
  "";

function ApprovalCard({ item, runId }: { item: Approval; runId: string }) {
  const c = useColors();
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState<string>();
  const { request, resolved } = item;
  async function answer(decision: "allow" | "deny") {
    setAnswering(true);
    const reply = await window.parallax.request(HOST, "agent/approve", {
      runId,
      approvalId: request.approvalId,
      decision,
    });
    setAnswering(false);
    if ("error" in reply) setError(reply.error.message);
  }
  if (resolved)
    return (
      <T muted style={styles.small}>
        {resolved.decision === "allowed"
          ? "Allowed"
          : resolved.decision === "denied"
            ? "Denied"
            : "Ended:"}{" "}
        {request.toolName}
      </T>
    );
  return (
    <View style={[styles.card, { borderColor: c.border, backgroundColor: c.surface }]}>
      <T medium>Allow {request.toolName}?</T>
      {!!about(request.input) && (
        <T muted style={{ fontFamily: font.mono, fontSize: 13 }}>
          {about(request.input)}
        </T>
      )}
      <View style={styles.buttons}>
        <Button label="Deny" disabled={answering} onPress={() => void answer("deny")} />
        <Button label="Allow" primary disabled={answering} onPress={() => void answer("allow")} />
      </View>
      {error && (
        <T alert style={{ color: c.danger, fontSize: 13 }}>
          {error}
        </T>
      )}
    </View>
  );
}

function Row({ item, runId }: { item: Item; runId: string }) {
  const c = useColors();
  switch (item.kind) {
    case "user":
      return (
        <View style={[styles.bubble, { backgroundColor: c.selected }]}>
          <T>{item.text ?? "A message"}</T>
        </View>
      );
    case "assistant":
      return <Markdown text={item.text} />;
    case "tool":
      return (
        <T
          numberOfLines={1}
          muted
          style={{ ...styles.small, ...(item.status === "error" && { color: c.danger }) }}
        >
          {item.name ?? "Tool"}{" "}
          <T style={{ ...styles.small, fontFamily: font.mono, color: c.faintForeground }}>
            {about(item.input)}
          </T>
        </T>
      );
    case "approval":
      return <ApprovalCard item={item} runId={runId} />;
    case "notice":
      return (
        <T muted style={styles.small}>
          {item.text}
        </T>
      );
    case "end":
      return (
        <View style={styles.end}>
          <View style={[styles.rule, { backgroundColor: c.border }]} />
          <T muted style={styles.small}>
            {item.outcome.status === "failed"
              ? `Failed: ${failureText(item.outcome.failure)}`
              : statusLabel(item.outcome.status)}
          </T>
          <View style={[styles.rule, { backgroundColor: c.border }]} />
        </View>
      );
    default:
      return null;
  }
}

export function ThreadScreen({
  runId,
  title,
  connected,
  status,
  outbox,
  drafts,
  onBack,
}: {
  runId: string;
  title: string;
  connected: boolean;
  /** Why the host isn't connected, for people, or undefined while it is. */
  status?: string;
  outbox: Outbox;
  /** Unsent text, by thread. */
  drafts: Map<string, string>;
  onBack: () => void;
}) {
  const c = useColors();
  const { transcript, error, queue } = useAgentRun(HOST, runId, connected);
  const [text, setText] = useState(drafts.get(runId) ?? "");
  // The draft outlives this screen, so going back and returning keeps it.
  const edit = (next: string) => {
    setText(next);
    drafts.set(runId, next);
  };
  const waiting = useSyncExternalStore(
    (listener) => outbox.subscribe(listener),
    () => outbox.messages,
  );
  const working = isRunning(transcript.run?.status) && !transcript.turnDone;
  const logged = new Set(transcript.items.map((i) => (i.kind === "user" ? i.turnId : undefined)));
  const pending = waiting.filter((m) => m.threadId === runId && !logged.has(m.id));

  function send(steer: boolean) {
    if (!text.trim()) return;
    outbox.add({ id: uuidv7(), threadId: runId, text: text.trim(), steer });
    edit("");
  }

  return (
    <SwipeBack onBack={onBack}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: c.background }}>
        <View style={[styles.header, { borderColor: c.border }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={onBack}
            hitSlop={12}
          >
            <T style={{ fontSize: 30, lineHeight: 32, color: c.accent }}>‹</T>
          </Pressable>
          <T medium numberOfLines={1} style={{ flex: 1 }}>
            {title}
          </T>
        </View>
        {status && (
          <T muted style={{ ...styles.small, paddingHorizontal: 20, paddingTop: 6 }}>
            {status}
          </T>
        )}
        <FlatList
          inverted
          data={[...transcript.items].reverse()}
          keyExtractor={(i) => i.key}
          contentContainerStyle={styles.transcript}
          accessibilityLabel="Transcript"
          ListHeaderComponent={
            <View style={{ gap: 14, marginTop: 14 }}>
              {queue.map((m) => (
                <View key={m.id} style={{ alignItems: "flex-end", gap: 4 }}>
                  <View style={[styles.bubble, { backgroundColor: c.selected, opacity: 0.6 }]}>
                    <T>{m.text}</T>
                  </View>
                  <T muted style={{ fontSize: 12 }}>
                    Queued
                  </T>
                </View>
              ))}
              {pending.map((m) => (
                <View key={m.id} style={{ alignItems: "flex-end", gap: 4 }}>
                  <View style={[styles.bubble, { backgroundColor: c.selected, opacity: 0.6 }]}>
                    <T>{m.text}</T>
                  </View>
                  <T muted style={{ fontSize: 12 }}>
                    {connected ? "Sending…" : "Waiting for connection"}
                    {m.steer ? " · steer" : ""}
                  </T>
                </View>
              ))}
              {working && (
                <View style={styles.working}>
                  <ActivityIndicator size="small" color={c.accent} />
                  <T muted style={styles.small}>
                    Working
                  </T>
                </View>
              )}
              {error && (
                <T alert style={{ ...styles.small, color: c.danger }}>
                  {error}
                </T>
              )}
            </View>
          }
          renderItem={({ item }) => (
            <View style={{ marginTop: 14 }}>
              <Row item={item} runId={runId} />
            </View>
          )}
        />
        <View style={[styles.composer, { borderColor: c.border, backgroundColor: c.surface }]}>
          <TextInput
            accessibilityLabel="Message"
            multiline
            value={text}
            onChangeText={edit}
            placeholder="Reply, add detail, or steer what it does next"
            placeholderTextColor={c.faintForeground}
            style={[styles.input, { color: c.foreground }]}
          />
          <View style={styles.actions}>
            {working && (
              <Pressable
                accessibilityRole="button"
                onPress={() => send(true)}
                style={[styles.steer, { borderColor: c.border }]}
              >
                <T style={{ fontSize: 14 }}>Steer now</T>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={working ? "Queue" : "Send"}
              onPress={() => send(false)}
              style={[styles.send, { backgroundColor: c.accent, opacity: text.trim() ? 1 : 0.4 }]}
            >
              <T style={{ color: "#ffffff", fontSize: 18, lineHeight: 20 }}>↑</T>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SwipeBack>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 60,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  transcript: { paddingHorizontal: 20, paddingVertical: 16 },
  bubble: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  small: { fontSize: 13, lineHeight: 19 },
  card: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 8 },
  buttons: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
  end: { flexDirection: "row", alignItems: "center", gap: 10 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  working: { flexDirection: "row", alignItems: "center", gap: 8 },
  composer: {
    marginHorizontal: 12,
    marginBottom: 28,
    borderWidth: 1,
    borderRadius: 24,
    padding: 12,
    gap: 8,
  },
  input: {
    fontFamily: font.regular,
    fontSize: 16,
    minHeight: 44,
    maxHeight: 140,
    paddingHorizontal: 6,
  },
  actions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 8 },
  steer: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 7 },
  send: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
});
