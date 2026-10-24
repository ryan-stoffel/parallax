// A computer's providers, as the desktop's Settings > Providers has them: each instance with its
// switch, Refresh, and Add provider from the desktop's cards; and each one's page, with its display
// name, account, how it runs, its variables, its custom models, and Remove. Every change is saved
// on that computer (`providers/*`). Sign-ins and installs that run in a terminal stay on the
// desktop; Cursor's, which approves in a browser, works here.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Plus, RefreshCw, Trash2 } from "lucide-react-native";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert, Linking, Switch, View } from "react-native";

import { HOME_VARS } from "../../desktop/src/preload/bridge";
import type {
  ProviderEnvVar,
  ProviderInfo,
  ProviderInstance,
  ProvidersListResult,
} from "../../desktop/src/protocol/generated/protocol";
import { instanceModels } from "../../desktop/src/renderer/catalog";
import { describeError } from "../../desktop/src/renderer/errors";
import {
  kindInfoOf,
  presets,
  versionOf,
  versions,
  withVersion,
  type Preset,
} from "../../desktop/src/renderer/providerKinds";
import { capitalized, instanceStatus } from "../../desktop/src/renderer/settings/shared";
import { Choices } from "./Choices";
import { useComputer, type Computer } from "./fleet";
import { ProviderLogo } from "./logos";
import { ago, useNav, type Screens } from "./nav";
import { newInstance, secretName, withVar, argsOf } from "./settingsLogic";
import { can, fail, Field, Note, Page } from "./SettingsParts";
import { Row, Section, T, useColors } from "./ui";

// Each computer's last `providers/list`, shared by the list and each provider's page, and
// replaced by each save or remove's answer.
const lists = new Map<string, ProvidersListResult>();
const listeners = new Set<() => void>();
function put(id: string, result: ProvidersListResult) {
  lists.set(id, result);
  for (const l of listeners) l();
}
const useList = (id: string) =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => lists.get(id),
  );

/** Lists a computer's instances again, probing each with `refresh`. Resolves to an error for people. */
async function load(id: string, refresh = false) {
  const answer = await window.parallax.request(id, "providers/list", { refresh });
  if ("error" in answer) return describeError(answer.error);
  put(id, answer.result);
}

/** Adds `instance` to a computer, or replaces the one with its id, and says so if it can't. */
async function save(id: string, instance: ProviderInstance) {
  const answer = await window.parallax.request(id, "providers/save", { instance });
  if ("error" in answer) {
    fail(`Couldn't save ${instance.name}`, answer.error);
    return false;
  }
  put(id, answer.result);
  return true;
}

/** "Checked just now", "Checked 12m ago". */
function checkedLabel(checkedAt: string): string {
  const since = ago(checkedAt);
  return since === "now" ? "Checked just now" : `Checked ${since} ago`;
}

/** Asks for each of a card's secrets that has no value, such as its API key, in turn. */
async function askSecrets(preset: Preset): Promise<Record<string, string> | undefined> {
  const secrets: Record<string, string> = {};
  for (const v of preset.env ?? []) {
    if (!v.secret || v.value) continue;
    const value = await new Promise<string | undefined>((done) =>
      Alert.prompt(
        preset.name,
        `${v.name}: kept in the host's keychain, and never shown again.`,
        [
          { text: "Cancel", style: "cancel", onPress: () => done(undefined) },
          { text: "Add", onPress: (text?: string) => done(text ?? "") },
        ],
        "secure-text",
      ),
    );
    if (value === undefined) return undefined;
    secrets[v.name] = value;
  }
  return secrets;
}

