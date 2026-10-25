// The thread's message box, as the desktop's Composer, for a phone: the text, photos and files to
// attach, and the model, reasoning effort, and access for what follows, in one sheet.
// Photos go to the agent as images and are saved on the computer too, and files are saved there
// with `host/upload` and listed after the text (0071), as the desktop sends them.
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as Haptics from "expo-haptics";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { Asset, type AssetMetadata } from "expo-media-library";
import { Check, ChevronDown, ChevronLeft, ChevronRight, FileText, Plus, X } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Image,
  Keyboard,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { ScrollView as GestureScrollView } from "react-native-gesture-handler";
import Animated, { FadeIn, FadeOut, LinearTransition, useAnimatedStyle, withTiming } from "react-native-reanimated";

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
import { defaultBackend } from "../../desktop/src/renderer/settings/shared";
import type { ThreadStart } from "../../desktop/src/renderer/threads";
import { uuidv7 } from "../../desktop/src/renderer/uuidv7";
import { AttachSheet } from "./AttachSheet";
import { EffortSlider } from "./EffortSlider";
import type { Computer } from "./fleet";
import { GlassButton } from "./Glass";
import { openLightbox } from "./Lightbox";
import { ProviderLogo } from "./logos";
import { allAccess, useOffers, type Offer } from "./offers";
import { SendButton } from "./SendButton";
import { Sheet, sheetTitle } from "./Sheet";
import { Icon, T, useColors } from "./ui";

/**
 * A file picked to send: an image (shown, and sent as one), with the library photo's id when it was
 * tapped in the attach sheet, or any other file.
 */
type Attached =
  | { kind: "image"; key: string; image: PromptImage; uri: string; asset?: string }
  | { kind: "file"; key: string; name: string; uri: string; size: number };

// The longest edge a photo is sent at, as the desktop's `readImage`: Anthropic refuses larger
// ones once a conversation holds more than 20 images.
const MAX_EDGE = 2000;

