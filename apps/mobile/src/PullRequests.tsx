// Pull requests, laid out as T3 Code's mobile app lays them out: every one linked to a thread on
// any computer (as the desktop's Pull requests page lists them, with its search), in a sheet with
// glass filter chips, and one pull request, pushed in the same sheet: its overview (status card,
// merge, labels, description, changed files), activity, diff, and guide, read through its thread's
// computer with `pr/view`, `pr/diff`, and `pr/guide`, merged or closed with `pr/act`, and reviewed,
// commented on, and edited with `pr/write` (PullRequestReview.tsx). plxd asks GitHub with the
// computer's own `gh`, so the phone needs no GitHub sign-in.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import type { LucideIcon } from "lucide-react-native";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock,
  Ellipsis,
  ExternalLink,
  FileDiff,
  FileText,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Link,
  MessageSquare,
  MessageSquarePlus,
  MessageSquareText,
  PencilLine,
  Check,
  Share as ShareIcon,
  TriangleAlert,
  UserCheck,
  UserX,
  X,
  Zap,
} from "lucide-react-native";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { PrAction, PrCheck, PrReviewThread, PrWrite, PullRequest } from "../../desktop/src/protocol/generated/protocol";
import { githubText } from "../../desktop/src/renderer/github";
import { numberOf, type PrEntry } from "../../desktop/src/renderer/pullRequestSearch";
import { showAlert, showMenu } from "./dialogStore";
import { useComputer, useFleet, type Computer } from "./fleet";
import { GlassButton } from "./Glass";
import { ago, useNav, type Screens } from "./nav";
import {
  Avatar,
  CardGroup,
  CardRow,
  DiffLine,
  DiffStats,
  Folding,
  GlassChip,
  GlassSearch,
  Heading,
  lookOf,
  Segmented,
  Timeline,
  toneColor,
  useCard,
  useGitHub,
  usePrColors,
} from "./PullRequestParts";
import {
  activityOf,
  checksSummary,
  defaultFilters,
  diffRows,
  latestReviews,
  lineAt,
  repoOf,
  reviewsSummary,
  rowOf,
  shownRows,
  threadsAt,
  type DiffRow,
  type PrFilters,
} from "./pullRequestLogic";
import { Guide, pendingCount, reviewWriting, ThreadCard, WriteSheet, type Writing } from "./PullRequestReview";
import { font } from "./theme";
import { Empty, Icon, Markdown, T, useColors } from "./ui";

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
  reads.set(e.url, answer.result);
  return answer.result;
}

/** Opens a pull request's link menu, for a row's long press: open it on GitHub or copy its link. */
function linkMenu(url: string) {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  showMenu(
    [
      { label: "Open on GitHub", icon: ExternalLink, onPress: () => void Linking.openURL(url) },
      { label: "Copy link", icon: Link, onPress: () => void Clipboard.setStringAsync(url) },
    ],
    `#${numberOf(url)} · ${repoOf(url)}`,
  );
}

/** Asks for one of `options` in a menu, the current one checked, as a filter chip's menu. */
function choose<V>(title: string, options: { value: V; label: string }[], current: V, pick: (v: V) => void) {
  showMenu(options.map((o) => ({ label: o.label, checked: o.value === current, onPress: () => pick(o.value) })), title);
}

const states: { value: PrFilters["state"]; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "draft", label: "Draft" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All states" },
];
const checkChoices: { value: PrFilters["checks"]; label: string }[] = [
  { value: undefined, label: "Any checks" },
  { value: "failed", label: "Failing" },
  { value: "pending", label: "Running" },
  { value: "passed", label: "Passing" },
];

/**
 * The glass filter chips under the search, in a row that scrolls sideways: state, checks, and,
 * when there's more than one, the computer and the repository, then Clear once any narrows.
 */
function FilterChips({
  value,
  onChange,
  computers,
  repos,
}: {
  value: PrFilters;
  onChange: (f: PrFilters) => void;
  computers: { id: string; name: string }[];
  repos: string[];
}) {
  const set = (patch: Partial<PrFilters>) => onChange({ ...value, ...patch });
  const state = states.find((s) => s.value === value.state)!.label;
  const checks = checkChoices.find((s) => s.value === value.checks)!.label;
  const computer = computers.find((m) => m.id === value.hostId)?.name;
  const narrowed = JSON.stringify(value) !== JSON.stringify(defaultFilters);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
    >
      <GlassChip
        label={state}
        accessibilityLabel={`State, ${state}`}
        active={value.state !== "open"}
        onPress={() => choose("State", states, value.state, (s) => set({ state: s }))}
      />
      <GlassChip
        label={value.checks ? checks : "Checks"}
        accessibilityLabel={`Checks, ${checks}`}
        active={!!value.checks}
        onPress={() => choose("Checks", checkChoices, value.checks, (s) => set({ checks: s }))}
      />
      {computers.length > 1 && (
        <GlassChip
          label={computer ?? "Computer"}
          accessibilityLabel={`Computer, ${computer ?? "any"}`}
          active={!!value.hostId}
          onPress={() =>
            choose(
              "Computer",
              [{ value: undefined, label: "Any computer" }, ...computers.map((m) => ({ value: m.id as string | undefined, label: m.name }))],
              value.hostId,
              (id) => set({ hostId: id }),
            )
          }
        />
      )}
      {repos.length > 1 && (
        <GlassChip
          label={value.repo?.split("/")[1] ?? "Repository"}
          accessibilityLabel={`Repository, ${value.repo ?? "any"}`}
          active={!!value.repo}
          onPress={() =>
            choose(
              "Repository",
              [{ value: undefined, label: "Any repository" }, ...repos.map((r) => ({ value: r as string | undefined, label: r }))],
              value.repo,
              (r) => set({ repo: r }),
            )
          }
        />
      )}
      {narrowed && <GlassChip label="Clear" icon={X} accessibilityLabel="Clear filters" onPress={() => onChange(defaultFilters)} />}
    </ScrollView>
  );
}