/** A computer's provider instances, each with its switch, and Refresh and Add provider. */
export function ProvidersPage({ m }: { m: Computer }) {
  const c = useColors();
  const nav = useNav();
  const id = m.machine.id;
  const listed = useList(id);
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [adding, setAdding] = useState(false);
  const supported = can(m, "providers");
  useEffect(() => {
    if (supported) void load(id).then(setError);
  }, [id, supported]);

  if (!supported) return <Section><Note>Update plxd on this computer to manage its providers here.</Note></Section>;
  const list = listed?.providers;
  const on = list?.filter((p) => p.instance.enabled) ?? [];

  const refresh = async () => {
    setChecking(true);
    setError(await load(id, true));
    setChecking(false);
  };
  const add = async (preset: Preset) => {
    const secrets = await askSecrets(preset);
    if (!secrets || !list) return;
    const instance = newInstance(preset, list.map((p) => p.instance), secrets);
    if (await save(id, instance)) nav.navigate("Provider", { id, instance: instance.id });
  };

  return (
    <>
      <Section title="Providers" footer="One provider stays on, for new threads.">
        {error && <Note alert last={false}>{error}</Note>}
        {!list ? (
          !error && <Note last={false}>Checking…</Note>
        ) : !list.length ? (
          <Note last={false}>{`No providers on ${m.machine.name} yet. Add an agent or a model service for threads to run on.`}</Note>
        ) : (
          list.map((info) => {
            const { instance } = info;
            const last = instance.enabled && on.length === 1;
            return (
              <Row
                key={instance.id}
                leading={<ProviderLogo kind={instance.kind} size={20} color={instance.enabled ? undefined : c.faintForeground} />}
                title={instance.name}
                detail={instance.enabled ? instanceStatus(info) : "Off"}
                chevron
                onPress={() => nav.navigate("Provider", { id, instance: instance.id })}
                right={
                  <Switch
                    accessibilityLabel={`Use ${instance.name}`}
                    value={instance.enabled}
                    disabled={last}
                    onValueChange={(enabled) => void save(id, { ...instance, enabled })}
                  />
                }
              />
            );
          })
        )}
        <Row
          icon={RefreshCw}
          title={checking ? "Checking…" : "Refresh"}
          detail={listed && !checking ? checkedLabel(listed.checkedAt) : undefined}
          onPress={checking ? undefined : () => void refresh()}
        />
        <Row icon={Plus} iconColor={c.accent} title="Add provider" last onPress={list ? () => setAdding(true) : undefined} />
      </Section>
      <Choices
        title="Add provider"
        open={adding}
        options={presets.map((p) => ({ value: p.name, label: p.name, description: p.blurb }))}
        onChoose={(name) => void add(presets.find((p) => p.name === name)!)}
        onClose={() => setAdding(false)}
      />
    </>
  );
}

/** One instance's account line: its state, with the email the list leaves out. */
function accountLine(info: ProviderInfo): string {
  if (info.signedIn === true && info.account?.includes("@")) return `Authenticated as ${info.account}`;
  if (!info.installed && info.note) return capitalized(info.note);
  return instanceStatus(info);
}

/**
 * Cursor's browser sign-in: Sign in opens the page plxd gives, then the list is read every 2 s
 * until it's signed in, fails, or 5 minutes pass; leaving cancels it.
 */
function useCursorSignIn(id: string, info: ProviderInfo) {
  const { instance } = info;
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void load(id, true), 2000);
    const giveUp = setTimeout(() => setWaiting(false), 5 * 60 * 1000);
    return () => {
      clearInterval(timer);
      clearTimeout(giveUp);
      void window.parallax.request(id, "cursor/signInCancel", { instance: instance.id });
    };
  }, [waiting, id, instance.id]);
  useEffect(() => {
    if (waiting && info.signedIn === true) setWaiting(false);
  }, [waiting, info.signedIn]);
  useEffect(() => {
    if (!waiting || !info.signInError) return;
    setWaiting(false);
    fail(`Couldn't sign in to ${instance.name}`, info.signInError);
  }, [waiting, info.signInError, instance.name]);
  const signIn = async () => {
    const answer = await window.parallax.request(id, "cursor/signIn", { instance: instance.id });
    if ("error" in answer) return fail(`Couldn't sign in to ${instance.name}`, answer.error);
    void Linking.openURL(answer.result.url);
    setWaiting(true);
  };
  const signOut = async () => {
    const answer = await window.parallax.request(id, "cursor/signOut", { instance: instance.id });
    if ("error" in answer) fail(`Couldn't sign out of ${instance.name}`, answer.error);
    else void load(id, true);
  };
  return { waiting, cancel: () => setWaiting(false), signIn, signOut };
}

/** An instance's page: its name, account, runtime, variables, models, and Remove. */
export function ProviderScreen({ route, navigation }: NativeStackScreenProps<Screens, "Provider">) {
  const { id, instance: instanceId } = route.params;
  const m = useComputer(id);
  const info = useList(id)?.providers.find((p) => p.instance.id === instanceId);
  useEffect(() => navigation.setOptions({ title: info?.instance.name ?? "Provider" }), [info?.instance.name]);
  if (!m || !info)
    return (
      <Page>
        <Section>
          <Note>{m?.connected === false ? "Not connected" : "This provider isn't on the computer anymore."}</Note>
        </Section>
      </Page>
    );
  return <ProviderBody m={m} info={info} onRemoved={() => navigation.goBack()} />;
}