/** A picked photo as an image plxd takes: at most 2000 px on its long edge, as JPEG. */
async function photo(
  asset: Pick<ImagePicker.ImagePickerAsset, "uri" | "width" | "height">,
  libraryId?: string,
): Promise<Attached> {
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
    ...(libraryId && { asset: libraryId }),
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

type Page = "model" | "provider" | "access";

/**
 * The model sheet, as Claude's app has it: the provider with its mark, the model as a list that
 * opens in place, the reasoning slider, and Access, which opens its own choices, under a close
 * button and title.
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
  const { height } = useWindowDimensions();
  // The model list, open in place; it closes each time the sheet does.
  const [listing, setListing] = useState(false);
  useEffect(() => {
    if (!open) setListing(false);
  }, [open]);
  const turn = useAnimatedStyle(() => ({
    transform: [{ rotate: withTiming(listing ? "180deg" : "0deg", { duration: 200 }) }],
  }));
  const choose = (then: () => void) => {
    void Haptics.selectionAsync();
    then();
  };
  const current = offers.find((o) => o.id === provider);
  const level = effortLevels.find((l) => l.value === effort);
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
  /** A row with its value on the right, which opens more. */
  const row = (label: string, value: React.ReactNode, onPress: () => void, trailing: React.ReactNode, a11y: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      onPress={onPress}
      style={({ pressed }) => [styles.link, pressed && { backgroundColor: c.hover }]}
    >
      <T style={{ fontSize: 17 }}>{label}</T>
      <View style={styles.value}>{value}</View>
      {trailing}
    </Pressable>
  );
  const chevron = <Icon icon={ChevronRight} size={17} color={c.faintForeground} />;
  const title = { model: "Select model", provider: "Provider", access: "Access" }[page];
  const shown = models.find((m) => m.id === model);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      head={
        <View style={styles.sheetHead}>
          <T style={sheetTitle}>{title}</T>
          <GlassButton
            label={page === "model" ? "Close" : "Back"}
            size={40}
            onPress={() => (page === "model" ? onClose() : onPage("model"))}
          >
            <Icon icon={page === "model" ? X : ChevronLeft} size={20} color={c.foreground} />
          </GlassButton>
        </View>
      }
    >
      <GestureScrollView
        style={{ maxHeight: height * 0.72 }}
        contentContainerStyle={{ gap: 12, paddingHorizontal: 16 }}
      >
        {page === "model" && (
          <>
            {offers.length > 1 && (
              <View style={card}>
                {row(
                  "Provider",
                  <>
                    <ProviderLogo kind={current?.kind} size={18} />
                    <T muted numberOfLines={1} style={{ fontSize: 16, flexShrink: 1 }}>
                      {current?.name ?? provider}
                    </T>
                  </>,
                  () => onPage("provider"),
                  chevron,
                  `Provider: ${current?.name ?? provider}`,
                )}
              </View>
            )}
            <Animated.View layout={LinearTransition.duration(200)} style={card}>
              {row(
                "Model",
                <T muted numberOfLines={1} style={{ fontSize: 16, flexShrink: 1 }}>
                  {shortName(shown?.name ?? (model || "Default"))}
                </T>,
                () => choose(() => setListing((l) => !l)),
                <Animated.View style={turn}>
                  <Icon icon={ChevronDown} size={17} color={c.faintForeground} />
                </Animated.View>,
                `Model: ${shown?.name ?? (model || "Default")}`,
              )}
              {listing && (
                <Animated.View
                  entering={FadeIn.duration(180)}
                  exiting={FadeOut.duration(120)}
                  style={{ borderTopColor: c.border, borderTopWidth: StyleSheet.hairlineWidth }}
                >
                  {models.map((m, i) =>
                    option(
                      m.id || "default",
                      shortName(m.name),
                      modelLine(m),
                      m.id === model,
                      () => {
                        onModel(m.id);
                        setListing(false);
                      },
                      i === models.length - 1,
                      <ProviderLogo kind={current?.kind || m.provider} size={22} />,
                    ),
                  )}
                </Animated.View>
              )}
            </Animated.View>
            {efforts && (
              <Animated.View layout={LinearTransition.duration(200)} style={[...card, styles.reasoning]}>
                <View style={{ gap: 2 }}>
                  <T style={{ fontSize: 17 }}>
                    Reasoning <T muted style={{ fontSize: 17 }}>{level?.name ?? "Default"}</T>
                  </T>
                  <T faint numberOfLines={1} style={{ fontSize: 13, lineHeight: 18 }}>
                    {level?.blurb ?? "As the provider sets it, until you pick one"}
                  </T>
                </View>
                <EffortSlider value={effort} onChange={onEffort} />
              </Animated.View>
            )}
            {permission && (
              <Animated.View layout={LinearTransition.duration(200)} style={card}>
                {row(
                  "Access",
                  <T muted numberOfLines={1} style={{ fontSize: 16, flexShrink: 1 }}>
                    {accessLevels[permission].label}
                  </T>,
                  () => onPage("access"),
                  chevron,
                  `Access: ${accessLevels[permission].label}`,
                )}
              </Animated.View>
            )}
          </>
        )}
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
      </GestureScrollView>
    </Sheet>
  );
}

/** What a new thread starts with: the prompt, its images, and the run's options. */
export interface Start {
  text: string;
  images: PromptImage[];
  options: ThreadStart["options"];
}

/**
 * The message box of thread `runId`, whose messages go through its computer's outbox, or with
 * `onStart`, of a new thread, which it starts.
 */