/** Its checks' mark, for a list row. */
function ChecksMark({ pr }: { pr: PullRequest }) {
  const c = usePrColors();
  if (pr.checksState === "passed") return <Icon icon={CircleCheck} size={13} color={c.added} />;
  if (pr.checksState === "failed") return <Icon icon={CircleX} size={13} color={c.danger} />;
  if (pr.checksState === "pending") return <Icon icon={Clock} size={13} color={c.warning} />;
  return null;
}

/** Its reviews' mark, for a list row: changes requested, or approved. */
function ReviewMark({ pr }: { pr: PullRequest }) {
  const c = usePrColors();
  const tone = reviewsSummary(pr).tone;
  if (tone === "danger") return <Icon icon={UserX} size={13} color={c.danger} />;
  if (tone === "success") return <Icon icon={UserCheck} size={13} color={c.added} />;
  return null;
}

/**
 * A list row, as T3's: the state icon at the left, marked when it conflicts; the author,
 * repository and number, and age; the title; then the thread that opened it, its checks and
 * reviews, and its lines changed. Before it's read, its thread's title in its place, with a
 * spinner, or why it can't be read. A long press opens its link menu.
 */
function PrRow({ entry, pr, error, offline }: { entry: PrEntry; pr?: PullRequest; error?: string; offline?: string }) {
  const c = usePrColors();
  const nav = useNav();
  const [symbol, color, stateLabel] = lookOf(pr, useGitHub());
  const small = { fontSize: 12, lineHeight: 16 };
  const problem = error ?? offline;
  const number = pr?.number ?? numberOf(entry.url);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        pr
          ? `Pull request ${number}, ${pr.title}, ${stateLabel}${pr.mergeState === "dirty" ? ", has conflicts" : ""}, by ${pr.author}${pr.checksState ? `, checks ${pr.checksState}` : ""}`
          : `Pull request ${number}, ${entry.threadTitle}${problem ? `, ${problem}` : ", loading"}`
      }
      accessibilityHint="Touch and hold for its link."
      onPress={() => nav.navigate("PullRequest", { hostId: entry.hostId, runId: entry.runId, url: entry.url })}
      onLongPress={() => linkMenu(entry.url)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.hover }]}
    >
      <View style={{ paddingTop: 11 }}>
        <Icon icon={symbol} size={20} color={color} />
        {pr?.mergeState === "dirty" && (
          <View style={[styles.badge, { backgroundColor: c.background }]}>
            <Icon icon={TriangleAlert} size={10} color={c.danger} strokeWidth={2.6} />
          </View>
        )}
      </View>
      <View style={[styles.rowBody, { borderBottomColor: c.border }]}>
        <View style={styles.line}>
          {pr && <Avatar login={pr.author} size={16} />}
          <T muted numberOfLines={1} style={{ ...small, flex: 1 }}>
            {pr?.repo ?? repoOf(entry.url)} <T faint style={small}>#{number}</T>
          </T>
          {pr ? (
            <T faint style={{ ...small, fontVariant: ["tabular-nums"] }}>
              {ago(pr.updatedAt)}
            </T>
          ) : (
            !problem && <ActivityIndicator size="small" color={c.faintForeground} style={{ transform: [{ scale: 0.7 }], height: 16 }} />
          )}
        </View>
        <T medium numberOfLines={2} style={{ fontSize: 16, lineHeight: 21, color: pr ? c.foreground : c.mutedForeground }}>
          {pr?.title ?? entry.threadTitle}
        </T>
        <View style={styles.line}>
          <Icon icon={problem ? CircleAlert : MessageSquare} size={11} color={error ? c.danger : c.faintForeground} />
          <T faint numberOfLines={1} style={{ ...small, flex: 1, color: error ? c.danger : c.faintForeground }}>
            {pr ? entry.threadTitle : (problem ?? entry.threadTitle)}
          </T>
          {pr && <ChecksMark pr={pr} />}
          {pr && <ReviewMark pr={pr} />}
          {pr && <DiffStats additions={pr.additions} deletions={pr.deletions} compact />}
        </View>
      </View>
    </Pressable>
  );
}

/** Nothing to list, with a way out when a search or filter narrowed it. */
function NoPullRequests({ title, note, onClear }: { title: string; note: string; onClear?: () => void }) {
  return (
    <Empty
      icon={GitPullRequest}
      title={title}
      note={note}
      action={onClear && <GlassChip label="Clear search and filters" icon={X} onPress={onClear} />}
    />
  );
}

