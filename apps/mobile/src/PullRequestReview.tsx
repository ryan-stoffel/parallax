// Reviewing a pull request on the phone, through its computer's plxd (`pr/write`, `pr/guide`), as
// the desktop's PR view does: one sheet to write in, for a review, a comment, a line comment, a
// reply, or the title and description; a review thread with Reply and Resolve; and the Guide tab,
// the agent-written walkthrough of the head commit.
import type { LucideIcon } from "lucide-react-native";
import { CircleCheck, FileText, MessageSquareReply, RotateCw } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from "react-native";

import type { PrGuideResult, PrReviewThread, PrWrite, ThreadNaming } from "../../desktop/src/protocol/generated/protocol";
import { githubText } from "../../desktop/src/renderer/github";
import { ago } from "./nav";
import { useOffers } from "./offers";
import type { Computer } from "./fleet";
import { Avatar, useCard } from "./PullRequestParts";
import { Sheet, sheetTitle } from "./Sheet";
import { font } from "./theme";
import { Button, Icon, Markdown, T, useColors } from "./ui";

/** One of a writing sheet's buttons: the write it sends for the sheet's text, and its title's. */
export interface WriteAction {
  label: string;
  primary?: boolean;
  destructive?: boolean;
  /** Sends even with no text, as a review with line comments or a discard does. */
  empty?: boolean;
  write: (body: string, title: string) => PrWrite;
}

/** What a writing sheet asks for: its title, a line about it, and its buttons. */
export interface Writing {
  title: string;
  note?: string;
  placeholder: string;
  /** The text it starts with, as an edit's description. */
  body?: string;
  /** A one-line field above the text, as an edit's title. */
  titleField?: string;
  actions: WriteAction[];
}

/**
 * The sheet to write in: a text box, and a one-line one above it for an edit's title, over its
 * buttons. A button sends its write through `send`, which resolves to whether it worked; the sheet
 * closes when it did and keeps the text when it didn't.
 */
export function WriteSheet({
  writing,
  send,
  onClose,
}: {
  writing?: Writing;
  send: (w: PrWrite) => Promise<boolean>;
  onClose: () => void;
}) {
  const c = useColors();
  const [body, setBody] = useState("");
  const [title, setTitle] = useState("");
  const [sending, setSending] = useState<string>();
  // Each new writing starts from its own text.
  useEffect(() => {
    if (!writing) return;
    setBody(writing.body ?? "");
    setTitle(writing.titleField ?? "");
  }, [writing]);
  // The writing on screen as the sheet slides away, so it doesn't empty while it goes.
  const last = useRef(writing);
  if (writing) last.current = writing;
  const shown = last.current;
  const text = body.trim();
  return (
    <Sheet
      open={!!writing}
      onClose={onClose}
      head={
        <View style={styles.head}>
          <T style={sheetTitle}>{shown?.title ?? ""}</T>
        </View>
      }
    >
      <View style={{ paddingHorizontal: 16, gap: 10 }}>
        {!!shown?.note && (
          <T muted style={{ fontSize: 13, lineHeight: 17 }}>
            {shown.note}
          </T>
        )}
        {shown?.titleField !== undefined && (
          <TextInput
            accessibilityLabel="Title"
            value={title}
            onChangeText={setTitle}
            placeholder="Title"
            placeholderTextColor={c.faintForeground}
            selectionColor={c.accent}
            style={[styles.field, { color: c.foreground, backgroundColor: c.code, borderColor: c.border }]}
          />
        )}
        <TextInput
          accessibilityLabel={shown?.placeholder}
          value={body}
          onChangeText={setBody}
          placeholder={shown?.placeholder}
          placeholderTextColor={c.faintForeground}
          selectionColor={c.accent}
          multiline
          autoFocus={shown?.titleField === undefined}
          textAlignVertical="top"
          style={[styles.field, styles.box, { color: c.foreground, backgroundColor: c.code, borderColor: c.border }]}
        />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {shown?.actions.map((a) => (
            <Button
              key={a.label}
              label={sending === a.label ? "Sending…" : a.label}
              primary={a.primary}
              destructive={a.destructive}
              disabled={!!sending || (!a.empty && !text) || (shown.titleField !== undefined && !title.trim())}
              style={{ flexGrow: 1 }}
              onPress={async () => {
                setSending(a.label);
                const ok = await send(a.write(text, title.trim()));
                setSending(undefined);
                if (ok) onClose();
              }}
            />
          ))}
        </View>
      </View>
    </Sheet>
  );
}