export function Composer({
  computer,
  runId,
  run,
  working = false,
  draft,
  onDraft,
  onStop = () => {},
  onStart,
  placeholder,
  bottom,
}: {
  computer: Computer | undefined;
  runId?: string;
  run?: AgentRun;
  working?: boolean;
  draft: string;
  onDraft: (text: string) => void;
  onStop?: () => void;
  /** Starts a new thread with the message. Resolves to why it couldn't, for people. */
  onStart?: (start: Start) => Promise<string | undefined>;
  placeholder?: string;
  bottom: number;
}) {
  const c = useColors();
  const offers = useOffers(computer);
  const [provider, setProvider] = useState<string>();
  // A new thread runs on its computer's default provider unless another is picked, as on the
  // desktop, so the sheet opens on that one's models.
  const hostId = computer?.machine.id;
  // Read for this computer: another's stays until it's replaced, which a change of computer does.
  const [stored, setRead] = useState<{ hostId: string; backend?: string }>();
  const read = stored?.hostId === hostId ? stored : undefined;
  const standard = read?.backend;
  const online = !!computer?.connected;
  useEffect(() => {
    if (!onStart || !hostId || !online) return;
    let live = true;
    void defaultBackend(hostId, "worker").then((backend) => live && setRead({ hostId, backend }));
    return () => {
      live = false;
    };
  }, [!!onStart, hostId, online]);
  const shownProvider = provider ?? run?.backend ?? standard;
  const fallback: Offer = {
    id: "",
    name: "",
    kind: "",
    models: [],
    efforts: true,
    permissions: allAccess,
    coordinator: true,
  };
  const offer = offers.find((o) => o.id === shownProvider) ?? offers[0] ?? fallback;
  // Another provider takes a message only on a plxd that moves runs (`sendAccount`), as on the desktop.
  const moves = "sendAccount" in (computer?.view.capabilities ?? {});
  const [model, setModel] = useState<string>();
  const [effort, setEffort] = useState<AgentEffort>();
  const [permission, setPermission] = useState<AgentPermission>();
  const [attached, setAttached] = useState<Attached[]>([]);
  const [sheet, setSheet] = useState<Page>();
  const [attaching, setAttaching] = useState(false);
  // Library photos tapped in the attach sheet and still being read, shown as attached already.
  const [pending, setPending] = useState<string[]>([]);
  const reading = useRef(new Set<string>());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const connected = !!computer?.connected;
  const capabilities = computer?.view.capabilities ?? {};
  const caps = imageCaps(computer?.state);
  // A new model, effort, or access goes with a message only to a plxd that takes it.
  // A new thread's model, effort, and access go to a plxd that takes them (`runOptions`); an open
  // thread's change goes with a message only to one that takes that (`sendModel`).
  const changes = onStart ? "runOptions" in capabilities : "sendModel" in capabilities;

  // A new thread starts on its provider's first model unless another is picked, as on the desktop.
  // An open run without one runs on its CLI's default, which only the provider's name can stand for.
  const shownModel = model ?? run?.model ?? (onStart ? offer.models[0]?.id : undefined) ?? "";
  const modelName =
    offer.models.find((m) => m.id === shownModel)?.name ?? (shownModel || offer.name || "Default model");
  const shownEffort = effort ?? run?.effort;
  const shownAccess = permission ?? run?.permission;
  const text = draft;
  const ready = !!(text.trim() || attached.length) && !!computer && !sending;

  const maxImages = caps?.maxImages ?? 10;

  /**
   * Attaches photos from the library's picker or the camera. The camera opens only once it's
   * allowed, which `launchCameraAsync` doesn't ask for itself: it refuses until then.
   */
  async function pickPhotos(camera: boolean) {
    const options: ImagePicker.ImagePickerOptions = {
      mediaTypes: ["images"],
      quality: 1,
      allowsMultipleSelection: !camera,
      selectionLimit: maxImages,
    };
    try {
      if (camera && !(await ImagePicker.requestCameraPermissionsAsync()).granted)
        return Alert.alert("Camera is off for Parallax", "Allow it in Settings to take a photo for your message.", [
          { text: "Not now", style: "cancel" },
          { text: "Open Settings", onPress: () => void Linking.openSettings() },
        ]);
      const picked = camera
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync(options);
      if (picked.canceled) return;
      const photos = await Promise.all(picked.assets.map((a) => photo(a)));
      setAttached((a) => [...a, ...photos]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** Attaches files from the document picker. */
  async function pickFiles() {
    try {
      const picked = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (picked.canceled) return;
      setAttached((a) => [
        ...a,
        ...picked.assets.map(
          (f): Attached => ({ kind: "file", key: uuidv7(), name: f.name, uri: f.uri, size: f.size ?? 0 }),
        ),
      ]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** Attaches a recent photo tapped in the attach sheet, or takes it off when it's attached. */
  async function toggleRecent(p: AssetMetadata) {
    // The ref, not `pending`, so a second tap before the first's render lands sees the first.
    if (reading.current.has(p.id)) return;
    const had = attached.find((a) => a.kind === "image" && a.asset === p.id);
    if (had) return setAttached((a) => a.filter((x) => x !== had));
    if (attached.filter((a) => a.kind === "image").length + reading.current.size >= maxImages) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return setError(`A message takes up to ${maxImages} photos.`);
    }
    reading.current.add(p.id);
    setPending((x) => [...x, p.id]);
    try {
      const asset = new Asset(p.id);
      const picked = await photo(
        {
          uri: await asset.getUri(),
          width: p.width ?? (await asset.getWidth()),
          height: p.height ?? (await asset.getHeight()),
        },
        p.id,
      );
      setAttached((a) => [...a, picked]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      reading.current.delete(p.id);
      setPending((x) => x.filter((id) => id !== p.id));
    }
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
      if (onStart) {
        // The provider shown when it isn't the default: one picked, or another when the default's is
        // off. Until the default is read, only one picked, so a default API key isn't passed over.
        const moved = read ? (offer.id !== standard ? offer.id : undefined) : provider;
        const failed = await onStart({
          text: withFiles(text.trim(), paths),
          images,
          options: {
            // Until the default provider is read, the model shown may be another provider's.
            ...(changes && (model ?? (read ? shownModel : "")) !== "" && { model: model ?? shownModel }),
            ...(moved && { account: { kind: "subscription" as const, backend: moved } }),
            ...(changes && effort && offer.efforts && { effort }),
            ...(changes && permission && offer.permissions.includes(permission) && { permission }),
          },
        });
        if (failed) throw new Error(failed);
        onDraft("");
        setAttached([]);
        return;
      }
      computer.outbox.add({
        id: uuidv7(),
        threadId: runId!,
        text: withFiles(text.trim(), paths),
        steer,
        ...(images.length && { images }),
        ...(changes && model !== undefined && { model }),
        ...(moves && provider && provider !== run?.backend && {
          account: { kind: "subscription" as const, backend: provider },
        }),
        // Only what the thread's provider takes: plxd refuses a run on a provider that can't.
        ...(changes && effort && offer.efforts && { effort }),
        ...(changes && permission && offer.permissions.includes(permission) && { permission }),
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
          placeholder={placeholder ?? (working ? "Steer, or queue a follow-up" : "Reply")}
          placeholderTextColor={c.faintForeground}
          style={[styles.input, { color: c.foreground }]}
        />
        <View style={styles.bar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach"
            hitSlop={8}
            onPress={() => {
              Keyboard.dismiss();
              setAttaching(true);
            }}
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
              <ProviderLogo kind={offer.kind || shownProvider} size={15} color={c.foreground} />
              <Text numberOfLines={1} style={[styles.pillText, { color: c.foreground, flexShrink: 1 }]}>
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
            <SendButton
              stop
              label="Stop"
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                onStop();
              }}
            />
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
            <SendButton label={working ? "Queue" : "Send"} disabled={!ready} onPress={() => void send(false)} />
          )}
        </View>
      </View>
      <AttachSheet
        open={attaching}
        onClose={() => setAttaching(false)}
        selected={[...attached.flatMap((a) => (a.kind === "image" && a.asset ? [a.asset] : [])), ...pending]}
        onToggle={(p) => void toggleRecent(p)}
        onPhotos={() => void pickPhotos(false)}
        onCamera={() => void pickPhotos(true)}
        onFiles={() => void pickFiles()}
      />
      <ModelSheet
        open={!!sheet}
        page={sheet ?? "model"}
        onPage={setSheet}
        onClose={() => setSheet(undefined)}
        offers={offers}
        provider={offer.id}
        onProvider={(id) => {
          setProvider(id);
          // A new provider's own first model, and its own effort and access, as their defaults.
          setModel(offers.find((o) => o.id === id)?.models[0]?.id ?? "");
          setEffort(undefined);
          setPermission(undefined);
        }}
        // As on the desktop: another provider only where plxd moves runs, and for a Project's
        // coordinator (a `noWrite` run), only one that can run a coordinator.
        canMove={(id) =>
          !!onStart ||
          id === run?.backend ||
          (moves && (run?.policy !== "noWrite" || !!offers.find((o) => o.id === id)?.coordinator))
        }
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
  sheetHead: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingBottom: 14 },
  card: { borderRadius: 20, borderCurve: "continuous", overflow: "hidden" },
  value: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 7 },
  reasoning: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 12, gap: 14 },
  option: { flexDirection: "row", alignItems: "center", paddingLeft: 18 },
  leading: { width: 32, height: 32, borderRadius: 9, alignItems: "center", justifyContent: "center", marginRight: 12 },
  optionBody: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, paddingRight: 18 },
  link: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 18, paddingVertical: 16 },
  round: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  pill: {
    height: 38,
    borderRadius: 19,
    paddingLeft: 13,
    paddingRight: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    maxWidth: 240,
  },
  pillText: { fontSize: 15 },
  steer: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
});