/**
 * The Pull requests sheet: every pull request linked to a thread on any computer, read with
 * `pr/view`, under a glass search field (the desktop's search: title, number, branch, repository,
 * author, labels, and `label:`, `state:`, and `author:` terms) and a row of glass filter chips.
 * A row pushes its pull request in the same sheet.
 */
export function PullRequestList() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { computers } = useFleet();
  const entries = entriesOf(computers);
  const [, setVersion] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<PrFilters>(defaultFilters);
  const connected = new Set(computers.filter((m) => m.shownConnected).map((m) => m.machine.id));
  const up = new Set(computers.filter((m) => m.connectedNow).map((m) => m.machine.id));
  const key = entries.map((e) => `${e.url}@${up.has(e.hostId)}`).join();

  const load = useCallback(
    async (all: boolean) => {
      await Promise.all(
        entries
          .filter((e) => up.has(e.hostId) && (all || !reads.has(e.url)))
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

  const rows = entries.map((entry) => ({ entry, read: { pr: reads.get(entry.url) } }));
  const shown = shownRows(rows, query, filters);
  const repos = [...new Set(rows.map((r) => r.read.pr?.repo ?? repoOf(r.entry.url)))].sort();
  const narrowed = !!query.trim() || JSON.stringify(filters) !== JSON.stringify(defaultFilters);
  const clear = () => {
    setQuery("");
    setFilters(defaultFilters);
  };
  const names = new Map(computers.map((m) => [m.machine.id, m.machine.name]));

  return (
    // The list is the screen itself: a sheet sizes only a scroll view at its root.
    <FlatList
      style={{ backgroundColor: c.background }}
      data={shown}
      keyExtractor={(r) => r.entry.url}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={{ gap: 10, paddingTop: 4, paddingBottom: 6 }}>
          <View style={{ paddingHorizontal: 16 }}>
            <GlassSearch value={query} onChange={setQuery} placeholder="Search pull requests" />
          </View>
          <FilterChips
            value={filters}
            onChange={setFilters}
            computers={computers.map((m) => ({ id: m.machine.id, name: m.machine.name }))}
            repos={repos}
          />
        </View>
      }
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load(true).finally(() => setRefreshing(false));
          }}
        />
      }
      renderItem={({ item: { entry, read } }) => (
        <PrRow
          entry={entry}
          pr={read.pr}
          error={errors[entry.url]}
          offline={connected.has(entry.hostId) ? undefined : `${names.get(entry.hostId) ?? "Its computer"} is offline`}
        />
      )}
      ListEmptyComponent={
        !entries.length ? (
          <NoPullRequests title="No pull requests yet" note="A pull request a thread opens or links shows up here." />
        ) : query.trim() ? (
          <NoPullRequests title="No results" note={`No pull requests match "${query.trim()}".`} onClear={clear} />
        ) : narrowed ? (
          <NoPullRequests title="Nothing matches" note="Try other filters, or clear them." onClear={clear} />
        ) : (
          <NoPullRequests title="No open pull requests" note="Merged and closed ones are under the State filter." />
        )
      }
      ListFooterComponent={
        narrowed && shown.length ? (
          <T faint style={{ fontSize: 12, lineHeight: 16, textAlign: "center", paddingTop: 14 }}>
            {shown.length} of {entries.length} pull requests
          </T>
        ) : null
      }
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
    />
  );
}

/** The header's title: the number over the repository, as T3's. */
function HeaderTitle({ number, repo }: { number: string; repo: string }) {
  return (
    <View style={{ alignItems: "center" }}>
      <T style={{ fontSize: 16, lineHeight: 20, fontWeight: "600" }}>#{number}</T>
      <T muted numberOfLines={1} style={{ fontSize: 12, lineHeight: 15 }}>
        {repo}
      </T>
    </View>
  );
}

const checkLooks: Record<PrCheck["state"], [LucideIcon, "success" | "danger" | "warning" | "muted", string]> = {
  passed: [CircleCheck, "success", "Passed"],
  failed: [CircleX, "danger", "Failed"],
  pending: [Clock, "warning", "Running"],
  skipped: [CircleSlash, "muted", "Skipped"],
};
const checkOrder: Record<PrCheck["state"], number> = { failed: 0, pending: 1, passed: 2, skipped: 3 };

/** Rows folded under a card row, set in past its icon. */
function Folded({ children }: { children: ReactNode }) {
  const c = useColors();
  return (
    <View style={{ paddingLeft: 30, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }}>
      {children}
    </View>
  );
}

/** The checks row, which folds its checks under it, open when one failed or is running. */
function Checks({ pr }: { pr: PullRequest }) {
  const c = usePrColors();
  const summary = checksSummary(pr.checks);
  const [open, setOpen] = useState(summary.tone !== "success");
  const icon = summary.tone === "danger" ? CircleX : summary.tone === "warning" ? Clock : CircleCheck;
  return (
    <>
      <CardRow
        icon={icon}
        tint={toneColor(summary.tone, c)}
        title={summary.title}
        value={summary.value}
        expanded={open}
        onPress={() => setOpen(!open)}
      />
      {open && (
        <Folded>
          {[...pr.checks]
            .sort((a, b) => (checkOrder[a.state] ?? 4) - (checkOrder[b.state] ?? 4))
            .map((check, i) => {
              const [glyph, tone, word] = checkLooks[check.state] ?? [CircleAlert, "muted", check.state];
              return (
                <CardRow
                  key={`${check.name}${i}`}
                  icon={glyph}
                  tint={toneColor(tone, c)}
                  title={check.name}
                  detail={check.workflow}
                  value={word}
                  onPress={check.url ? () => void Linking.openURL(check.url!) : undefined}
                />
              );
            })}
          <CardRow
            icon={ArrowUpRight}
            title="Open checks on GitHub"
            divider={false}
            onPress={() => void Linking.openURL(`${pr.url}/checks`)}
          />
        </Folded>
      )}
    </>
  );
}

