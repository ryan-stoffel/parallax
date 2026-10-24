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
import { useState } from "react";
import {
  ActionSheetIOS,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type {
  AgentEffort,
  AgentPermission,
  AgentRun,
  PromptImage,
} from "../../desktop/src/protocol/generated/protocol";
import { encodedImage, withFiles } from "../../desktop/src/renderer/attachments";
import {
  accessLevels,
  effortLevels,
  type Model,
} from "../../desktop/src/renderer/catalog";
import { imageCaps } from "../../desktop/src/renderer/images";
import { uuidv7 } from "../../desktop/src/renderer/uuidv7";
import type { Computer } from "./fleet";
import { openLightbox } from "./Lightbox";
import { ProviderLogo } from "./logos";
import { allAccess, useOffers, type Offer } from "./offers";
import { Icon, NightOrb, T, useColors } from "./ui";


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
  // Pieces of whole 3-byte groups, so each piece's base64 is a slice of the whole's, and at most the
  // desktop's 256 KiB `pieceBytes`, so a piece sends within the heartbeat's 10 s on a slow link.
  const piece = chunk ? Math.floor(Math.min(chunk, 262_144) / 3) * 4 : data.length;
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

type Page = "model" | "all" | "provider" | "effort" | "access";

/**
 * The model sheet, as Claude's app has it: the provider's models in a card, then Effort and
 * Access rows that open their own choices, a close button and title on top.
 */
function ModelSheet({
  open,
  page,
  onPage,
  onClose,
  offers,
  provider,
  onProvider,
  canMove,
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
  offers: Offer[];
  provider: string;
  onProvider: (id: string) => void;
  canMove: (id: string) => boolean;
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
  const { height } = useWindowDimensions();
  const choose = (then: () => void) => {
    void Haptics.selectionAsync();
    then();
  };
  const card = [styles.card, { backgroundColor: c.surface }];
  const option = (
    key: string,
    label: string,
    line: string | undefined,
    chosen: boolean,
    onPress: () => void,
    last: boolean,
    leading?: React.ReactNode,
  ) => (
    <Pressable
      key={key}
      accessibilityRole="radio"
      accessibilityState={{ selected: chosen }}
      onPress={() => choose(onPress)}
      style={({ pressed }) => [styles.option, pressed && { backgroundColor: c.hover }]}
    >
      {leading && <View style={styles.leading}>{leading}</View>}
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
  const link = (label: string, value: string, onPress: () => void, leading?: React.ReactNode) => (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [...card, styles.link, pressed && { backgroundColor: c.hover }]}
    >
      {leading}
      <T style={{ fontSize: 17, flex: 1 }}>{label}</T>
      <T muted style={{ fontSize: 16 }}>
        {value}
      </T>
      <Icon icon={ChevronRight} size={17} color={c.faintForeground} />
    </Pressable>
  );
  const title = {
    model: "Select model",
    all: "More models",
    provider: "Provider",
    effort: "Effort",
    access: "Access",
  }[page];
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
      <View
        style={[
          styles.sheet,
          { backgroundColor: c.sidebar, marginBottom: Math.max(insets.bottom - 26, 8), paddingBottom: 16 },
        ]}
      >
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
        <ScrollView
          style={{ maxHeight: height * 0.78 }}
          contentContainerStyle={{ gap: 12, paddingHorizontal: 16 }}
        >
          {page === "model" && (
            <>
              {offers.length > 1 &&
                link(
                  "Provider",
                  offers.find((o) => o.id === provider)?.name ?? provider,
                  () => onPage("provider"),
                  <ProviderLogo kind={offers.find((o) => o.id === provider)?.kind} size={20} />,
                )}
              {list(first)}
              {efforts &&
                effort &&
                link("Effort", effortLevels.find((l) => l.value === effort)?.name ?? effort, () => onPage("effort"))}
              {permission && link("Access", accessLevels[permission].label, () => onPage("access"))}
              {models.length > first.length && link("More models", "", () => onPage("all"))}
            </>
          )}
          {page === "all" && list(models)}
          {page === "provider" && (
            <View style={card}>
              {offers.map((o, i) => {
                const can = canMove(o.id);
                return (
                  <View key={o.id} style={!can && { opacity: 0.45 }} pointerEvents={can ? "auto" : "none"}>
                    {option(
                      o.id,
                      o.name,
                      can
                        ? `${o.models.length} model${o.models.length === 1 ? "" : "s"}`
                        : "Start a new thread to switch to it here.",
                      o.id === provider,
                      () => {
                        onProvider(o.id);
                        onPage("model");
                      },
                      i === offers.length - 1,
                      <ProviderLogo kind={o.kind} size={24} />,
                    )}
                  </View>
                );
              })}
            </View>
          )}
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
  const offers = useOffers(computer);
  const [provider, setProvider] = useState<string>();
  const shownProvider = provider ?? run?.backend;
  const fallback: Offer = { id: "", name: "", kind: "", models: [], efforts: true, permissions: allAccess };
  const offer = offers.find((o) => o.id === shownProvider) ?? offers[0] ?? fallback;
  // Another provider takes a message only on a plxd that moves runs (`sendAccount`), as on the desktop.
  const moves = "sendAccount" in (computer?.view.capabilities ?? {});
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
        ...(moves && provider && provider !== run?.backend && {
          account: { kind: "subscription" as const, backend: provider },
        }),
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
              style={({ pressed }) => [styles.send, pressed && { opacity: 0.8 }]}
            >
              <NightOrb size={38} />
              <Icon icon={ArrowUp} size={18} color={ready ? "#ffffff" : "rgba(255, 255, 255, 0.45)"} strokeWidth={2.5} />
            </Pressable>
          )}
        </View>
      </View>
      <ModelSheet
        open={!!sheet}
        page={sheet ?? "model"}
        onPage={setSheet}
        onClose={() => setSheet(undefined)}
        offers={offers}
        provider={offer.id}
        onProvider={(id) => {
          setProvider(id);
          // A new provider's own first model, as its default.
          setModel(offers.find((o) => o.id === id)?.models[0]?.id ?? "");
        }}
        canMove={(id) => id === run?.backend || moves}
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
  box: {
    borderWidth: 1,
    borderRadius: 26,
    paddingTop: 6,
    paddingBottom: 10,
    shadowColor: "#1e1b4b",
    shadowOpacity: 0.1,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
  },
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
  // Taps outside close the sheet; the screen behind stays as it is, not dimmed.
  scrim: { flex: 1 },
  // Floating, rounded on every corner, as iOS 26's sheets and Claude's are.
  sheet: {
    marginHorizontal: 8,
    borderRadius: 38,
    paddingTop: 8,
    shadowColor: "#000000",
    shadowOpacity: 0.18,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 8 },
  },
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
  option: { flexDirection: "row", alignItems: "center", paddingLeft: 18 },
  leading: { width: 32, height: 32, borderRadius: 9, alignItems: "center", justifyContent: "center", marginRight: 12 },
  optionBody: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, paddingRight: 18 },
  link: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 18, paddingVertical: 16 },
  round: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  pill: { height: 38, borderRadius: 19, paddingHorizontal: 16, justifyContent: "center", maxWidth: 230 },
  pillText: { fontSize: 15 },
  steer: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  send: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
});