/** The review sheet: Comment, Approve, or Request changes, sending the pending review when there is one. */
export function reviewWriting(pendingReviewId: string | undefined, pending: number): Writing {
  const verdict = (label: string, event: "comment" | "approve" | "requestChanges", primary?: boolean): WriteAction => ({
    label,
    primary,
    // A review with line comments, or an approval, needs no text.
    empty: event === "approve" || (!!pendingReviewId && pending > 0),
    write: (body) => (pendingReviewId ? { kind: "submitReview", reviewId: pendingReviewId, event, body } : { kind: "review", event, body }),
  });
  return {
    title: "Review",
    note: pending ? `Sends with your ${pending} pending ${pending === 1 ? "comment" : "comments"}.` : undefined,
    placeholder: "Leave a comment",
    actions: [
      verdict("Comment", "comment"),
      verdict("Request changes", "requestChanges"),
      verdict("Approve", "approve", true),
      ...(pendingReviewId
        ? [{ label: "Discard pending", destructive: true, empty: true, write: (): PrWrite => ({ kind: "discardReview", reviewId: pendingReviewId }) }]
        : []),
    ],
  };
}

/** How many of the viewer's comments wait in their pending review. */
export const pendingCount = (threads: PrReviewThread[] = []) =>
  threads.reduce((n, t) => n + t.comments.filter((c) => c.pending).length, 0);

/**
 * A review thread: where it is (left out under its line in the diff), Outdated, Resolved, or
 * Pending, each comment, and Reply and Resolve while it's open and not only pending comments.
 */
export function ThreadCard({
  thread,
  bare,
  onReply,
  onResolve,
}: {
  thread: PrReviewThread;
  bare?: boolean;
  onReply?: () => void;
  onResolve?: () => void;
}) {
  const c = useColors();
  const card = useCard();
  const lines = thread.startLine ? `${thread.startLine}–${thread.line}` : thread.line;
  const pending = thread.comments.every((m) => m.pending);
  const marks = [thread.isOutdated && "Outdated", thread.isResolved && "Resolved", pending && "Pending"].filter(Boolean);
  const open = !thread.isResolved && !pending;
  return (
    <View style={[styles.thread, { backgroundColor: card, borderColor: c.border }]}>
      {(!bare || marks.length > 0) && (
        <View style={[styles.line, { gap: 6 }]}>
          {!bare && thread.path && (
            <T muted numberOfLines={1} style={{ flex: 1, fontFamily: font.mono, fontSize: 12, lineHeight: 16 }}>
              {thread.path}
              {lines ? `:${lines}` : ""}
            </T>
          )}
          {marks.map((m) => (
            <T key={m as string} faint style={{ ...styles.mark, borderColor: c.border }}>
              {m as string}
            </T>
          ))}
        </View>
      )}
      {thread.comments.map((m) => (
        <View key={m.id} style={{ gap: 6 }}>
          <View style={[styles.line, { gap: 8 }]}>
            <Avatar login={m.author} size={20} />
            <T medium numberOfLines={1} style={{ flex: 1, fontSize: 13, lineHeight: 17 }}>
              {m.author}
            </T>
            <T faint style={{ fontSize: 12, lineHeight: 16 }}>
              {m.pending ? "Pending" : ago(m.createdAt)}
            </T>
          </View>
          <Markdown text={githubText(m.body)} images="github" />
        </View>
      ))}
      {open && (onReply || onResolve) && (
        <View style={[styles.line, { gap: 8 }]}>
          {onReply && <Small icon={MessageSquareReply} label="Reply" onPress={onReply} />}
          {onResolve && <Small icon={CircleCheck} label="Resolve" onPress={onResolve} />}
        </View>
      )}
    </View>
  );
}

/** A small text button with an icon, as a thread's Reply. */
function Small({ icon, label, onPress }: { icon: LucideIcon; label: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.small, { borderColor: c.border }, pressed && { opacity: 0.6 }]}
    >
      <Icon icon={icon} size={14} color={c.mutedForeground} />
      <T medium muted style={{ fontSize: 13, lineHeight: 17 }}>
        {label}
      </T>
    </Pressable>
  );
}

/**
 * The model that writes a guide: the computer's first Claude or Codex instance and its first model,
 * as the desktop uses the user's default model when it can write one.
 */
function useGuideModel(computer: Computer | undefined): ThreadNaming | undefined {
  const offers = useOffers(computer);
  const offer = offers.find((o) => (o.kind === "claude" || o.kind === "codex") && o.models.length > 0);
  return offer && { backend: offer.id, model: offer.models[0]!.id };
}

/** How often a guide being written is read again. */
const GUIDE_POLL_MS = 4_000;

/**
 * The Guide tab: plxd's walkthrough of the pull request at `headSha`, which it starts writing when
 * it has none, read again while it's written. Its overview, then each step's explanation and the
 * lines it covers, each opening the Changes tab there. Its diagrams stay on the desktop.
 */