/** The reviews row, which folds each reviewer's verdict, and who's still asked, under it. */
function Reviews({ pr }: { pr: PullRequest }) {
  const c = usePrColors();
  const summary = reviewsSummary(pr);
  const latest = latestReviews(pr.reviews ?? []);
  const waiting = pr.reviewRequests.filter((who) => !latest.some((r) => r.author === who));
  const [open, setOpen] = useState(false);
  const any = latest.length + waiting.length > 0;
  const icon = summary.tone === "danger" ? UserX : summary.tone === "success" ? UserCheck : MessageSquareText;
  return (
    <>
      <CardRow
        icon={icon}
        tint={toneColor(summary.tone, c)}
        title={summary.title}
        value={summary.value}
        expanded={any ? open : undefined}
        onPress={any ? () => setOpen(!open) : undefined}
      />
      {open && (
        <Folded>
          {latest.map((r) => (
            <Person
              key={r.author}
              login={r.author}
              icon={r.state === "approved" ? Check : r.state === "changesRequested" ? FileDiff : MessageSquareText}
              color={r.state === "approved" ? c.added : r.state === "changesRequested" ? c.danger : c.faintForeground}
            >
              {r.state === "approved" ? "Approved" : r.state === "changesRequested" ? "Requested changes" : "Commented"} ·{" "}
              {ago(r.submittedAt)}
            </Person>
          ))}
          {waiting.map((who) => (
            <Person key={who} login={who} icon={Clock} color={c.faintForeground}>
              Review requested
            </Person>
          ))}
        </Folded>
      )}
    </>
  );
}

/** A reviewer's row under Reviews: their verdict's mark, their avatar and login, and what they did. */
function Person({ login, icon, color, children }: { login: string; icon: LucideIcon; color: string; children: ReactNode }) {
  return (
    <View style={styles.person}>
      <Icon icon={icon} size={18} color={color} />
      <Avatar login={login} size={32} />
      <View style={{ flex: 1 }}>
        <T medium numberOfLines={1} style={{ fontSize: 14, lineHeight: 19 }}>
          {login}
        </T>
        <T muted style={{ fontSize: 12, lineHeight: 16 }}>
          {children}
        </T>
      </View>
    </View>
  );
}

/** The branch row: whether it merges cleanly into its base. */
function Branch({ pr }: { pr: PullRequest }) {
  const c = usePrColors();
  const base = pr.baseBranch;
  const [icon, color, title]: [LucideIcon, string, string] =
    pr.mergeState === "dirty"
      ? [TriangleAlert, c.danger, `Conflicts with ${base}`]
      : pr.mergeState === "behind"
        ? [GitBranch, c.warning, `Behind ${base}`]
        : pr.mergeState === "blocked"
          ? [CircleAlert, c.warning, "Merging is blocked"]
          : pr.mergeState === "draft"
            ? [GitPullRequestDraft, c.faintForeground, "Still a draft"]
            : pr.mergeState
              ? [CircleCheck, c.added, `No conflicts with ${base}`]
              : [GitBranch, c.faintForeground, "Checking whether it can merge…"];
  return <CardRow icon={icon} tint={color} title={title} />;
}

type Method = "squash" | "merge";
const methodLabels: Record<Method, string> = { squash: "Squash and merge", merge: "Create a merge commit" };

/**
 * The card's foot, as T3's: one prominent split button in GitHub's green that merges by the
 * chosen method, its chevron choosing the method or turning auto-merge on or off. A draft gets
 * Ready for review.
 */
