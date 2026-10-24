// The thread's message box, as the desktop's Composer, for a phone: the text, photos and files to
// attach, and the model, reasoning effort, and access for what follows, each a sheet of choices.
// Photos go to the agent as images and are saved on the computer too, and files are saved there
// with `host/upload` and listed after the text (0071), as the desktop sends them.
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as Haptics from "expo-haptics";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import type { LucideIcon } from "lucide-react-native";
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  FilePen,
  FileText,
  Hand,
  ListChecks,
  LockOpen,
  Plus,
  Sparkles,
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
import { Choices } from "./Choices";
import { Icon, NightSky, T, useColors } from "./ui";

const accessIcons: Record<AgentPermission, LucideIcon> = {
  manual: Hand,
  edit: FilePen,
  auto: Sparkles,
  plan: ListChecks,
  bypass: LockOpen,
};

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

/** A pill in the box's bottom row: an icon, a label, and a chevron, opening a sheet. */
function Pill({ icon, label, onPress }: { icon?: LucideIcon; label: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.pill, pressed && { backgroundColor: c.selected }]}
    >
      {icon && <Icon icon={icon} size={14} color={c.mutedForeground} />}
      <Text numberOfLines={1} style={[styles.pillText, { color: c.mutedForeground }]}>
        {label}
      </Text>
      <Icon icon={ChevronDown} size={13} color={c.faintForeground} />
    </Pressable>
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
  const [sheet, setSheet] = useState<"model" | "effort" | "access">();
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
          placeholder={working ? "Steer, or queue a follow-up" : "Ask for follow-up changes"}
          placeholderTextColor={c.faintForeground}
          style={[styles.input, { color: c.foreground }]}
        />
        <View style={styles.bar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach"
            hitSlop={8}
            onPress={attach}
            style={[styles.round, { borderColor: c.border }]}
          >
            <Icon icon={Plus} size={17} color={c.mutedForeground} />
          </Pressable>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: "center", gap: 2 }}>
            {changes && <Pill label={modelName} onPress={() => setSheet("model")} />}
            {changes && offer.efforts && shownEffort && (
              <Pill
                icon={Brain}
                label={effortLevels.find((l) => l.value === shownEffort)?.name ?? shownEffort}
                onPress={() => setSheet("effort")}
              />
            )}
            {changes && shownAccess && (
              <Pill
                icon={accessIcons[shownAccess]}
                label={accessLevels[shownAccess].label}
                onPress={() => setSheet("access")}
              />
            )}
          </ScrollView>
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
      <Choices
        title="Model"
        open={sheet === "model"}
        value={shownModel}
        options={offer.models.map((m) => ({ value: m.id, label: m.name }))}
        onChoose={setModel}
        onClose={() => setSheet(undefined)}
      />
      <Choices
        title="Reasoning"
        open={sheet === "effort"}
        value={shownEffort}
        options={effortLevels.map((l) => ({ value: l.value, label: l.name, description: l.blurb }))}
        onChoose={setEffort}
        onClose={() => setSheet(undefined)}
      />
      <Choices
        title="Access"
        open={sheet === "access"}
        value={shownAccess}
        options={offer.permissions.map((p) => ({
          value: p,
          label: accessLevels[p].label,
          description: accessLevels[p].description,
          icon: accessIcons[p],
        }))}
        onChoose={setPermission}
        onClose={() => setSheet(undefined)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 22, paddingTop: 4, paddingBottom: 8 },
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
  input: { fontSize: 16, minHeight: 40, maxHeight: 160, paddingHorizontal: 14, paddingTop: 10 },
  bar: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, paddingTop: 4 },
  round: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    maxWidth: 170,
  },
  pillText: { fontSize: 13, fontWeight: "500", flexShrink: 1 },
  steer: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  send: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
});

