// Projects (0090, 0097), in a sheet with its own stack: every computer's Projects, one row per name,
// with a plus that creates one; a Project's page, with its threads from every computer holding one
// of its name, New thread, and its instructions and file names; and its instructions in a text
// editor. A thread's long press and Thread details change its Project with `threadProject`.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Check, FileText, Pencil, Plus, SquarePen } from "lucide-react-native";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { Repo, Thread } from "../../desktop/src/protocol/generated/protocol";
import { activeAt, attentionOf } from "../../desktop/src/renderer/attention";
import { projectEntries } from "../../desktop/src/renderer/projectList";
import {
  addToProject,
  asksOf,
  projectChoices,
  projectOf,
  waitingOf,
  type ThreadsView,
} from "../../desktop/src/renderer/threads";
import { type Computer, useComputer, useFleet } from "./fleet";
import { GlassButton } from "./Glass";
import { ProviderLogo } from "./logos";
import { ago, useShow, type ProjectScreens } from "./nav";
import { projectGroups } from "./projectLogic";
import { RepoIcon } from "./RepoIcon";
import { AttentionBadge, Button, DeviceIcon, Icon, Row, Section, T, useColors } from "./ui";

/** Whether `name` is a Project on `computer`. */
const holds = (computer: Computer, name: string) =>
  computer.view.state.repos.some((r) => r.project && r.name === name);

/** A sheet's page: a scroll view at its root, kept clear of the header and the home indicator. */
function Page({ children }: { children: React.ReactNode }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      keyboardDismissMode="interactive"
      contentContainerStyle={{ padding: 16, gap: 22, paddingBottom: insets.bottom + 40 }}
    >
      {children}
    </ScrollView>
  );
}

/**
 * The list: one row per Project name across computers, most recently active first. Its plus asks
 * for a name, then which computer when several can make it, and opens the new Project.
 */
export function ProjectList({ navigation }: NativeStackScreenProps<ProjectScreens, "ProjectList">) {
  const c = useColors();
  const { computers, defaultId } = useFleet();
  const groups = projectGroups(
    projectEntries(
      computers.map(({ machine, view }) => ({ host: { id: machine.id, name: machine.name }, view })),
    ),
    defaultId,
  );
  const loading = computers.some((m) => m.shownConnected && m.view.loading);
  const makers = computers
    .filter((m) => m.shownConnected && "projects" in m.view.capabilities)
    .sort((a, b) => Number(b.machine.id === defaultId) - Number(a.machine.id === defaultId));

  async function make(computer: Computer, name: string) {
    const made = await computer.view.createProject(name);
    if (typeof made === "string") return Alert.alert("Couldn't create the Project", made);
    navigation.navigate("Project", { hostId: computer.machine.id, id: made.id });
  }

  function create() {
    Alert.prompt(
      "New Project",
      undefined,
      (text) => {
        const name = text.trim();
        if (!name) return;
        if (makers.length === 1) return void make(makers[0]!, name);
        ActionSheetIOS.showActionSheetWithOptions(
          {
            title: `Which computer should ${name} be on?`,
            options: [...makers.map((m) => m.machine.name), "Cancel"],
            cancelButtonIndex: makers.length,
          },
          (i) => {
            const computer = makers[i];
            if (computer) void make(computer, name);
          },
        );
      },
      "plain-text",
    );
  }
  const latest = useRef(create);
  latest.current = create;
  const canCreate = makers.length > 0;

  useLayoutEffect(
    () =>
      navigation.setOptions({
        headerRight: canCreate
          ? () => (
              <GlassButton label="New Project" onPress={() => latest.current()}>
                <Icon icon={Plus} size={20} />
              </GlassButton>
            )
          : undefined,
      }),
    [navigation, canCreate],
  );

  return (
    <Page>
      {groups.length > 0 ? (
        <Section>
          {groups.map(({ name, home, computers: holders, threads, activeAt: at }, i) => (
            <Row
              key={name}
              leading={<RepoIcon repo={home.view.state.repos.find((r) => r.id === home.id)} size={28} />}
              title={name}
              detail={[`${threads} thread${threads === 1 ? "" : "s"}`, holders > 1 && `${holders} computers`]
                .filter(Boolean)
                .join(" · ")}
              right={
                <T faint style={styles.small}>
                  {ago(at)}
                </T>
              }
              chevron
              last={i === groups.length - 1}
              onPress={() => navigation.navigate("Project", { hostId: home.host.id, id: home.id })}
            />
          ))}
        </Section>
      ) : loading ? (
        <ActivityIndicator color={c.accent} />
      ) : (
        <T muted style={{ textAlign: "center" }}>
          No Projects yet. A Project groups threads and gives them shared instructions and files.
        </T>
      )}
    </Page>
  );
}