function MergeControls({
  pr,
  acting,
  act,
}: {
  pr: PullRequest;
  acting: boolean;
  act: (action: PrAction, label: string, destructive?: boolean) => void;
}) {
  const c = useColors();
  const gh = useGitHub();
  const [method, setMethod] = useState<Method>("squash");
  const can = !acting && pr.mergeState !== "dirty";
  const fg = can ? "#ffffff" : c.faintForeground;
  if (pr.draft)
    return (
      <View style={{ padding: 12 }}>
        <Pressable
          accessibilityRole="button"
          disabled={acting}
          onPress={() => act("ready", "Mark ready for review")}
          style={({ pressed }) => [styles.merge, { backgroundColor: c.foreground }, (pressed || acting) && { opacity: 0.7 }]}
        >
          <Icon icon={GitPullRequest} size={16} color={c.background} />
          <T style={{ fontSize: 14, fontWeight: "600", color: c.background }}>Ready for review</T>
        </Pressable>
      </View>
    );
  const options = () => {
    const auto = pr.autoMerge ? "Turn off auto-merge" : "Turn on auto-merge";
    showMenu(
      [
        ...(Object.keys(methodLabels) as Method[]).map((m) => ({ label: methodLabels[m], checked: m === method, onPress: () => setMethod(m) })),
        { label: auto, icon: Zap, onPress: () => act(pr.autoMerge ? "disableAutoMerge" : "autoMerge", auto) },
      ],
      "Merge options",
    );
  };
  return (
    <View style={{ padding: 12, gap: 8 }}>
      <View style={[styles.split, { backgroundColor: can ? gh.merge : c.selected }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !can, busy: acting }}
          disabled={!can}
          onPress={() => act(method, method === "squash" ? "Squash and merge" : "Merge pull request")}
          style={({ pressed }) => [styles.merge, { flex: 1 }, pressed && { opacity: 0.7 }]}
        >
          {acting ? <ActivityIndicator size="small" color={fg} /> : <Icon icon={GitMerge} size={16} color={fg} />}
          <T style={{ fontSize: 14, fontWeight: "600", color: fg }}>
            {acting ? "Working…" : method === "squash" ? "Squash and merge" : "Merge pull request"}
          </T>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Merge options"
          disabled={acting}
          onPress={options}
          style={({ pressed }) => [styles.splitMore, { borderLeftColor: can ? "rgba(0, 0, 0, 0.28)" : c.border }, pressed && { opacity: 0.7 }]}
        >
          <Icon icon={ChevronDown} size={14} color={fg} strokeWidth={2.4} />
        </Pressable>
      </View>
      {pr.autoMerge && (
        <T muted style={{ fontSize: 13, lineHeight: 17, paddingHorizontal: 4 }}>
          Auto-merge is on · {pr.autoMerge}
        </T>
      )}
    </View>
  );
}

/** Diffs read, by URL, so switching back to Changes doesn't fetch again. */
const diffs = new Map<string, { rows: DiffRow[]; truncated: boolean }>();

/** Where the Changes tab scrolls to: a file, and a line in it. */
type Focus = { path: string; line?: number };

/**
 * The Changes tab: the pull request's header, then its diff, scrolled to `focus` when set, with
 * each review thread under its line. With `onLine`, tapping a line comments on it.
 */
