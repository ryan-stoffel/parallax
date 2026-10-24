// Pull requests: every one linked to a thread on any computer (as the desktop's Pull requests
// page lists them), and one pull request's overview, checks, reviews, conversation, and diff,
// read through its thread's computer with `pr/view` and `pr/diff`, and merged or closed with
// `pr/act`. plxd asks GitHub with the computer's own `gh`, so the phone needs no GitHub sign-in.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import type { LucideIcon } from "lucide-react-native";
import {
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  ExternalLink,
  FileDiff,
  FileText,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
  Minus,
  Plus,
} from "lucide-react-native";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  View,
} from "react-native";

import type {
  PrAction,
  PrDiffResult,
  PullRequest,
} from "../../desktop/src/protocol/generated/protocol";
import { useComputer, useFleet, type Computer } from "./fleet";
import { ago, useNav, type Screens } from "./nav";
import { font } from "./theme";
import { githubText } from "../../desktop/src/renderer/github";
import { Button, Icon, Markdown, T, useColors, WorkingMark } from "./ui";

/** A pull request linked to a thread, on a computer. */
interface PrEntry {
  hostId: string;
  runId: string;
  threadTitle: string;
  url: string;
}

/** Each linked pull request once, newest thread first. */
function entriesOf(computers: Computer[]): PrEntry[] {
  const seen = new Set<string>();
  return computers
    .flatMap(({ machine, view: { state } }) =>
      [...state.threads]
        .sort((a, b) => (b.lastPromptAt ?? b.createdAt).localeCompare(a.lastPromptAt ?? a.createdAt))
        .flatMap((t) =>
          (state.runs[t.id]?.pullRequests ?? []).map((url) => ({
            hostId: machine.id,
            runId: t.id,
            threadTitle: state.titles[t.id] ?? "Thread",
            url,
          })),
        ),
    )
    .filter((e) => !seen.has(e.url) && seen.add(e.url));
}

/** Read pull requests, by URL, kept while the app runs so the list and detail share them. */
const reads = new Map<string, PullRequest>();

async function view(e: Pick<PrEntry, "hostId" | "runId" | "url">): Promise<PullRequest | string> {
  const answer = await window.parallax.request(e.hostId, "pr/view", { runId: e.runId, url: e.url });
  if ("error" in answer) return answer.error.message;
  const pr = answer.result as PullRequest;
  reads.set(e.url, pr);
  return pr;
}

/** A pull request's state as the desktop's PR panel draws it (`lookOf`): its icon, color, and word. */
function lookOf(pr: PullRequest | undefined, c: ReturnType<typeof useColors>): [LucideIcon, string, string] {
  if (pr?.state === "merged") return [GitMerge, c.projectViolet, "Merged"];
  if (pr?.state === "closed") return [GitPullRequestClosed, c.danger, "Closed"];
  if (pr?.state === "open" && pr.draft) return [GitPullRequestDraft, c.faintForeground, "Draft"];
  if (pr?.state === "open") return [GitPullRequest, c.added, "Open"];
  return [GitPullRequest, c.mutedForeground, "Pull request"];
}

/** A check's mark, as the desktop's `checkIcons`: a running one turns. */
function ChecksMark({ state }: { state?: PullRequest["checksState"] }) {
  const c = useColors();
  if (state === "passed") return <Icon icon={CircleCheck} size={14} color={c.added} />;
  if (state === "failed") return <Icon icon={CircleX} size={14} color={c.danger} />;
  if (state === "pending") return <WorkingMark size={13} />;
  return null;
}

const numberOf = (url: string) => url.split("/").pop() ?? "";