function ProviderBody({ m, info, onRemoved }: { m: Computer; info: ProviderInfo; onRemoved: () => void }) {
  const c = useColors();
  const id = m.machine.id;
  const { instance } = info;
  const kind = kindInfoOf(instance.kind);
  const homeVar = HOME_VARS[instance.kind];
  const choices = versions[instance.kind];
  const version = versionOf(instance);
  const program = instance.program ?? kind.program ?? "the program";
  const [picking, setPicking] = useState(false);
  const change = (patch: Partial<ProviderInstance>) => void save(id, { ...instance, ...patch });
  const cursor = useCursorSignIn(id, info);
  // A Cursor instance with its own CURSOR_API_KEY runs on that key, with no browser sign-in.
  const cursorAccount = instance.kind === "cursor" && !instance.env.some((v) => v.name === "CURSOR_API_KEY");
  // Ollama Cloud's runtime stays out of sight, unless it is one from before 0070 on Claude Code.
  const ollamaCloud = instance.kind === "ollamaCloud" && !instance.env.some((v) => v.name === "ANTHROPIC_BASE_URL");
  // While it installs, plxd probes it again on each list, so the list shows when it ends.
  useEffect(() => {
    if (!info.installing) return;
    const timer = setInterval(() => void load(id), 2000);
    return () => clearInterval(timer);
  }, [info.installing, id]);

  const installCursor = async () => {
    const answer = await window.parallax.request(id, "cursor/install", {});
    if ("error" in answer) fail(`Couldn't install ${instance.name}`, answer.error);
    else void load(id, true);
  };
  const setEnv = (env: ProviderEnvVar[]) => change({ env });
  const editVar = (v: ProviderEnvVar) =>
    Alert.prompt(
      v.name,
      v.secret ? "Secret, kept in the host's keychain. A new value replaces it." : undefined,
      [
        { text: "Remove", style: "destructive", onPress: () => setEnv(instance.env.filter((e) => e.name !== v.name)) },
        { text: "Cancel", style: "cancel" },
        // An emptied secret keeps the stored one.
        { text: "Save", onPress: (value?: string) => (!v.secret || value) && setEnv(withVar(instance.env, v.name, value ?? "", v.secret)) },
      ],
      v.secret ? "secure-text" : "plain-text",
      v.secret ? "" : (v.value ?? ""),
    );
  const addVar = () =>
    Alert.prompt("Add variable", "Letters, digits, and _, not starting with a digit.", (name) => {
      const trimmed = name.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return fail("Couldn't add the variable", "Letters, digits, and _, not starting with a digit.");
      const secret = secretName(trimmed);
      Alert.prompt(
        trimmed,
        secret ? "Secret: kept in the host's keychain, and never shown again." : undefined,
        (value) => setEnv(withVar(instance.env, trimmed, value, secret)),
        secret ? "secure-text" : "plain-text",
      );
    });
  const addModel = () =>
    Alert.prompt("Add custom model", "Model id, such as gpt-oss:120b", (raw) => {
      const modelId = raw.trim();
      if (!modelId || /\s/.test(modelId)) return fail("Couldn't add the model", "A model id has no spaces.");
      Alert.prompt("Display name", undefined, (name) =>
        change({ models: [...instance.models.filter((x) => x.id !== modelId), { id: modelId, name: name.trim() || modelId }] }),
      );
    });
  const remove = () =>
    Alert.alert(`Remove ${instance.name}?`, "Its settings and secrets leave this host; its threads keep their transcripts.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          const answer = await window.parallax.request(id, "providers/remove", { id: instance.id });
          if ("error" in answer) return fail(`Couldn't remove ${instance.name}`, answer.error);
          put(id, answer.result);
          onRemoved();
        },
      },
    ]);
  const models = instanceModels(info);

  return (
    <Page>
      <View style={{ alignItems: "center", gap: 6, paddingTop: 8 }}>
        <ProviderLogo kind={instance.kind} size={40} />
        <T style={{ fontSize: 20, fontWeight: "600" }}>{instance.name}</T>
        {/* What it is, unless its name says so, and its version. */}
        <T muted>{[kind.name !== instance.name && kind.name, info.version].filter(Boolean).join(" · ") || m.machine.name}</T>
      </View>
      {!instance.enabled && (
        <Section>
          <Note>{`Off on this host: new threads and model menus leave out ${instance.name}'s models.`}</Note>
        </Section>
      )}

      <Section
        footer={
          (!info.installed && instance.kind !== "cursor") ||
          (info.installed && info.signedIn !== true && !!info.login && !cursorAccount)
            ? `Installing and signing in to ${kind.name} run in a terminal: do it in Parallax on ${m.machine.name}.`
            : undefined
        }
      >
        <Field
          title="Display name"
          detail="How threads and model menus name it."
          required
          value={instance.name}
          onSave={(name) => change({ name: name.trim().slice(0, 64) })}
        />
        <Row
          title="Account"
          detail={info.installing ? `Installing ${kind.name}…` : accountLine(info)}
          last={!cursor.waiting && !(instance.kind === "cursor" && !info.installed)}
          right={
            cursorAccount && info.installed && !cursor.waiting ? (
              <T style={{ color: c.accent }} onPress={() => void (info.signedIn === true ? cursor.signOut() : cursor.signIn())}>
                {info.signedIn === true ? "Sign out" : "Sign in"}
              </T>
            ) : undefined
          }
        />
        {instance.kind === "cursor" && !info.installed && (
          <Row
            title={info.installing ? "Installing…" : "Install"}
            detail="Runs through the Cursor SDK on this host. Needs Node.js 22.13 or newer."
            last={!cursor.waiting}
            onPress={info.installing ? undefined : () => void installCursor()}
          />
        )}
        {cursor.waiting && (
          <Row
            title="Sign-in"
            detail="Approve the sign-in in your browser. This keeps waiting until you do."
            last
            right={<T style={{ color: c.accent }} onPress={cursor.cancel}>Cancel</T>}
          />
        )}
      </Section>

      <Section title="Runtime">
        {instance.kind === "cursor" ? (
          <Row title="Cursor SDK" detail={info.note ?? "Runs through the Cursor SDK on this host. Needs Node.js 22.13 or newer."} last />
        ) : ollamaCloud ? (
          <Row title="Ollama Cloud" detail="Runs Ollama Cloud's models on this host with the key in OLLAMA_API_KEY." last />
        ) : (
          <>
            {choices && version && (
              <Row
                title="Version"
                detail={`Which ${kind.name} this instance runs.`}
                right={<T muted>{version.label}</T>}
                chevron
                onPress={() => setPicking(true)}
              />
            )}
            <Field
              title="Binary path"
              detail={
                info.path
                  ? `Path to the ${kind.name} binary this instance runs. Found at ${info.path}.`
                  : `Path to the ${kind.name} binary this instance runs. Not found on the host.`
              }
              placeholder={kind.program ?? (instance.kind === "ollamaCloud" ? "claude" : undefined)}
              required={instance.kind === "acp"}
              mono
              value={instance.program ?? ""}
              onSave={(next) => change({ program: next.trim() || undefined })}
            />
            {homeVar && (
              <Field
                title={`${homeVar} path`}
                detail={`Custom ${kind.name} home and config directory, for a second account.`}
                placeholder="Default"
                mono
                value={instance.home ?? ""}
                onSave={(home) => change({ home: home.trim() || undefined })}
              />
            )}
            <Field
              title={kind.wholeArgs ? "Arguments" : "Launch arguments"}
              detail={
                kind.wholeArgs
                  ? `Every argument passed to ${program}, separated by spaces.`
                  : `Additional arguments passed to ${program} on session start, separated by spaces.`
              }
              mono
              value={instance.args.join(" ")}
              onSave={(args) => change({ args: argsOf(args) })}
              last={instance.kind !== "claude"}
            />
            {/* plxd notes the SDK installing, or the Node.js it needs (0061). */}
            {instance.kind === "claude" && (
              <Row
                title="Claude Agent SDK"
                detail={info.note ?? "Runs Claude Code through the Agent SDK on this host. Needs Node.js 22.16 or newer."}
                last
              />
            )}
          </>
        )}
      </Section>

      <Section title="Environment" footer="API keys, base URLs, and other settings this instance's runs get.">
        {instance.env.map((v) => (
          <Row
            key={v.name}
            title={v.name}
            detail={v.secret ? "Secret, kept in the host's keychain" : v.value || "Empty"}
            chevron
            onPress={() => editVar(v)}
          />
        ))}
        <Row icon={Plus} iconColor={c.accent} title="Add variable" last onPress={addVar} />
      </Section>

      <Section title="Models" footer="Custom models are saved on the host. Tap one to remove it.">
        {!models.length && <Note last={false}>{`plxd found no models for ${instance.name}. Add one below.`}</Note>}
        {models.map((x) => (
          <Row
            key={x.id}
            title={x.name}
            detail={x.custom ? `${x.id} · Custom` : x.id}
            onPress={
              x.custom
                ? () =>
                    Alert.alert(`Remove ${x.name}?`, undefined, [
                      { text: "Cancel", style: "cancel" },
                      { text: "Remove", style: "destructive", onPress: () => change({ models: instance.models.filter((y) => y.id !== x.id) }) },
                    ])
                : undefined
            }
          />
        ))}
        <Row icon={Plus} iconColor={c.accent} title="Add custom model" last onPress={addModel} />
      </Section>

      <Section>
        <Row icon={Trash2} title={`Remove ${instance.name}`} destructive last onPress={remove} />
      </Section>

      {choices && version && (
        <Choices
          title="Version"
          open={picking}
          value={version.label}
          options={choices.map((v) => ({ value: v.label, label: v.label }))}
          onChoose={(label) => void save(id, withVersion(instance, choices.find((v) => v.label === label)!))}
          onClose={() => setPicking(false)}
        />
      )}
    </Page>
  );
}