function Diff({
  hostId,
  runId,
  url,
  header,
  focus,
  threads,
  renderThread,
  onLine,
}: {
  hostId: string;
  runId: string;
  url: string;
  header: ReactNode;
  focus?: Focus;
  threads: PrReviewThread[];
  renderThread: (thread: PrReviewThread) => ReactNode;
  onLine?: (at: { path: string; line: number; side: "left" | "right" }) => void;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const list = useRef<FlatList<DiffRow>>(null);
  const [state, setState] = useState<{ rows: DiffRow[]; truncated: boolean } | string | undefined>(() =>
    diffs.get(url),
  );
  useEffect(() => {
    if (state) return;
    void window.parallax.request(hostId, "pr/diff", { runId, url }).then((a) => {
      if ("error" in a) return setState(a.error.message);
      const read = { rows: diffRows(a.result.diff), truncated: a.result.truncated };
      diffs.set(url, read);
      setState(read);
    });
  }, [hostId, runId, url]);
  const rows = typeof state === "object" ? state.rows : undefined;
  const placed = rows ? threadsAt(rows, threads) : new Map<number, PrReviewThread[]>();
  useEffect(() => {
    const index = rows && focus ? rowOf(rows, focus.path, focus.line) : -1;
    if (index >= 0) requestAnimationFrame(() => list.current?.scrollToIndex({ index, animated: false, viewPosition: focus?.line ? 0.3 : 0 }));
  }, [rows, focus]);
  return (
    <FlatList
      ref={list}
      style={{ backgroundColor: c.background }}
      data={rows ?? []}
      keyExtractor={(_, i) => String(i)}
      extraData={threads}
      renderItem={({ item, index }) => {
        const at = onLine && rows ? lineAt(rows, index) : undefined;
        const here = placed.get(index);
        return (
          <>
            {at ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Comment on ${at.path} line ${at.line}`}
                onPress={() => onLine!(at)}
                style={({ pressed }) => pressed && { opacity: 0.6 }}
              >
                <DiffLine row={item} />
              </Pressable>
            ) : (
              <DiffLine row={item} />
            )}
            {here && <View style={{ gap: 8, padding: 10 }}>{here.map((t) => <View key={t.id}>{renderThread(t)}</View>)}</View>}
          </>
        );
      }}
      initialNumToRender={80}
      // Rows differ in height, so a far file is reached in two steps: near it, then to it.
      onScrollToIndexFailed={(info) => {
        list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
        setTimeout(() => list.current?.scrollToIndex({ index: info.index, animated: false }), 120);
      }}
      ListHeaderComponent={
        <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
          {header}
          {!state && <ActivityIndicator style={{ marginTop: 30 }} color={c.accent} />}
          {typeof state === "string" && (
            <T alert style={{ color: c.danger, fontSize: 14 }}>
              {state}
            </T>
          )}
          {rows && !rows.length && (
            <T muted style={{ fontSize: 14 }}>
              No text changes.
            </T>
          )}
        </View>
      }
      ListFooterComponent={
        typeof state === "object" && state.truncated ? (
          <T faint style={{ padding: 16, fontSize: 13 }}>
            The diff is cut short here. See the rest on GitHub.
          </T>
        ) : null
      }
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
    />
  );
}

export function PullRequestScreen({
  route,
  navigation,
}: NativeStackScreenProps<Screens, "PullRequest">) {
  const { hostId, runId, url } = route.params;
  const c = useColors();
  const card = useCard();
  const computer = useComputer(hostId);
  const [pr, setPr] = useState<PullRequest | undefined>(reads.get(url));
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<"overview" | "activity" | "changes" | "guide">("overview");
  const [focus, setFocus] = useState<Focus>();
  const [writing, setWriting] = useState<Writing>();
  const [acting, setActing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const connectedNow = !!computer?.connectedNow;
  const connected = !!computer?.shownConnected;
  const open = pr?.state === "open";
  // A plxd with `prWatch` writes to pull requests, and one with `prGuide` writes guides.
  const capabilities = computer?.view.capabilities ?? {};
  const canWrite = connectedNow && "prWatch" in capabilities;
  const canGuide = "prGuide" in capabilities && !!pr?.headSha;
  const threads = pr?.reviewThreads ?? [];
  const pending = pendingCount(threads);

  const load = useCallback(async () => {
    const read = await view({ hostId, runId, url });
    if (typeof read === "string") setError(read);
    else {
      setError(undefined);
      setPr(read);
    }
  }, [hostId, runId, url]);
  useEffect(() => {
    if (connectedNow) void load();
  }, [connectedNow, load]);

  function act(action: PrAction, label: string, destructive = false) {
    showAlert(`${label}?`, pr ? `${pr.repo} #${pr.number}` : undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: label,
        style: destructive ? "destructive" : "default",
        onPress: async () => {
          setActing(true);
          const answer = await window.parallax.request(hostId, "pr/act", { runId, url, action });
          setActing(false);
          if ("error" in answer) return showAlert(`Couldn't ${label.toLowerCase()}`, answer.error.message);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          reads.set(url, answer.result);
          setPr(answer.result);
        },
      },
    ]);
  }

  /** Sends `w` with `pr/write`, then reads the pull request again. Resolves to whether it worked. */
  async function send(w: PrWrite): Promise<boolean> {
    const answer = await window.parallax.request(hostId, "pr/write", { url, write: w });
    if ("error" in answer) {
      showAlert("GitHub didn't take that", answer.error.message);
      return false;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    void load();
    return true;
  }

  /** Opens the sheet to reply to `thread`, or resolves it. */
  const threadCard = (thread: PrReviewThread, bare?: boolean) => (
    <ThreadCard
      thread={thread}
      bare={bare}
      onReply={
        canWrite
          ? () =>
              setWriting({
                title: "Reply",
                placeholder: "Reply",
                actions: [
                  { label: "Reply and resolve", empty: false, write: (body) => ({ kind: "replyToThread", reviewThreadId: thread.id, body, resolve: true }) },
                  { label: "Reply", primary: true, write: (body) => ({ kind: "replyToThread", reviewThreadId: thread.id, body }) },
                ],
              })
          : undefined
      }
      onResolve={canWrite ? () => void send({ kind: "replyToThread", reviewThreadId: thread.id, resolve: true }) : undefined}
    />
  );

  /** Opens the sheet to comment on a diff line, into the pending review. */
  function commentOn(at: { path: string; line: number; side: "left" | "right" }) {
    const nodeId = pr?.nodeId;
    if (!nodeId) return;
    setWriting({
      title: `${at.path.slice(at.path.lastIndexOf("/") + 1)}:${at.line}`,
      note: "Adds to your pending review, which Review sends.",
      placeholder: "Comment on this line",
      actions: [
        {
          label: "Add to review",
          primary: true,
          write: (body) => ({ kind: "addReviewComment", pullRequestId: nodeId, path: at.path, line: at.line, side: at.side, body }),
        },
      ],
    });
  }

  /** The header's menu: open, copy, or share its link, edit it, and close it while it's open. */
  function more() {
    showMenu([
      { label: "Open on GitHub", icon: ExternalLink, onPress: () => void Linking.openURL(url) },
      { label: "Copy link", icon: Link, onPress: () => void Clipboard.setStringAsync(url) },
      { label: "Share…", icon: ShareIcon, onPress: () => void Share.share({ url }) },
      ...(pr && canWrite
        ? [
            {
              label: "Edit title and description",
              icon: PencilLine,
              onPress: () =>
                setWriting({
                  title: "Edit",
                  placeholder: "Description",
                  titleField: pr.title,
                  body: pr.body,
                  actions: [{ label: "Save", primary: true, empty: true, write: (body, title) => ({ kind: "edit", title, body }) }],
                }),
            },
          ]
        : []),
      ...(open ? [{ label: "Close pull request", icon: GitPullRequestClosed, destructive: true, onPress: () => act("close", "Close pull request", true) }] : []),
    ]);
  }

  /** The state's menu, as T3's: turn a draft ready or back, or close it. */
  function stateMenu() {
    if (!pr || !open) return;
    showMenu(
      [
        pr.draft
          ? { label: "Ready for review", icon: GitPullRequest, onPress: () => act("ready", "Mark ready for review") }
          : { label: "Convert to draft", icon: GitPullRequestDraft, onPress: () => act("draft", "Convert to draft") },
        { label: "Close pull request", icon: GitPullRequestClosed, destructive: true, onPress: () => act("close", "Close pull request", true) },
      ],
      "Pull request status",
    );
  }

  // The header sits on the page's own background, with no hairline, a glass back button at the
  // left, as the sheet's own close button, and the menu at the right.
  useLayoutEffect(() => {
    navigation.setOptions({
      title: `#${numberOf(url)}`,
      headerTitle: () => <HeaderTitle number={numberOf(url)} repo={pr?.repo ?? repoOf(url)} />,
      headerStyle: { backgroundColor: c.background },
      headerShadowVisible: false,
      headerLeft: () => (
        <GlassButton label="Back" onPress={() => navigation.goBack()}>
          <Icon icon={ChevronLeft} size={22} />
        </GlassButton>
      ),
      headerRight: () => (
        <GlassButton label="More" onPress={more}>
          <Icon icon={Ellipsis} size={20} />
        </GlassButton>
      ),
      headerLeftBackgroundVisible: false,
      headerRightBackgroundVisible: false,
    });
  }, [navigation, url, pr, c.background, canWrite]);

  const gh = useGitHub();
  const [symbol, , stateLabel, fill] = lookOf(pr, gh);
  const updated = pr && ago(pr.updatedAt);
  const copy = (branch: string) =>
    void Clipboard.setStringAsync(branch).then(() => Haptics.selectionAsync());

  const header = (
    <View style={{ gap: 20, paddingBottom: 20 }}>
      <View style={{ gap: 12 }}>
        <View style={[styles.line, { flexWrap: "wrap", gap: 8 }]}>
          <Pressable
            accessibilityRole={open ? "button" : undefined}
            accessibilityLabel={`Status, ${stateLabel}`}
            disabled={!open}
            onPress={stateMenu}
            style={({ pressed }) => [styles.line, styles.state, { backgroundColor: fill }, pressed && { opacity: 0.7 }]}
          >
            <Icon icon={symbol} size={14} color="#ffffff" />
            <T style={{ fontSize: 13, lineHeight: 17, fontWeight: "600", color: "#ffffff" }}>{stateLabel}</T>
            {open && <Icon icon={ChevronDown} size={10} color="#ffffff" strokeWidth={2.4} />}
          </Pressable>
          {pr && <DiffStats additions={pr.additions} deletions={pr.deletions} compact />}
          {pr && (
            <T muted style={{ fontSize: 12, lineHeight: 16 }}>
              {pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"}
            </T>
          )}
        </View>
        <T selectable style={{ fontSize: 21, lineHeight: 28, fontWeight: "700" }}>
          {pr?.title ?? `Pull request #${numberOf(url)}`}
        </T>
        {pr && (
          <>
            <View style={[styles.line, { gap: 8 }]}>
              <Avatar login={pr.author} size={20} />
              <T medium numberOfLines={1} style={{ flex: 1, fontSize: 13, lineHeight: 17 }}>
                {pr.author}
              </T>
              <T muted numberOfLines={1} style={{ fontSize: 12, lineHeight: 16 }}>
                {updated === "now" ? "Updated just now" : `Updated ${updated} ago`}
              </T>
            </View>
            <View style={[styles.line, { gap: 6, alignItems: "flex-start" }]}>
              <Pressable accessibilityLabel={`Copy base branch ${pr.baseBranch}`} hitSlop={8} onPress={() => copy(pr.baseBranch)} style={{ flexShrink: 1 }}>
                <T muted style={styles.branch}>
                  {pr.baseBranch}
                </T>
              </Pressable>
              <View style={{ paddingTop: 2 }}>
                <Icon icon={ArrowLeft} size={11} color={c.faintForeground} />
              </View>
              <Pressable accessibilityLabel={`Copy head branch ${pr.headBranch}`} hitSlop={8} onPress={() => copy(pr.headBranch)} style={{ flexShrink: 1 }}>
                <T muted style={styles.branch}>
                  {pr.headBranch}
                </T>
              </Pressable>
            </View>
          </>
        )}
      </View>
      <Segmented
        options={[
          { value: "overview", label: "Overview" },
          { value: "activity", label: "Activity" },
          { value: "changes", label: "Changes" },
          ...(canGuide ? [{ value: "guide" as const, label: "Guide" }] : []),
        ]}
        value={tab}
        onChange={(t) => {
          setFocus(undefined);
          setTab(t);
        }}
      />
    </View>
  );

  const sheet = <WriteSheet writing={writing} send={send} onClose={() => setWriting(undefined)} />;
  if (tab === "changes")
    return (
      <>
        <Diff
          hostId={hostId}
          runId={runId}
          url={url}
          header={header}
          focus={focus}
          threads={threads}
          renderThread={(t) => threadCard(t, true)}
          onLine={open && canWrite && pr?.nodeId ? commentOn : undefined}
        />
        {sheet}
      </>
    );

  const files = pr?.files ?? [];
  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load().finally(() => setRefreshing(false));
          }}
        />
      }
    >
      {header}
      {error && (
        <T alert style={{ color: c.danger, fontSize: 14, marginBottom: 12 }}>
          {error}
        </T>
      )}
      {!pr && !error && <ActivityIndicator color={c.accent} style={{ marginTop: 30 }} />}
      {pr && tab === "activity" && (
        <>
          <Timeline events={activityOf(pr)} renderThread={(t) => threadCard(t)} />
          {canWrite && (
            <CardGroup>
              <CardRow
                icon={MessageSquarePlus}
                title="Comment"
                divider={false}
                onPress={() =>
                  setWriting({
                    title: "Comment",
                    placeholder: "Leave a comment",
                    actions: [{ label: "Comment", primary: true, write: (body) => ({ kind: "comment", body }) }],
                  })
                }
              />
            </CardGroup>
          )}
        </>
      )}
      {pr?.headSha && tab === "guide" && (
        <Guide
          computer={computer}
          url={url}
          headSha={pr.headSha}
          onOpen={(path, line) => {
            setFocus({ path, line });
            setTab("changes");
          }}
        />
      )}
      {pr && tab === "overview" && (
        <View style={{ gap: 20 }}>
          <CardGroup>
            {pr.checks.length > 0 && <Checks pr={pr} />}
            <Reviews pr={pr} />
            {open && canWrite && (
              <CardRow
                icon={MessageSquareText}
                title="Review"
                value={pending ? `${pending} pending` : undefined}
                onPress={() => setWriting(reviewWriting(pr.pendingReviewId, pending))}
              />
            )}
            {open ? (
              <>
                <Branch pr={pr} />
                <MergeControls pr={pr} acting={acting} act={act} />
              </>
            ) : pr.state === "merged" ? (
              <CardRow
                icon={GitMerge}
                tint={gh.merged}
                title={pr.mergedBy ? `Merged by ${pr.mergedBy}` : "Merged"}
                value={pr.mergedAt && ago(pr.mergedAt)}
                divider={false}
              />
            ) : (
              <CardRow
                icon={GitPullRequestClosed}
                tint={gh.closed}
                title="Closed without merging"
                value={pr.closedAt && ago(pr.closedAt)}
                divider={false}
              />
            )}
          </CardGroup>

          {pr.labels.length > 0 && (
            <View style={[styles.line, { flexWrap: "wrap", gap: 8 }]}>
              {pr.labels.map((label) => (
                <View key={label} style={[styles.label, { backgroundColor: card }]}>
                  <T medium muted style={{ fontSize: 12, lineHeight: 16 }}>
                    {label}
                  </T>
                </View>
              ))}
            </View>
          )}

          <View style={{ gap: 12 }}>
            <Heading>Description</Heading>
            {pr.body.trim() ? (
              <Folding height={240} fill={c.background}>
                <Markdown text={githubText(pr.body)} images="github" />
              </Folding>
            ) : (
              <T muted style={{ fontSize: 14 }}>
                No description provided.
              </T>
            )}
          </View>

          {files.length > 0 && (
            <View style={[styles.filesTop, { borderTopColor: c.border }]}>
              <View style={[styles.line, { minHeight: 56, gap: 8 }]}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Heading>Changed files</Heading>
                  <T muted style={{ fontSize: 12, lineHeight: 16 }}>
                    {pr.changedFiles} changed {pr.changedFiles === 1 ? "file" : "files"}
                  </T>
                </View>
                <DiffStats additions={pr.additions} deletions={pr.deletions} compact />
              </View>
              {files.map((f) => {
                const slash = f.path.lastIndexOf("/");
                return (
                  <Pressable
                    key={f.path}
                    accessibilityRole="button"
                    accessibilityLabel={`View diff for ${f.path}`}
                    onPress={() => {
                      setFocus({ path: f.path });
                      setTab("changes");
                    }}
                    style={({ pressed }) => [styles.file, { borderBottomColor: c.border }, pressed && { opacity: 0.6 }]}
                  >
                    <Icon icon={FileText} size={20} color={c.faintForeground} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <T medium numberOfLines={2} style={{ fontSize: 13, lineHeight: 17 }}>
                        {f.path.slice(slash + 1)}
                      </T>
                      {slash > 0 && (
                        <T muted numberOfLines={1} style={{ fontSize: 12, lineHeight: 16 }}>
                          {f.path.slice(0, slash)}
                        </T>
                      )}
                    </View>
                    <DiffStats additions={f.additions} deletions={f.deletions} compact />
                    <Icon icon={ChevronRight} size={12} color={c.faintForeground} strokeWidth={2.4} />
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>
      )}
      {sheet}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", alignItems: "center", gap: 6 },
  row: { flexDirection: "row", gap: 12, paddingLeft: 16 },
  rowBody: { flex: 1, gap: 4, paddingVertical: 10, paddingRight: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  badge: { position: "absolute", right: -4, bottom: -4, width: 14, height: 14, borderRadius: 7, alignItems: "center", justifyContent: "center" },
  branch: { fontFamily: font.mono, fontSize: 12, lineHeight: 16 },
  state: { minHeight: 30, gap: 6, paddingHorizontal: 12, borderRadius: 15 },
  split: { flexDirection: "row", borderRadius: 12, overflow: "hidden" },
  merge: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 12, borderRadius: 12 },
  splitMore: { width: 44, alignItems: "center", justifyContent: "center", borderLeftWidth: StyleSheet.hairlineWidth },
  person: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 8 },
  label: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  filesTop: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 4, marginTop: 12 },
  file: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
});