/**
 * A Project's page: New thread, its threads from every computer holding one of its name, newest
 * first, then this copy's instructions and file names, which other computers' copies don't share.
 */
export function ProjectScreen({ route, navigation }: NativeStackScreenProps<ProjectScreens, "Project">) {
  const { hostId, id } = route.params;
  const c = useColors();
  const show = useShow();
  const { computers } = useFleet();
  const computer = useComputer(hostId);
  const project = computer?.view.state.repos.find((r) => r.id === id && r.project);
  const name = project?.name;

  useEffect(() => navigation.setOptions({ title: name ?? "Project" }), [navigation, name]);

  if (!computer || !project)
    return (
      <Page>
        <T muted>This Project isn't loaded.</T>
      </Page>
    );

  const many = computers.filter((m) => holds(m, project.name)).length > 1;
  const on = many ? `On ${computer.machine.name}.` : undefined;
  const threads = computers
    .flatMap((m) => {
      const { state } = m.view;
      const ids = new Set(state.repos.filter((r) => r.project && r.name === project.name).map((r) => r.id));
      return state.threads
        .filter((t) => ids.has(projectOf(state, t) ?? "") && !t.parent && !t.archived)
        .map((thread) => {
          const run = state.runs[thread.id];
          return {
            computer: m,
            thread,
            run,
            title: state.titles[thread.id] ?? "Thread",
            at: activeAt(thread, run, state.stoppedAt[thread.id]),
            attention: attentionOf(thread, run, asksOf(state, thread.id), waitingOf(state, thread.id)),
          };
        });
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const canEdit = "projectContext" in computer.view.capabilities;
  const files = project.files ?? [];

  return (
    <Page>
      <Button
        label="New thread"
        icon={SquarePen}
        primary
        onPress={() => show({ name: "StartThread", params: { hostId, groupId: id } })}
      />
      <Section title="Threads">
        {threads.length === 0 && (
          <T muted style={styles.text}>
            No threads yet. Each thread here follows this Project's instructions and can read its files.
          </T>
        )}
        {threads.map(({ computer: m, thread, run, title, at, attention }, i) => (
          <Row
            key={`${m.machine.id}/${thread.id}`}
            leading={
              <View style={styles.leading}>
                {run ? (
                  <ProviderLogo kind={run.backend} size={17} color={c.mutedForeground} />
                ) : (
                  <DeviceIcon name={m.machine.name} size={17} color={c.mutedForeground} />
                )}
              </View>
            }
            title={title}
            detail={computers.length > 1 ? m.machine.name : undefined}
            right={
              attention === "settled" ? (
                <T faint style={styles.small}>
                  {ago(at)}
                </T>
              ) : (
                <AttentionBadge attention={attention} />
              )
            }
            last={i === threads.length - 1}
            onPress={() => show({ name: "Thread", params: { hostId: m.machine.id, runId: thread.id } })}
          />
        ))}
      </Section>
      {(canEdit || !!project.instructions) && (
        <Section title="Instructions" footer={on && `${on} Other computers keep their own.`}>
          <T
            muted={!!project.instructions}
            faint={!project.instructions}
            numberOfLines={12}
            style={{
              ...styles.text,
              ...(canEdit && { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border }),
            }}
          >
            {project.instructions || "Tell every thread here how to work: who it's for, the tone and format you want, and what it should know."}
          </T>
          {canEdit && (
            <Row
              icon={Pencil}
              title={project.instructions ? "Edit" : "Add"}
              chevron
              last
              onPress={() => navigation.navigate("ProjectInstructions", { hostId, id })}
            />
          )}
        </Section>
      )}
      {files.length > 0 && (
        <Section title="Files" footer={on}>
          {files.map((path, i) => (
            <Row key={path} icon={FileText} title={path.split(/[\\/]/).at(-1) ?? path} last={i === files.length - 1} />
          ))}
        </Section>
      )}
    </Page>
  );
}

/** A Project's instructions in a text editor, saved with the check in its header. */
export function ProjectInstructionsScreen({
  route,
  navigation,
}: NativeStackScreenProps<ProjectScreens, "ProjectInstructions">) {
  const { hostId, id } = route.params;
  const c = useColors();
  const view = useComputer(hostId)?.view;
  const [text, setText] = useState(view?.state.repos.find((r) => r.id === id)?.instructions ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!view || saving) return;
    setSaving(true);
    const failed = await view.updateRepo(id, { instructions: text });
    setSaving(false);
    if (failed) return Alert.alert("Couldn't save the instructions", failed);
    navigation.goBack();
  }
  const latest = useRef(save);
  latest.current = save;

  useLayoutEffect(
    () =>
      navigation.setOptions({
        headerRight: () => (
          <GlassButton label="Save instructions" onPress={() => void latest.current()}>
            {saving ? <ActivityIndicator color={c.foreground} /> : <Icon icon={Check} size={20} />}
          </GlassButton>
        ),
      }),
    [navigation, saving, c],
  );

  return (
    <Page>
      <Section footer="New threads in this Project follow them.">
        <TextInput
          accessibilityLabel="Instructions"
          autoFocus
          multiline
          // The page scrolls, so the keyboard keeps the cursor in view.
          scrollEnabled={false}
          value={text}
          onChangeText={setText}
          placeholder="Answer as a patient tutor. Show the steps, then the result."
          placeholderTextColor={c.faintForeground}
          selectionColor={c.accent}
          style={[styles.editor, { color: c.foreground }]}
        />
      </Section>
    </Page>
  );
}

/** Opens the Projects `thread` can join, with Remove from Project while it's in one. */
function chooseProject(thread: Thread, view: ThreadsView, projects: Repo[], current?: Repo) {
  const options = [...projects.map((p) => p.name), ...(current ? ["Remove from Project"] : []), "Cancel"];
  const move = async (project?: Repo) => {
    if (project?.id === thread.project) return;
    const failed = project
      ? await addToProject(view, [thread], project)
      : await view.setProject([thread.id]);
    if (failed) Alert.alert("Couldn't change the thread's Project", failed);
  };
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title: current ? `Project: ${current.name}` : "Add to Project",
      options,
      cancelButtonIndex: options.length - 1,
      destructiveButtonIndex: current ? projects.length : undefined,
    },
    (i) => {
      if (i !== options.length - 1) void move(projects[i]);
    },
  );
}

/**
 * A thread's Project for its long press and Thread details, by `projectChoices`' rules: the one
 * it's in, its label, and `choose`, which opens the choices. A thread started in a Project lives
 * there, so it has no `choose` and only names it. Undefined where there are no choices.
 */
export function threadProject(thread: Thread, view: ThreadsView, computers: Computer[]) {
  const choices = projectChoices(thread, view, computers);
  if (!choices) return undefined;
  const { projects, startedIn } = choices;
  const current = startedIn ?? projects.find((p) => p.id === thread.project);
  return {
    current,
    label: current ? `Project: ${current.name}` : "Add to Project",
    choose: startedIn ? undefined : () => chooseProject(thread, view, projects, current),
  };
}

const styles = StyleSheet.create({
  small: { fontSize: 13, lineHeight: 18 },
  text: { padding: 16 },
  leading: { width: 18, alignItems: "center" },
  editor: { minHeight: 240, padding: 16, fontSize: 15, lineHeight: 21, textAlignVertical: "top" },
});