export function Guide({
  computer,
  url,
  headSha,
  onOpen,
}: {
  computer: Computer | undefined;
  url: string;
  headSha: string;
  onOpen: (path: string, line: number) => void;
}) {
  const c = useColors();
  const card = useCard();
  const model = useGuideModel(computer);
  const hostId = computer?.machine.id;
  const [state, setState] = useState<PrGuideResult | string>();
  const [round, setRound] = useState<{ regenerate: boolean; n: number }>({ regenerate: false, n: 0 });
  const generating = typeof state === "object" && state.generating;
  useEffect(() => {
    if (!hostId || !model) return;
    let live = true;
    void window.parallax
      .request(hostId, "pr/guide", { url, headSha, model, regenerate: round.regenerate || undefined })
      .then((a) => live && setState("error" in a ? a.error.message : a.result));
    return () => void (live = false);
  }, [hostId, url, headSha, model?.backend, model?.model, round]);
  useEffect(() => {
    if (!generating) return;
    const timer = setTimeout(() => setRound((r) => ({ regenerate: false, n: r.n + 1 })), GUIDE_POLL_MS);
    return () => clearTimeout(timer);
  }, [generating, state]);
  const again = () => setRound((r) => ({ regenerate: true, n: r.n + 1 }));

  if (!model) return <T muted style={styles.note}>Writing a guide needs Claude or Codex on this computer.</T>;
  if (typeof state === "string") return <T alert style={{ ...styles.note, color: c.danger }}>{state}</T>;
  const guide = state?.guide;
  if (!guide)
    return (
      <View style={{ alignItems: "center", gap: 12, paddingVertical: 30 }}>
        {state?.error ? (
          <>
            <T muted style={{ fontSize: 14, textAlign: "center" }}>
              The guide couldn't be written. {state.error}
            </T>
            <Button label="Try again" icon={RotateCw} onPress={again} />
          </>
        ) : (
          <>
            <ActivityIndicator color={c.accent} />
            <T muted style={{ fontSize: 14 }}>
              Writing a guide to this pull request…
            </T>
          </>
        )}
      </View>
    );
  const stale = guide.headSha !== headSha;
  return (
    <View style={{ gap: 20 }}>
      {(stale || generating) && (
        <T muted style={{ fontSize: 13, lineHeight: 17 }}>
          {generating ? "Writing a guide for the latest commit. This one is for an older commit." : "This guide is for an older commit."}
        </T>
      )}
      <Markdown text={guide.overview} />
      {guide.steps.map((step, i) => (
        <View key={i} style={{ gap: 10 }}>
          <View style={[styles.line, { gap: 10 }]}>
            <View style={[styles.step, { backgroundColor: card, borderColor: c.border }]}>
              <T medium style={{ fontSize: 13, lineHeight: 17 }}>
                {i + 1}
              </T>
            </View>
            <T style={{ flex: 1, fontSize: 16, lineHeight: 22, fontWeight: "600" }}>{step.title}</T>
          </View>
          <Markdown text={step.explanation} />
          {step.hunks.map((h, j) => (
            <Pressable
              key={j}
              accessibilityRole="button"
              accessibilityLabel={`Open ${h.path} at line ${h.start}`}
              onPress={() => onOpen(h.path, h.start)}
              style={({ pressed }) => [styles.hunk, { backgroundColor: card, borderColor: c.border }, pressed && { opacity: 0.6 }]}
            >
              <Icon icon={FileText} size={15} color={c.faintForeground} />
              <T numberOfLines={1} style={{ flex: 1, fontFamily: font.mono, fontSize: 12, lineHeight: 16 }}>
                {h.path}:{h.start}
                {h.end > h.start ? `–${h.end}` : ""}
              </T>
            </Pressable>
          ))}
        </View>
      ))}
      {!!guide.omitted?.length && (
        <T faint style={{ fontSize: 13, lineHeight: 17 }}>
          Not read to fit the diff: {guide.omitted.join(", ")}
        </T>
      )}
      {!generating && (
        <View style={{ alignItems: "flex-start" }}>
          <Button label="Write it again" icon={RotateCw} onPress={again} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { height: 24, marginBottom: 10 },
  line: { flexDirection: "row", alignItems: "center" },
  field: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 11, fontSize: 15 },
  box: { minHeight: 120, maxHeight: 260 },
  thread: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 10 },
  mark: { fontSize: 11, lineHeight: 15, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 5, overflow: "hidden" },
  small: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  note: { fontSize: 14, paddingVertical: 24 },
  step: { width: 26, height: 26, borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  hunk: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 8 },
});