function PrRow({ entry, pr, error }: { entry: PrEntry; pr?: PullRequest; error?: string }) {
  const c = useColors();
  const nav = useNav();
  const [symbol, color] = lookOf(pr, c);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => nav.navigate("PullRequest", entry)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.selected }]}
    >
      <View style={{ paddingTop: 2 }}>
        <Icon icon={symbol} size={17} color={color} />
      </View>
      <View style={[styles.rowBody, { borderBottomColor: c.border }]}>
        <View style={styles.line}>
          <T medium numberOfLines={2} style={{ flex: 1 }}>
            {pr?.title ?? entry.threadTitle}
          </T>
          <ChecksMark state={pr?.checksState} />
        </View>
        <T muted numberOfLines={1} style={styles.small}>
          {pr ? `${pr.repo} #${pr.number} · ${ago(pr.updatedAt)}` : (error ?? `#${numberOf(entry.url)}`)}
        </T>
        <View style={styles.line}>
          <Icon icon={MessageSquare} size={11} color={c.faintForeground} />
          <T faint numberOfLines={1} style={{ ...styles.small, flex: 1 }}>
            {entry.threadTitle}
          </T>
          {pr && (
            <T style={styles.small}>
              <T style={{ ...styles.small, color: c.added }}>+{pr.additions}</T>{" "}
              <T style={{ ...styles.small, color: c.danger }}>−{pr.deletions}</T>
            </T>
          )}
        </View>
      </View>
    </Pressable>
  );
}

export function PullRequestList() {
  const c = useColors();
  const { computers } = useFleet();
  const entries = entriesOf(computers);
  const [, setVersion] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);
  const connected = new Set(computers.filter((m) => m.connected).map((m) => m.machine.id));
  const key = entries.map((e) => `${e.url}@${connected.has(e.hostId)}`).join();

  const load = useCallback(
    async (all: boolean) => {
      await Promise.all(
        entries
          .filter((e) => connected.has(e.hostId) && (all || !reads.has(e.url)))
          .map(async (e) => {
            const pr = await view(e);
            if (typeof pr === "string") setErrors((x) => ({ ...x, [e.url]: pr }));
            setVersion((v) => v + 1);
          }),
      );
    },
    [key],
  );
  useEffect(() => void load(false), [load]);

  const done = (e: PrEntry) => {
    const pr = reads.get(e.url);
    return pr && pr.state !== "open";
  };
  const sections = [
    { title: "Open", data: entries.filter((e) => !done(e)) },
    { title: "Merged and closed", data: entries.filter(done) },
  ].filter((s) => s.data.length);

  return (
    <SectionList
      style={{ backgroundColor: c.background }}
      contentInsetAdjustmentBehavior="automatic"
      sections={sections}
      keyExtractor={(e) => e.url}
      stickySectionHeadersEnabled={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load(true).finally(() => setRefreshing(false));
          }}
        />
      }
      renderSectionHeader={({ section }) => (
        <T muted medium style={styles.section}>
          {section.title}
        </T>
      )}
      renderItem={({ item }) => (
        <PrRow entry={item} pr={reads.get(item.url)} error={errors[item.url]} />
      )}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Icon icon={GitPullRequest} size={32} color={c.faintForeground} />
          <T muted style={{ textAlign: "center" }}>
            Pull requests your threads open show up here.
          </T>
        </View>
      }
      contentContainerStyle={{ paddingBottom: 40 }}
    />
  );
}

