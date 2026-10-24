// A thread's details, as the desktop's Thread details popover and its top bar show them: where it
// runs (computer, repository, folder, branch), what it runs on (provider, model, effort, access),
// its changes and pull requests, and when it started. A row with a value copies it.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import {
  Brain,
  Calendar,
  Cpu,
  FileDiff,
  Folder,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Hash,
  Laptop,
  LockOpen,
  Sparkles,
} from "lucide-react-native";
import { ScrollView } from "react-native";

import { accessLevels, effortLevels } from "../../desktop/src/renderer/catalog";
import { groupOf, noRepo } from "../../desktop/src/renderer/threads";
import { statusLabel } from "../../desktop/src/renderer/transcript";
import { useComputer } from "./fleet";
import type { Screens } from "./nav";
import { Row, Section, T, useColors } from "./ui";

const copy = (text: string) => {
  void Clipboard.setStringAsync(text);
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
};

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : undefined);

export function ThreadDetailsScreen({ route, navigation }: NativeStackScreenProps<Screens, "ThreadDetails">) {
  const { hostId, runId } = route.params;
  const c = useColors();
  const computer = useComputer(hostId);
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
  const row = (
    icon: Parameters<typeof Row>[0]["icon"],
    title: string,
    value: string | undefined,
    last = false,
  ) =>
    value ? (
      <Row key={title} icon={icon} title={title} detail={value} last={last} onPress={() => copy(value)} />
    ) : null;
  const diff = run?.diff;
  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={{ padding: 16, gap: 22, paddingBottom: 48 }}
    >
      <T medium style={{ fontSize: 20, lineHeight: 26, fontWeight: "600", paddingHorizontal: 4 }}>
        {state.titles[runId] ?? "Thread"}
      </T>
      <Section title="Workspace">
        {row(Laptop, "Computer", computer?.machine.name)}
        {row(FolderGit2, "Repository", repo?.name ?? "No repo")}
        {row(Folder, "Folder", run?.worktreePath ?? repo?.path)}
        {row(GitBranch, "Branch", run?.branch, true)}
      </Section>
      <Section title="Agent">
        {row(Cpu, "Provider", run?.backend)}
        {row(Sparkles, "Model", run?.model ?? "Default model")}
        {row(Brain, "Reasoning", effortLevels.find((l) => l.value === run?.effort)?.name)}
        {row(LockOpen, "Access", run?.permission && accessLevels[run.permission].label)}
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
        {row(Calendar, "Started", when(thread.createdAt))}
        {row(Calendar, "Last prompt", when(thread.lastPromptAt))}
        {row(Hash, "Thread id", runId, true)}
      </Section>
      <T faint style={{ fontSize: 12, paddingHorizontal: 16 }}>
        Tap a row to copy it.
      </T>
    </ScrollView>
  );
}
