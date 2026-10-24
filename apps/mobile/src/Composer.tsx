// The thread's message box, as the desktop's Composer, for a phone: the text, photos and files to
// attach, and the model, reasoning effort, and access for what follows, each a sheet of choices.
// Photos go to the agent as images and are saved on the computer too, and files are saved there
// with `host/upload` and listed after the text (0071), as the desktop sends them.
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as Haptics from "expo-haptics";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import {
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  Plus,
  Square,
  X,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import {
  ActionSheetIOS,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type {
  AgentEffort,
  AgentPermission,
  AgentRun,
  PromptImage,
  ProvidersListResult,
} from "../../desktop/src/protocol/generated/protocol";
import { encodedImage, withFiles } from "../../desktop/src/renderer/attachments";
import {
  accessLevels,
  effortLevels,
  instanceModels,
  models as builtIn,
  type Model,
} from "../../desktop/src/renderer/catalog";
import { imageCaps } from "../../desktop/src/renderer/images";
import { uuidv7 } from "../../desktop/src/renderer/uuidv7";
import type { Computer } from "./fleet";
import { openLightbox } from "./Lightbox";
import { Icon, NightSky, T, useColors } from "./ui";


/** What an instance offers: its models, whether it takes an effort, and its access levels. */
interface Offer {
  models: Model[];
  efforts: boolean;
  permissions: AgentPermission[];
}

/** The models, efforts, and access levels the thread's provider instance offers on `computer`. */
function useOffer(computer: Computer | undefined, backend: string | undefined): Offer {
  const [listed, setListed] = useState<ProvidersListResult>();
  const id = computer?.machine.id;
  const providers = computer?.connected && "providers" in (computer.view.capabilities ?? {});
  useEffect(() => {
    if (!id || !providers) return;
    void window.parallax.request(id, "providers/list", { refresh: false }).then((answer) => {
      if (!("error" in answer)) setListed(answer.result as ProvidersListResult);
    });
  }, [id, providers]);
  const info = listed?.providers.find((p) => p.instance.id === backend);
  if (info)
    return { models: instanceModels(info), efforts: info.efforts, permissions: info.permissions };
  // An older plxd, without `providers`: the built-in catalog of the thread's backend.
  return {
    models: builtIn.filter((m) => m.provider === backend),
    efforts: backend !== "cursor",
    permissions: ["manual", "edit", "auto", "plan", "bypass"],
  };
}

/** A file picked to send: an image (shown, and sent as one), or any other file. */
type Attached =
  | { kind: "image"; key: string; image: PromptImage; uri: string }
  | { kind: "file"; key: string; name: string; uri: string; size: number };

// The longest edge a photo is sent at, as the desktop's `readImage`: Anthropic refuses larger
// ones once a conversation holds more than 20 images.
const MAX_EDGE = 2000;

/** A picked photo as an image plxd takes: at most 2000 px on its long edge, as JPEG. */
async function photo(asset: ImagePicker.ImagePickerAsset): Promise<Attached> {
  const long = Math.max(asset.width, asset.height);
  const context = ImageManipulator.manipulate(asset.uri);
  if (long > MAX_EDGE)
    context.resize(asset.width >= asset.height ? { width: MAX_EDGE } : { height: MAX_EDGE });
  const rendered = await (await context.renderAsync()).saveAsync({
    format: SaveFormat.JPEG,
    compress: 0.85,
    base64: true,
  });
  return {
    kind: "image",
    key: uuidv7(),
    uri: rendered.uri,
    image: { mediaType: "image/jpeg", data: rendered.base64 ?? "" },
  };
}

/**
 * Saves `file` on `hostId` with `host/upload`, in one message or, past `chunk` bytes, in pieces
 * (0074). Resolves to its path there, or rejects with why not.
 */
async function upload(hostId: string, name: string, data: string, chunk?: number): Promise<string> {
  // Pieces of whole 3-byte groups, so each piece's base64 is a slice of the whole's.
  const piece = chunk ? Math.floor(Math.min(chunk, 786_432) / 3) * 4 : data.length;
  let uploadId: string | undefined;
  for (let at = 0; ; at += piece) {
    const last = at + piece >= data.length;
    const answer = await window.parallax.request(hostId, "host/upload", {
      name,
      data: data.slice(at, at + piece),
      ...(chunk && { uploadId, offset: (at / 4) * 3, last }),
    });
    if ("error" in answer) throw new Error(`${name} couldn't be sent: ${answer.error.message}`);
    const result = answer.result as { path: string; uploadId?: string };
    if (last) return result.path;
    uploadId = result.uploadId;
  }
}

/** A model's name without its maker's, as the pill says it: "Claude Opus 5.5" is "Opus 5.5". */
const shortName = (name: string) => name.replace(/^(Claude|OpenAI|Cursor) /, "");

/** What a model offers, in a line: its context windows and fast mode. */
function modelLine(m: Model): string | undefined {
  const parts = [
    m.contexts[0] && `${m.contexts[0] >= 1_000_000 ? `${m.contexts[0] / 1_000_000}M` : `${m.contexts[0] / 1000}K`} context`,
    m.fast && "fast mode",
    m.isNew && "new",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

type Page = "model" | "all" | "effort" | "access";

/**
 * The model sheet, as Claude's app has it: the provider's models in a card, then Effort and
 * Access rows that open their own choices, a close button and title on top.
 */
function ModelSheet({
  open,
  page,
  onPage,
  onClose,
  models,
  model,
  onModel,
  efforts,
  effort,
  onEffort,
  permissions,
  permission,
  onPermission,
}: {
  open: boolean;
  page: Page;
  onPage: (page: Page) => void;
  onClose: () => void;
  models: Model[];
  model: string;
  onModel: (id: string) => void;
  efforts: boolean;
  effort?: AgentEffort;
  onEffort: (effort: AgentEffort) => void;
  permissions: AgentPermission[];
  permission?: AgentPermission;
  onPermission: (permission: AgentPermission) => void;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const choose = (then: () => void) => {
    void Haptics.selectionAsync();
    then();
  };
  const card = [styles.card, { backgroundColor: c.surface }];
  const option = (key: string, label: string, line: string | undefined, chosen: boolean, onPress: () => void, last: boolean) => (
    <Pressable
      key={key}
      accessibilityRole="radio"
      accessibilityState={{ selected: chosen }}
      onPress={() => choose(onPress)}
      style={({ pressed }) => [styles.option, pressed && { backgroundColor: c.hover }]}
    >
      <View style={[styles.optionBody, !last && { borderBottomColor: c.border, borderBottomWidth: StyleSheet.hairlineWidth }]}>
        <View style={{ flex: 1, gap: 2 }}>
          <T style={{ fontSize: 17 }}>{label}</T>
          {!!line && (
            <T muted style={{ fontSize: 14, lineHeight: 19 }}>
              {line}
            </T>
          )}
        </View>
        {chosen && <Icon icon={Check} size={20} color={c.accent} />}
      </View>
    </Pressable>
  );
  const link = (label: string, value: string, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [...card, styles.link, pressed && { backgroundColor: c.hover }]}
    >
      <T style={{ fontSize: 17, flex: 1 }}>{label}</T>
      <T muted style={{ fontSize: 16 }}>
        {value}
      </T>
      <Icon icon={ChevronRight} size={17} color={c.faintForeground} />
    </Pressable>
  );
  const title = { model: "Select model", all: "More models", effort: "Effort", access: "Access" }[page];
  // The first four, as Claude's sheet lists them, and the chosen one if it's further down.
  const first = models.filter((m, i) => i < 4 || m.id === model);
  const list = (shown: Model[]) => (
    <View style={card}>
      {shown.map((m, i) =>
        option(m.id || "default", shortName(m.name), modelLine(m), m.id === model, () => {
          onModel(m.id);
          onClose();
        }, i === shown.length - 1),
      )}
    </View>
  );
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, { backgroundColor: c.sidebar, paddingBottom: insets.bottom + 12 }]}>
        <View style={[styles.grabber, { backgroundColor: c.border }]} />
        <View style={styles.sheetHead}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={page === "model" ? "Close" : "Back"}
            onPress={() => (page === "model" ? onClose() : onPage("model"))}
            style={[styles.close, { backgroundColor: c.surface, borderColor: c.border }]}
          >
            <Icon icon={page === "model" ? X : ChevronLeft} size={20} color={c.foreground} />
          </Pressable>
          <T style={{ fontSize: 17, fontWeight: "600" }}>{title}</T>
          <View style={{ width: 40 }} />
        </View>
        <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ gap: 14, paddingHorizontal: 16 }}>
          {page === "model" && (
            <>
              {list(first)}
              {efforts &&
                effort &&
                link("Effort", effortLevels.find((l) => l.value === effort)?.name ?? effort, () => onPage("effort"))}
              {permission && link("Access", accessLevels[permission].label, () => onPage("access"))}
              {models.length > first.length && link("More models", "", () => onPage("all"))}
            </>
          )}
          {page === "all" && list(models)}
          {page === "effort" && (
            <View style={card}>
              {effortLevels.map((l, i) =>
                option(l.value, l.name, l.blurb, l.value === effort, () => {
                  onEffort(l.value);
                  onPage("model");
                }, i === effortLevels.length - 1),
              )}
            </View>
          )}
          {page === "access" && (
            <View style={card}>
              {permissions.map((p, i) =>
                option(p, accessLevels[p].label, accessLevels[p].description, p === permission, () => {
                  onPermission(p);
                  onPage("model");
                }, i === permissions.length - 1),
              )}
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

export function Composer({
  computer,
  runId,
  run,
  working,
  draft,
  onDraft,
  onStop,
  bottom,
}: {
  computer: Computer | undefined;
  runId: string;
  run: AgentRun | undefined;
  working: boolean;
  draft: string;
  onDraft: (text: string) => void;
  onStop: () => void;
  bottom: number;
}) {
  const c = useColors();
  const offer = useOffer(computer, run?.backend);
  const [model, setModel] = useState<string>();
  const [effort, setEffort] = useState<AgentEffort>();
  const [permission, setPermission] = useState<AgentPermission>();
  const [attached, setAttached] = useState<Attached[]>([]);
  const [sheet, setSheet] = useState<Page>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const connected = !!computer?.connected;
  const capabilities = computer?.view.capabilities ?? {};
  const caps = imageCaps(computer?.state);
  // A new model, effort, or access goes with a message only to a plxd that takes it.
  const changes = "sendModel" in capabilities;

  const shownModel = model ?? run?.model ?? "";
  const modelName =
    offer.models.find((m) => m.id === shownModel)?.name ?? (shownModel || "Default model");
  const shownEffort = effort ?? run?.effort;
  const shownAccess = permission ?? run?.permission;
  const text = draft;
  const ready = !!(text.trim() || attached.length) && !!computer && !sending;

  async function pickPhotos(camera: boolean) {
    const options: ImagePicker.ImagePickerOptions = {
      mediaTypes: ["images"],
      quality: 1,
      allowsMultipleSelection: !camera,
      selectionLimit: caps?.maxImages ?? 10,
    };
    const picked = camera
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
    if (picked.canceled) return;
    const photos = await Promise.all(picked.assets.map(photo));
    setAttached((a) => [...a, ...photos]);
  }

  async function pickFiles() {
    const picked = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (picked.canceled) return;
    setAttached((a) => [
      ...a,
      ...picked.assets.map(
        (f): Attached => ({ kind: "file", key: uuidv7(), name: f.name, uri: f.uri, size: f.size ?? 0 }),
      ),
    ]);
  }

  function attach() {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ["Photo library", "Take photo", "Files", "Cancel"], cancelButtonIndex: 3 },
      (i) => {
        if (i === 0) void pickPhotos(false);
        if (i === 1) void pickPhotos(true);
        if (i === 2) void pickFiles();
      },
    );
  }

  async function send(steer: boolean) {
    if (!ready || !computer) return;
    setSending(true);
    setError(undefined);
    try {
      const hostId = computer.machine.id;
      const images = attached.flatMap((a) => (a.kind === "image" ? [a.image] : []));
      const files = attached.filter((a) => a.kind === "file");
      let paths: string[] = [];
      if ("fileUploads" in capabilities && attached.length) {
        if (!connected) throw new Error(`${computer.machine.name} isn't connected, so files can't be sent yet.`);
        const chunk = capabilities["fileChunks"]?.["chunkBytes"] as number | undefined;
        paths = [];
        for (const [n, image] of images.entries()) {
          const { name, data } = encodedImage(image, n + 1);
          paths.push(await upload(hostId, name, data, chunk));
        }
        for (const f of files)
          paths.push(await upload(hostId, f.name, await new File(f.uri).base64(), chunk));
      } else if (files.length) throw new Error(`${computer.machine.name}'s Parallax can't take files.`);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      computer.outbox.add({
        id: uuidv7(),
        threadId: runId,
        text: withFiles(text.trim(), paths),
        steer,
        ...(images.length && { images }),
        ...(changes && model !== undefined && { model }),
        ...(changes && effort && { effort }),
        ...(changes && permission && { permission }),
      });
      onDraft("");
      setAttached([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <View style={{ paddingHorizontal: 10, paddingBottom: bottom, paddingTop: 6 }}>
      {error && (
        <T alert style={{ color: c.danger, fontSize: 13, paddingHorizontal: 8, paddingBottom: 6 }}>
          {error}
        </T>
      )}
      <View style={[styles.box, { borderColor: c.border, backgroundColor: c.surface }]}>
        {attached.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
            {attached.map((a) => (
              <View key={a.key}>
                {a.kind === "image" ? (
                  <Pressable
                    onPress={() =>
                      openLightbox(
                        attached.flatMap((x) => (x.kind === "image" ? [{ uri: x.uri }] : [])),
                        attached.filter((x) => x.kind === "image").indexOf(a),
                      )
                    }
                  >
                    <Image source={{ uri: a.uri }} style={[styles.thumb, { borderColor: c.border }]} />
                  </Pressable>
                ) : (
                  <View style={[styles.fileChip, { borderColor: c.border, backgroundColor: c.code }]}>
                    <Icon icon={FileText} size={14} color={c.mutedForeground} />
                    <T numberOfLines={1} style={{ fontSize: 12, maxWidth: 120 }}>
                      {a.name}
                    </T>
                  </View>
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Remove"
                  hitSlop={8}
                  onPress={() => setAttached((x) => x.filter((y) => y.key !== a.key))}
                  style={[styles.remove, { backgroundColor: c.foreground }]}
                >
                  <Icon icon={X} size={10} color={c.background} strokeWidth={3} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}
        <TextInput
          accessibilityLabel="Message"
          multiline
          value={text}
          onChangeText={onDraft}
          placeholder={working ? "Steer, or queue a follow-up" : "Reply"}
          placeholderTextColor={c.faintForeground}
          style={[styles.input, { color: c.foreground }]}
        />
        <View style={styles.bar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach"
            hitSlop={8}
            onPress={attach}
            style={({ pressed }) => [styles.round, { backgroundColor: pressed ? c.hover : c.selected }]}
          >
            <Icon icon={Plus} size={18} color={c.foreground} />
          </Pressable>
          {changes && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Model: ${modelName}`}
              onPress={() => setSheet("model")}
              style={({ pressed }) => [styles.pill, { backgroundColor: pressed ? c.hover : c.selected }]}
            >
              <Text numberOfLines={1} style={[styles.pillText, { color: c.foreground }]}>
                {shortName(modelName)}
                {offer.efforts && shownEffort && (
                  <Text style={{ color: c.mutedForeground }}>
                    {" "}
                    {effortLevels.find((l) => l.value === shownEffort)?.name ?? shownEffort}
                  </Text>
                )}
              </Text>
            </Pressable>
          )}
          <View style={{ flex: 1 }} />
          {working && !ready && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop"
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                onStop();
              }}
              style={[styles.send, { backgroundColor: c.foreground }]}
            >
              <Icon icon={Square} size={12} color={c.background} strokeWidth={3} />
            </Pressable>
          )}
          {working && ready && (
            <Pressable
              accessibilityRole="button"
              onPress={() => void send(true)}
              style={[styles.steer, { borderColor: c.border }]}
            >
              <T medium style={{ fontSize: 13 }}>
                Steer
              </T>
            </Pressable>
          )}
          {(!working || ready) && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={working ? "Queue" : "Send"}
              disabled={!ready}
              onPress={() => void send(false)}
              style={[styles.send, { opacity: ready ? 1 : 0.4, overflow: "hidden" }]}
            >
              <NightSky width={34} height={34} />
              <Icon icon={ArrowUp} size={17} color="#ffffff" strokeWidth={2.5} />
            </Pressable>
          )}
        </View>
      </View>
      <ModelSheet
        open={!!sheet}
        page={sheet ?? "model"}
        onPage={setSheet}
        onClose={() => setSheet(undefined)}
        models={offer.models}
        model={shownModel}
        onModel={setModel}
        efforts={offer.efforts}
        effort={shownEffort}
        onEffort={setEffort}
        permissions={offer.permissions}
        permission={shownAccess}
        onPermission={setPermission}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 26, paddingTop: 6, paddingBottom: 10 },
  strip: { gap: 8, paddingHorizontal: 12, paddingTop: 8 },
  thumb: { width: 56, height: 56, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  fileChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 56,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
  },
  remove: {
    position: "absolute",
    top: -5,
    right: -5,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  input: { fontSize: 17, minHeight: 44, maxHeight: 160, paddingHorizontal: 16, paddingTop: 10 },
  bar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingTop: 6 },
  scrim: { flex: 1, backgroundColor: "rgba(0, 0, 0, 0.3)" },
  sheet: { borderTopLeftRadius: 30, borderTopRightRadius: 30, paddingTop: 8 },
  grabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, marginBottom: 8 },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  close: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  card: { borderRadius: 20, overflow: "hidden" },
  option: { paddingLeft: 18 },
  optionBody: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, paddingRight: 18 },
  link: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 18, paddingVertical: 16 },
  round: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  pill: { height: 38, borderRadius: 19, paddingHorizontal: 16, justifyContent: "center", maxWidth: 230 },
  pillText: { fontSize: 15 },
  steer: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  send: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
});