/** One line of a unified diff, colored as GitHub colors it. */
function DiffLine({ line }: { line: string }) {
  const c = useColors();
  const file = line.startsWith("diff --git");
  const add = line.startsWith("+") && !line.startsWith("+++");
  const del = line.startsWith("-") && !line.startsWith("---");
  const hunk = line.startsWith("@@");
  if (file)
    return (
      <View style={[styles.diffFile, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Icon icon={FileText} size={13} color={c.mutedForeground} />
        <T medium numberOfLines={1} style={{ ...styles.small, flex: 1 }}>
          {line.replace(/^diff --git a\/(.*) b\/.*$/, "$1")}
        </T>
      </View>
    );
  if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) return null;
  return (
    <T
      style={{
        fontFamily: font.mono,
        fontSize: 11.5,
        lineHeight: 17,
        paddingHorizontal: 10,
        color: hunk ? c.accent : c.foreground,
        backgroundColor: add
          ? "rgba(22, 163, 74, 0.14)"
          : del
            ? "rgba(212, 51, 15, 0.13)"
            : hunk
              ? c.selected
              : undefined,
      }}
    >
      {line || " "}
    </T>
  );
}

function Diff({ hostId, runId, url }: { hostId: string; runId: string; url: string }) {
  const c = useColors();
  const [diff, setDiff] = useState<PrDiffResult | string>();
  useEffect(() => {
    void window.parallax
      .request(hostId, "pr/diff", { runId, url })
      .then((a) => setDiff("error" in a ? a.error.message : (a.result as PrDiffResult)));
  }, [hostId, runId, url]);
  if (!diff) return <ActivityIndicator style={{ marginTop: 40 }} color={c.accent} />;
  if (typeof diff === "string")
    return (
      <T alert style={{ color: c.danger, padding: 20 }}>
        {diff}
      </T>
    );
  const lines = diff.diff.split("\n");
  return (
    <FlatList
      data={lines}
      keyExtractor={(_, i) => String(i)}
      renderItem={({ item }) => <DiffLine line={item} />}
      initialNumToRender={60}
      contentContainerStyle={{ paddingBottom: 40 }}
      ListFooterComponent={
        diff.truncated ? (
          <T faint style={{ padding: 16, ...styles.small }}>
            The diff is cut short here. See the rest on GitHub.
          </T>
        ) : null
      }
    />
  );
}

function Heading({ children }: { children: string }) {
  return (
    <T muted medium style={{ fontSize: 13, marginTop: 10 }}>
      {children}
    </T>
  );
}

const mergeText: Record<string, string> = {
  clean: "Ready to merge",
  unstable: "Some checks aren't passing",
  hasHooks: "Ready to merge",
  behind: "The branch is behind its base",
  blocked: "Merging is blocked",
  dirty: "This branch has conflicts",
  draft: "This pull request is still a draft",
};

export function PullRequestScreen({
  route,
  navigation,
}: NativeStackScreenProps<Screens, "PullRequest">) {
  const { hostId, runId, url } = route.params;
  const c = useColors();
  const computer = useComputer(hostId);
  const [pr, setPr] = useState<PullRequest | undefined>(reads.get(url));
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<"overview" | "changes">("overview");
  const [acting, setActing] = useState(false);
  const [allChecks, setAllChecks] = useState(false);
  const connected = !!computer?.connected;

  const load = useCallback(async () => {
    const read = await view({ hostId, runId, url });
    if (typeof read === "string") setError(read);
    else {
      setError(undefined);
      setPr(read);
    }
  }, [hostId, runId, url]);
  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: pr ? `#${pr.number}` : "Pull request",
      headerRight: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open on GitHub"
          hitSlop={10}
          onPress={() => void Linking.openURL(url)}
        >
          <Icon icon={ExternalLink} size={20} color={c.foreground} />
        </Pressable>
      ),
    });
  }, [navigation, pr?.number, url, c.accent]);

  function act(action: PrAction, label: string, destructive = false) {
    Alert.alert(`${label}?`, pr ? `${pr.repo} #${pr.number}` : undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: label,
        style: destructive ? "destructive" : "default",
        onPress: async () => {
          setActing(true);
          const answer = await window.parallax.request(hostId, "pr/act", { runId, url, action });
          setActing(false);
          if ("error" in answer) return Alert.alert(`Couldn't ${label.toLowerCase()}`, answer.error.message);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          const next = answer.result as PullRequest;
          reads.set(url, next);
          setPr(next);
        },
      },
    ]);
  }

  const [symbol, color, stateLabel] = lookOf(pr, c);
  const segment = (id: typeof tab, label: string) => (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: tab === id }}
      onPress={() => setTab(id)}
      style={[styles.segment, tab === id && { backgroundColor: c.surface }]}
    >
      <T medium style={{ fontSize: 13, color: tab === id ? c.foreground : c.mutedForeground }}>
        {label}
      </T>
    </Pressable>
  );

  const header = (
    <View style={{ gap: 10, padding: 18, paddingBottom: 8 }}>
      <View style={[styles.pill, { backgroundColor: color }]}>
        <Icon icon={symbol} size={13} color="#ffffff" />
        <T medium style={{ fontSize: 12, lineHeight: 16, color: "#ffffff" }}>
          {stateLabel}
        </T>
      </View>
      <T medium selectable style={{ fontSize: 21, lineHeight: 28 }}>
        {pr?.title ?? `Pull request #${numberOf(url)}`}
      </T>
      {pr && (
        <T muted style={styles.small}>
          {pr.author} wants to merge into{" "}
          <T style={{ ...styles.small, fontFamily: font.mono }}>{pr.baseBranch}</T> from{" "}
          <T style={{ ...styles.small, fontFamily: font.mono }}>{pr.headBranch}</T>
        </T>
      )}
      <View style={[styles.segments, { backgroundColor: c.selected }]}>
        {segment("overview", "Overview")}
        {segment("changes", pr ? `Changes · ${pr.changedFiles}` : "Changes")}
      </View>
    </View>
  );

  if (tab === "changes")
    return (
      <View style={{ flex: 1, backgroundColor: c.background }}>
        {header}
        <Diff hostId={hostId} runId={runId} url={url} />
      </View>
    );

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={{ paddingBottom: 60 }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} />}
    >
      {header}
      <View style={{ paddingHorizontal: 18, gap: 12 }}>
        {error && (
          <T alert style={{ color: c.danger, ...styles.small }}>
            {error}
          </T>
        )}
        {!pr && !error && <ActivityIndicator color={c.accent} style={{ marginTop: 30 }} />}
        {pr && (
          <>
            {pr.state === "open" && (
              <View style={[styles.box, { borderColor: c.border, backgroundColor: c.surface }]}>
                <View style={styles.line}>
                  <Icon
                    icon={pr.mergeState === "clean" || pr.mergeState === "hasHooks" ? CircleCheck : CircleAlert}
                    size={16}
                    color={pr.mergeState === "clean" || pr.mergeState === "hasHooks" ? c.added : c.warning}
                  />
                  <T medium style={{ flex: 1 }}>
                    {pr.autoMerge
                      ? `Auto-merge (${pr.autoMerge}) is on`
                      : (mergeText[pr.mergeState ?? ""] ?? "Checking whether it can merge…")}
                  </T>
                </View>
                {pr.draft ? (
                  <Button label="Ready for review" primary disabled={acting} onPress={() => act("ready", "Mark ready")} />
                ) : (
                  <View style={{ gap: 8 }}>
                    <Button
                      label="Squash and merge"
                      primary
                      icon={GitMerge}
                      disabled={acting}
                      onPress={() => act("squash", "Squash and merge")}
                    />
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      <Button
                        label={pr.autoMerge ? "Turn off auto-merge" : "Auto-merge"}
                        style={{ flex: 1 }}
                        disabled={acting}
                        onPress={() =>
                          pr.autoMerge
                            ? act("disableAutoMerge", "Turn off auto-merge")
                            : act("autoMerge", "Turn on auto-merge")
                        }
                      />
                      <Button
                        label="Close"
                        destructive
                        style={{ flex: 1 }}
                        disabled={acting}
                        onPress={() => act("close", "Close pull request", true)}
                      />
                    </View>
                  </View>
                )}
              </View>
            )}
            <View style={styles.stats}>
              {(
                [
                  [FileDiff, `${pr.changedFiles} files`],
                  [Plus, `${pr.additions}`],
                  [Minus, `${pr.deletions}`],
                  [Clock, ago(pr.updatedAt)],
                ] as const
              ).map(([icon, label]) => (
                <View key={label} style={[styles.stat, { backgroundColor: c.selected }]}>
                  <Icon icon={icon} size={12} color={c.mutedForeground} />
                  <T muted style={styles.small}>
                    {label}
                  </T>
                </View>
              ))}
            </View>

            {pr.checks.length > 0 && (
              <>
                <Heading>Checks</Heading>
                <View style={[styles.box, { borderColor: c.border, backgroundColor: c.surface, gap: 0, padding: 0 }]}>
                  {/* Checks that all passed fold into one row; a failed or running one shows. */}
                  {!allChecks && pr.checks.every((x) => x.state !== "failed" && x.state !== "pending") ? (
                    <Pressable accessibilityRole="button" onPress={() => setAllChecks(true)} style={styles.check}>
                      <ChecksMark state="passed" />
                      <T style={{ ...styles.small, flex: 1 }}>
                        {pr.checks.filter((x) => x.state === "passed").length} checks passed
                      </T>
                      <T faint style={styles.small}>
                        Show all
                      </T>
                    </Pressable>
                  ) : (allChecks ? pr.checks : pr.checks.filter((x) => x.state === "failed" || x.state === "pending")).map((check, i) => (
                    <Pressable
                      key={`${check.name}${i}`}
                      disabled={!check.url}
                      onPress={() => check.url && void Linking.openURL(check.url)}
                      style={[
                        styles.check,
                        i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
                      ]}
                    >
                      <ChecksMark state={check.state} />
                      <T numberOfLines={1} style={{ ...styles.small, flex: 1 }}>
                        {check.workflow ? `${check.workflow} / ${check.name}` : check.name}
                      </T>
                      <T faint style={styles.small}>
                        {check.state === "pending" ? "Running" : (check.conclusion ?? check.state)}
                      </T>
                    </Pressable>
                  ))}
                </View>
              </>
            )}

            {(pr.reviews?.length ?? 0) > 0 && (
              <>
                <Heading>Reviews</Heading>
                {pr.reviews!.map((r, i) => (
                  <View key={i} style={styles.line}>
                    <Icon
                      icon={
                        r.state === "approved"
                          ? CircleCheck
                          : r.state === "changesRequested"
                            ? CircleAlert
                            : r.state === "dismissed"
                              ? CircleMinus
                              : MessageSquare
                      }
                      size={14}
                      color={r.state === "approved" ? c.added : r.state === "changesRequested" ? c.danger : c.mutedForeground}
                    />
                    <T style={{ ...styles.small, flex: 1 }}>
                      <T medium style={styles.small}>
                        {r.author}
                      </T>{" "}
                      {r.state === "approved"
                        ? "approved"
                        : r.state === "changesRequested"
                          ? "requested changes"
                          : r.state === "dismissed"
                            ? "was dismissed"
                            : "commented"}
                    </T>
                    <T faint style={styles.small}>
                      {ago(r.submittedAt)}
                    </T>
                  </View>
                ))}
              </>
            )}

            <Heading>Description</Heading>
            {pr.body.trim() ? (
              <Markdown text={githubText(pr.body)} images="github" />
            ) : (
              <T faint style={styles.small}>
                No description.
              </T>
            )}

            {pr.comments.length > 0 && (
              <>
                <Heading>{`Conversation · ${pr.comments.length}`}</Heading>
                {pr.comments.map((comment, i) => (
                  <View
                    key={i}
                    style={[styles.box, { borderColor: c.border, backgroundColor: c.surface }]}
                  >
                    <View style={styles.line}>
                      <T medium style={{ ...styles.small, flex: 1 }}>
                        {comment.author}
                      </T>
                      <T faint style={styles.small}>
                        {ago(comment.createdAt)}
                      </T>
                    </View>
                    <Markdown text={githubText(comment.body)} images="github" />
                  </View>
                ))}
              </>
            )}

            {(pr.files?.length ?? 0) > 0 && (
              <>
                <Heading>Files</Heading>
                {pr.files!.map((f) => (
                  <Pressable key={f.path} onPress={() => setTab("changes")} style={styles.line}>
                    <Icon icon={FileText} size={13} color={c.faintForeground} />
                    <T numberOfLines={1} style={{ ...styles.small, flex: 1, fontFamily: font.mono, fontSize: 12 }}>
                      {f.path}
                    </T>
                    <T style={{ ...styles.small, color: c.added }}>+{f.additions}</T>
                    <T style={{ ...styles.small, color: c.danger }}>−{f.deletions}</T>
                  </Pressable>
                ))}
              </>
            )}
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 13, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6 },
  row: { flexDirection: "row", gap: 12, paddingLeft: 18 },
  rowBody: {
    flex: 1,
    gap: 3,
    paddingVertical: 11,
    paddingRight: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  line: { flexDirection: "row", alignItems: "center", gap: 6 },
  small: { fontSize: 13, lineHeight: 18 },
  empty: { alignItems: "center", gap: 12, paddingTop: 100, paddingHorizontal: 40 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 5,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  segments: { flexDirection: "row", borderRadius: 10, padding: 2, marginTop: 4 },
  segment: { flex: 1, alignItems: "center", paddingVertical: 7, borderRadius: 8 },
  box: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 14, gap: 10 },
  stats: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  stat: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  check: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 10 },
  diffFile: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
