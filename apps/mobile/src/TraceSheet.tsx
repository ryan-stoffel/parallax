// A turn's steps as Claude's app shows them, in a sheet: a glass close button over a line that sums
// them up (the desktop's `summarize`), then a timeline of what the agent did, each step's icon in a
// column joined by a thin line, with the images it read and a chevron. A step's chevron pushes its
// detail in the same sheet, under a glass back chevron: a command and its output in mono, a file
// read, an edit's diff, a search's results, a thought, or a message.
import * as Haptics from "expo-haptics";
import { ChevronLeft, ChevronRight, FoldVertical, Hand, X } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { SlideInLeft, SlideInRight } from "react-native-reanimated";

import { loadImage } from "../../desktop/src/renderer/images";
import { inputText, stepLabel, toolKind } from "../../desktop/src/renderer/steps";
import { field, type Item } from "../../desktop/src/renderer/transcript";
import { DiffView } from "./Diff";
import { editRows } from "./diffLogic";
import { GlassButton } from "./Glass";
import { openLightbox } from "./Lightbox";
import { Sheet } from "./Sheet";
import { font } from "./theme";
import { Dot, Icon, KindIcon, Markdown, T, useColors, WorkingMark } from "./ui";

type Tool = Extract<Item, { kind: "tool" }>;

/** Where a thread's steps ran, for their images and paths. */
interface TraceScope {
  hostId: string;
  runId: string;
  root?: string;
}

/** One of a run's images (`agent/image`), as a thumbnail that opens the lightbox with its set. */
export function RunImage({ scope, id, ids, size = 120 }: { scope: TraceScope; id: string; ids: string[]; size?: number }) {
  const c = useColors();
  const { hostId, runId } = scope;
  const [uri, setUri] = useState<string>();
  useEffect(() => void loadImage(hostId, runId, id).then(setUri), [hostId, runId, id]);
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel="Image"
      onPress={() =>
        void Promise.all(ids.map((i) => loadImage(hostId, runId, i))).then((uris) =>
          openLightbox(
            uris.flatMap((u) => (u ? [{ uri: u }] : [])),
            Math.max(0, ids.indexOf(id)),
          ),
        )
      }
    >
      <Image
        source={uri ? { uri } : undefined}
        style={{ width: size, height: size, borderRadius: size > 80 ? 10 : 8, backgroundColor: c.code }}
        resizeMode="cover"
      />
    </Pressable>
  );
}

/** How a call went: running, failed or denied, with no result, or fine. */
const looks: Record<string, { tone?: "running" | "error" | "pending"; said?: string }> = {
  running: { tone: "running" },
  ok: {},
  error: { tone: "error", said: "Failed" },
  denied: { tone: "error", said: "Denied" },
  none: { tone: "pending", said: "No result" },
};

/** A call's look: running while the turn goes and its result hasn't come, as the desktop's. */
export function toolLook(item: Tool, live: boolean) {
  // A status newer than this app reads as no result.
  return looks[item.status ?? (live ? "running" : "none")] ?? looks["none"]!;
}

/** Whether a step has a detail to push. */
export function opens(item: Item): boolean {
  if (item.kind === "tool") return item.input !== undefined || item.output !== undefined || !!item.images?.length;
  return item.kind === "reasoning" || item.kind === "todo" || item.kind === "assistant";
}

/** A step's title, as its line and its detail's header say it. */
export function titleOf(item: Item, root: string | undefined, live: boolean): string {
  switch (item.kind) {
    case "tool":
      return stepLabel(item, root, toolLook(item, live).tone === "running");
    case "reasoning":
      return "Thought";
    case "todo":
      return "Updated the plan";
    case "assistant":
      return "Message";
    case "approval":
      return `${item.resolved ? (item.resolved.decision === "allowed" ? "Allowed" : item.resolved.decision === "denied" ? "Denied" : "Ended") : "Waiting for you:"} ${item.request.toolName}`;
    case "compaction":
      return item.done ? "Compacted the conversation" : "Compacting…";
    case "notice":
      return item.text;
    default:
      return "";
  }
}

/** What a fold or a run of steps holds that the timeline shows (`groupWork` folds no others). */
const timelineKinds = ["tool", "reasoning", "todo", "assistant", "approval", "compaction", "notice"];

