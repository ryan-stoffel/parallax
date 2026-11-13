// Projects (0090, 0097), in a sheet with its own stack: every computer's Projects, one row per name,
// with a plus that creates one; a Project's page, with its threads from every computer holding one
// of its name, New thread, and its instructions and file names; and its instructions in a text
// editor. A thread's long press and Thread details change its Project with `threadProject`.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { t } from "i18next";
import { Check, FileText, FolderMinus, LayoutGrid, Pencil, Plus, SquarePen } from "lucide-react-native";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, TextInput, View } from "react-native";
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
import { showAlert, showMenu, showPrompt } from "./dialogStore";
import { type Computer, useComputer, useFleet } from "./fleet";
import { GlassButton } from "./Glass";
import { ProviderLogo } from "./logos";
import { ago, useShow, type ProjectScreens } from "./nav";
import { projectGroups } from "./projectLogic";
import { RepoIcon } from "./RepoIcon";
import { AttentionBadge, Button, DeviceIcon, Empty, Icon, Row, Section, T, useColors } from "./ui";

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
    if (typeof made === "string") return showAlert(t("Couldn't create the Project"), made);
    navigation.navigate("Project", { hostId: computer.machine.id, id: made.id });
  }

  function create() {
    showPrompt(
      t("New Project"),
      undefined,
      (text) => {
        const name = text.trim();
        if (!name) return;
        if (makers.length === 1) return void make(makers[0]!, name);
        showMenu(
          makers.map((computer) => ({ label: computer.machine.name, onPress: () => void make(computer, name) })),
          t("Which computer should {{name}} be on?", { name }),
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
              <GlassButton label={t("New Project")} onPress={() => latest.current()}>
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
              detail={[
                t("{{count}} threads", { count: threads, defaultValue_one: "{{count}} thread" }),
                holders > 1 && t("{{count}} computers", { count: holders, defaultValue_one: "{{count}} computer" }),
              ]
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
        <Empty
          icon={LayoutGrid}
          title={t("No Projects yet")}
          note={t("A Project groups threads and gives them shared instructions and files.")}
          action={canCreate ? <Button label={t("New Project")} icon={Plus} onPress={create} /> : undefined}
        />
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

  useEffect(() => navigation.setOptions({ title: name ?? t("Project") }), [navigation, name]);

  if (!computer || !project)
    return (
      <Page>
        <T muted>{t("This Project isn't loaded.")}</T>
      </Page>
    );

  const many = computers.filter((m) => holds(m, project.name)).length > 1;
  const on = many ? t("On {{computer}}.", { computer: computer.machine.name }) : undefined;
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
            title: state.titles[thread.id] ?? t("Thread"),
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
        label={t("New thread")}
        icon={SquarePen}
        primary
        onPress={() => show({ name: "StartThread", params: { hostId, groupId: id } })}
      />
      <Section title={t("Threads")}>
        {threads.length === 0 && (
          <T muted style={styles.text}>
            {t("No threads yet. Each thread here follows this Project's instructions and can read its files.")}
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
        <Section
          title={t("Instructions")}
          footer={many ? t("On {{computer}}. Other computers keep their own.", { computer: computer.machine.name }) : undefined}
        >
          <T
            muted={!!project.instructions}
            faint={!project.instructions}
            numberOfLines={12}
            style={{
              ...styles.text,
              ...(canEdit && { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border }),
            }}
          >
            {project.instructions || t("Tell every thread here how to work: who it's for, the tone and format you want, and what it should know.")}
          </T>
          {canEdit && (
            <Row
              icon={Pencil}
              title={project.instructions ? t("Edit") : t("Add")}
              chevron
              last
              onPress={() => navigation.navigate("ProjectInstructions", { hostId, id })}
            />
          )}
        </Section>
      )}
      {files.length > 0 && (
        <Section title={t("Files")} footer={on}>
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
    if (failed) return showAlert(t("Couldn't save the instructions"), failed);
    navigation.goBack();
  }
  const latest = useRef(save);
  latest.current = save;

  useLayoutEffect(
    () =>
      navigation.setOptions({
        headerRight: () => (
          <GlassButton label={t("Save instructions")} onPress={() => void latest.current()}>
            {saving ? <ActivityIndicator color={c.foreground} /> : <Icon icon={Check} size={20} />}
          </GlassButton>
        ),
      }),
    [navigation, saving, c],
  );

  return (
    <Page>
      <Section footer={t("New threads in this Project follow them.")}>
        <TextInput
          accessibilityLabel={t("Instructions")}
          autoFocus
          multiline
          // The page scrolls, so the keyboard keeps the cursor in view.
          scrollEnabled={false}
          value={text}
          onChangeText={setText}
          placeholder={t("Answer as a patient tutor. Show the steps, then the result.")}
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
  const move = async (project?: Repo) => {
    if (project?.id === thread.project) return;
    const failed = project
      ? await addToProject(view, [thread], project)
      : await view.setProject([thread.id]);
    if (failed) showAlert(t("Couldn't change the thread's Project"), failed);
  };
  showMenu(
    [
      ...projects.map((p) => ({ label: p.name, checked: p.id === current?.id, onPress: () => void move(p) })),
      ...(current ? [{ label: t("Remove from Project"), icon: FolderMinus, destructive: true, onPress: () => void move() }] : []),
    ],
    current ? t("Project: {{name}}", { name: current.name }) : t("Add to Project"),
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
    label: current ? t("Project: {{name}}", { name: current.name }) : t("Add to Project"),
    choose: startedIn ? undefined : () => chooseProject(thread, view, projects, current),
  };
}

const styles = StyleSheet.create({
  small: { fontSize: 13, lineHeight: 18 },
  text: { padding: 16 },
  leading: { width: 18, alignItems: "center" },
  editor: { minHeight: 240, padding: 16, fontSize: 15, lineHeight: 21, textAlignVertical: "top" },
});
