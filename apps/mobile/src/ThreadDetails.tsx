// A thread's details, as the desktop's Thread details popover and its top bar show them: where it
// runs (computer, repository, folder, branch), what it runs on (provider, model, effort, access),
// its changes and pull requests, and when it started. A row with a value copies it.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import type { LucideIcon } from "lucide-react-native";
import {
  Brain,
  CalendarClock,
  CalendarPlus,
  FileDiff,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Hash,
  LockOpen,
} from "lucide-react-native";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { accessLevels, effortLevels } from "../../desktop/src/renderer/catalog";
import { groupOf, noRepo } from "../../desktop/src/renderer/threads";
import { statusLabel } from "../../desktop/src/renderer/transcript";
import { accessIcons } from "./Composer";
import { useComputer } from "./fleet";
import { ProviderLogo } from "./logos";
import { useOffers } from "./offers";
import type { Screens } from "./nav";
import { DeviceIcon, Row, Section, T, useColors } from "./ui";

const copy = (text: string) => {
  void Clipboard.setStringAsync(text);
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
};

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : undefined);

export function ThreadDetailsScreen({ route, navigation }: NativeStackScreenProps<Screens, "ThreadDetails">) {
  const { hostId, runId } = route.params;
  const c = useColors();
  const computer = useComputer(hostId);
  const insets = useSafeAreaInsets();
  const offers = useOffers(computer);
  const state = computer?.view.state;
  const thread = state?.threads.find((t) => t.id === runId);
  const run = state?.runs[runId];
  if (!state || !thread)
    return (
      <T muted style={{ padding: 24 }}>
        This thread isn't loaded.
      </T>
    );
  const group = groupOf(state, thread);
  const repo = group === noRepo ? undefined : state.repos.find((r) => r.id === group);
  /** A row with an icon or a mark of its own, which copies its value. */
  const row = (
    icon: LucideIcon | React.ReactNode,
    title: string,
    value: string | undefined,
    last = false,
  ) => {
    if (!value) return null;
    const lucide = typeof icon === "function" || (typeof icon === "object" && icon !== null && "render" in icon);
    return (
      <Row
        key={title}
        icon={lucide ? (icon as LucideIcon) : undefined}
        leading={lucide ? undefined : <View style={{ width: 18, alignItems: "center" }}>{icon as React.ReactNode}</View>}
        title={title}
        detail={value}
        last={last}
        onPress={() => copy(value)}
      />
    );
  };
  const offer = offers.find((o) => o.id === run?.backend);
  const mark = <ProviderLogo kind={offer?.kind ?? run?.backend} size={17} />;
  const modelName = offer?.models.find((m) => m.id === run?.model)?.name ?? run?.model;
  const diff = run?.diff;
  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={{ padding: 16, gap: 22, paddingBottom: insets.bottom + 40 }}
    >
      <T medium style={{ fontSize: 20, lineHeight: 26, fontWeight: "600", paddingHorizontal: 4 }}>
        {state.titles[runId] ?? "Thread"}
      </T>
      <Section title="Workspace">
        {row(<DeviceIcon name={computer?.machine.name ?? ""} size={17} color={c.mutedForeground} />, "Computer", computer?.machine.name)}
        {row(FolderGit2, "Repository", repo?.name ?? "No repo")}
        {row(run?.worktreePath ? FolderGit2 : FolderOpen, run?.worktreePath ? "Worktree" : "Folder", run?.worktreePath ?? repo?.path)}
        {row(GitBranch, "Branch", run?.branch, true)}
      </Section>
      <Section title="Agent">
        {row(mark, "Provider", offer?.name ?? run?.backend)}
        {row(mark, "Model", modelName ?? "Default model")}
        {row(Brain, "Reasoning", effortLevels.find((l) => l.value === run?.effort)?.name)}
        {row(run?.permission ? accessIcons[run.permission] : LockOpen, "Access", run?.permission && accessLevels[run.permission].label)}
        {row(Hash, "Status", run && statusLabel(run.status), true)}
      </Section>
      {(diff?.files || run?.pullRequests?.length) && (
        <Section title="Changes">
          {diff?.files
            ? row(FileDiff, "Changes", `${diff.files} files · +${diff.insertions} −${diff.deletions}`)
            : null}
          {(run?.pullRequests ?? []).map((url, i, all) => (
            <Row
              key={url}
              icon={GitPullRequest}
              title={`Pull request #${url.split("/").pop()}`}
              detail={url.replace("https://github.com/", "")}
              chevron
              last={i === all.length - 1}
              onPress={() => navigation.navigate("PullRequest", { hostId, runId, url })}
            />
          ))}
        </Section>
      )}
      <Section title="History">
        {row(CalendarPlus, "Started", when(thread.createdAt))}
        {row(CalendarClock, "Last prompt", when(thread.lastPromptAt))}
        {row(Hash, "Thread id", runId, true)}
      </Section>
      <T faint style={{ fontSize: 12, paddingHorizontal: 16 }}>
        Tap a row to copy it.
      </T>
    </ScrollView>
  );
}