/** Markdown's marks taken out, for a message's few lines in the timeline. */
// ponytail: strips marks by pattern, not a parse; the detail renders the Markdown itself.
const plain = (text: string) => text.replace(/[*_`#>]+/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();

/** A labeled block of a call's input or output in mono, as the desktop's `Block`. */
function Block({ label, text }: { label: string; text: string }) {
  const c = useColors();
  return (
    <View style={{ gap: 6 }}>
      <T faint style={{ fontSize: 12.5 }}>
        {label}
      </T>
      <View style={[styles.block, { backgroundColor: c.code, borderColor: c.border }]}>
        <T selectable style={{ fontFamily: font.mono, fontSize: 12, lineHeight: 18 }} numberOfLines={400}>
          {text}
        </T>
      </View>
    </View>
  );
}

/** A step's detail: a call's command or input, diff, images, and output, or a thought, plan, or message. */
function Detail({ item, scope }: { item: Item; scope: TraceScope }) {
  switch (item.kind) {
    case "tool": {
      const diff = editRows(item.name, item.input);
      const command = item.name === "Bash" ? field(item.input, "command") : undefined;
      return (
        <View style={{ gap: 16 }}>
          {diff ? (
            <DiffView rows={diff} />
          ) : command ? (
            <Block label="Command" text={command} />
          ) : (
            item.input !== undefined && <Block label="Input" text={inputText(item.input)} />
          )}
          {!!item.images?.length && (
            <View style={styles.images}>
              {item.images.map((id) => (
                <RunImage key={id} scope={scope} id={id} ids={item.images!} />
              ))}
            </View>
          )}
          {item.output !== undefined && <Block label="Output" text={item.output} />}
        </View>
      );
    }
    case "reasoning":
      return (
        <T selectable muted style={{ fontSize: 15, lineHeight: 22 }}>
          {item.text.trim()}
        </T>
      );
    case "todo":
      return (
        <View style={{ gap: 8 }}>
          {item.items.map((todo, i) => (
            <T
              key={i}
              muted={todo.status === "completed"}
              style={{ fontSize: 15, textDecorationLine: todo.status === "completed" ? "line-through" : "none" }}
            >
              {todo.status === "completed" ? "✓" : todo.status === "inProgress" ? "›" : "○"} {todo.text}
            </T>
          ))}
        </View>
      );
    case "assistant":
      return <Markdown text={item.text} />;
    default:
      return <T muted>{titleOf(item, scope.root, false)}</T>;
  }
}

/** A step's icon in the timeline's column. */
function StepIcon({ item, live }: { item: Item; live: boolean }) {
  const c = useColors();
  switch (item.kind) {
    case "tool": {
      const look = toolLook(item, live);
      if (look.tone === "running") return <WorkingMark size={15} />;
      return <KindIcon kind={toolKind(item.name)} color={look.tone === "error" ? c.danger : c.mutedForeground} />;
    }
    case "reasoning":
      return <KindIcon kind="thinking" color={c.mutedForeground} />;
    case "todo":
      return <KindIcon kind="planning" color={c.mutedForeground} />;
    case "approval":
      return <Icon icon={Hand} size={15} color={c.mutedForeground} />;
    case "compaction":
      return <Icon icon={FoldVertical} size={15} color={c.mutedForeground} />;
    default:
      return <Dot color={c.faintForeground} size={6} />;
  }
}

/** One step in the timeline: its icon on the line, its title, how it went, its images, and a chevron. */
function Step({
  item,
  last,
  live,
  scope,
  onOpen,
}: {
  item: Item;
  last: boolean;
  live: boolean;
  scope: TraceScope;
  onOpen?: () => void;
}) {
  const c = useColors();
  const look = item.kind === "tool" ? toolLook(item, live) : undefined;
  const text = item.kind === "assistant";
  return (
    <Pressable
      accessibilityRole={onOpen ? "button" : undefined}
      disabled={!onOpen}
      onPress={onOpen}
      style={({ pressed }) => [styles.step, pressed && { opacity: 0.6 }]}
    >
      <View style={styles.rail}>
        <View style={styles.icon}>
          <StepIcon item={item} live={live} />
        </View>
        {!last && <View style={[styles.wire, { backgroundColor: c.border }]} />}
      </View>
      <View style={[styles.body, last && { paddingBottom: 4 }]}>
        <T
          numberOfLines={text ? 4 : 2}
          style={{
            fontSize: 15,
            lineHeight: 21,
            color: look?.tone === "error" ? c.danger : c.foreground,
            opacity: look?.tone === "pending" ? 0.6 : 1,
          }}
        >
          {item.kind === "assistant" ? plain(item.text) : titleOf(item, scope.root, live)}
        </T>
        {!!look?.said && (
          <T faint style={{ fontSize: 13, color: look.tone === "error" ? c.danger : c.faintForeground }}>
            {look.said}
          </T>
        )}
        {item.kind === "tool" && !!item.images?.length && (
          <View style={[styles.images, { marginTop: 4 }]}>
            {item.images.slice(0, 4).map((id) => (
              <RunImage key={id} scope={scope} id={id} ids={item.images!} size={64} />
            ))}
          </View>
        )}
      </View>
      {onOpen && (
        <View style={styles.icon}>
          <Icon icon={ChevronRight} size={16} color={c.faintForeground} />
        </View>
      )}
    </Pressable>
  );
}

/**
 * The trace sheet, up while `open`: `items` as a timeline under `title`, or, with `start`, that
 * step's detail first. A lone step's detail has no timeline to go back to. Key it by what it
 * opens, so each opening starts fresh.
 */
export function TraceSheet({
  open,
  onClose,
  title,
  items,
  start,
  live,
  scope,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  items: readonly Item[];
  start?: string;
  /** Whether the turn is still going, so a call with no result yet is running. */
  live: boolean;
  scope: TraceScope;
}) {
  const c = useColors();
  const { height } = useWindowDimensions();
  // Each opening is a new sheet (Thread.tsx keys it), so it starts at `start`.
  const [step, setStep] = useState(start);
  // How the page came in, once one is pushed or popped: a push slides from the right, a back from the left.
  const [way, setWay] = useState<"push" | "back">();
  const shown = useMemo(() => items.filter((i) => timelineKinds.includes(i.kind)), [items]);
  const detail = step === undefined ? undefined : shown.find((i) => i.key === step);
  const canBack = !!detail && shown.length > 1;
  const go = (key?: string) => {
    void Haptics.selectionAsync();
    setWay(key === undefined ? "back" : "push");
    setStep(key);
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      head={
        <View style={styles.head}>
          {canBack ? (
            <GlassButton label="Back" size={40} onPress={() => go(undefined)}>
              <Icon icon={ChevronLeft} size={22} color={c.foreground} />
            </GlassButton>
          ) : (
            <GlassButton label="Close" size={40} onPress={onClose}>
              <Icon icon={X} size={20} color={c.foreground} />
            </GlassButton>
          )}
          <T numberOfLines={1} accessibilityRole="header" style={styles.title}>
            {detail ? titleOf(detail, scope.root, live) : title}
          </T>
          <View style={{ width: 40 }} />
        </View>
      }
    >
      {/* One height for both pages, so a push doesn't jump the sheet. */}
      <View style={{ height: height * 0.68, overflow: "hidden" }}>
        <Animated.View
          key={detail?.key ?? "timeline"}
          entering={way === "push" ? SlideInRight.duration(240) : way === "back" ? SlideInLeft.duration(240) : undefined}
          style={{ flex: 1 }}
        >
          <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
            {detail ? (
              <Detail item={detail} scope={scope} />
            ) : (
              shown.map((item, i) => (
                <Step
                  key={item.key}
                  item={item}
                  last={i === shown.length - 1}
                  live={live}
                  scope={scope}
                  onOpen={opens(item) ? () => go(item.key) : undefined}
                />
              ))
            )}
          </ScrollView>
        </Animated.View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 12 },
  title: { flex: 1, textAlign: "center", fontSize: 17, fontWeight: "600" },
  scroll: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24 },
  step: { flexDirection: "row", gap: 12 },
  // The icon column, and the line from each icon down to the next.
  rail: { width: 22, alignItems: "center" },
  icon: { height: 22, justifyContent: "center", alignItems: "center" },
  wire: { flex: 1, width: StyleSheet.hairlineWidth * 2, marginVertical: 4, borderRadius: 1 },
  body: { flex: 1, gap: 2, paddingBottom: 20 },
  block: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  images: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
