import { t } from "i18next";
import { useEffect } from "react";

import { useRealConnections } from "./ConnectionStatus";
import { describeError } from "./errors";
import type { Host } from "./hosts";
import { canRun } from "./models";
import { notify } from "./notifications";
import { listedProviders, removeProvider, saveProvider, versions } from "./providers";
import { stored } from "./stored";
import type { ProviderInfo, ProviderInstance } from "../protocol/generated/protocol";

// Linked providers (0096): one list of provider instances this app keeps every computer it reaches
// on, through their own `providers/*`. Secrets, sign-ins, CLI paths, and hubs stay per computer.

const key = "parallax.linkedProviders";
const parse = (raw: unknown, fallback: ProviderInstance[] | null) =>
  Array.isArray(raw) ? (raw as ProviderInstance[]) : fallback;

/** The list every computer follows, or null while providers aren't linked. */
const linked = stored<ProviderInstance[] | null>(key, null, parse);

// Another window's change, read from what's stored now, so an older event can't undo a newer one.
window.addEventListener("storage", (e) => {
  if (e.key !== key) return;
  const raw = localStorage.getItem(key);
  linked.adopt(raw ? parse(JSON.parse(raw), null) : null);
});

/** Whether providers are linked, kept current. */
export const useProvidersLinked = () => linked.use() !== null;

/** A home folder under a user's home as `~/...`, which each computer reads as its own. */
function portableHome(id: string, home: string) {
  const under = /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\]|$)/;
  if (home.startsWith("~")) return home;
  // A folder elsewhere may not exist or be allowed on another computer, so it gets its own there.
  return under.test(home) ? home.replace(under, "~").replaceAll("\\", "/") : `~/.${id}`;
}

const isAbsolute = (path: string) => /^(?:[/\\]|[A-Za-z]:)/.test(path);

/**
 * `instance` as the list keeps it. No secret: its value stays in its computer's keychain, and a
 * variable with no value would make another computer look set up. A CLI's path stays on its
 * computer too, but a command's name doesn't, as OpenCode 2.x's, and an ACP agent needs its program
 * whatever it is. Ollama Cloud's home is the one plxd makes in its own data folder.
 */
export function linkable(instance: ProviderInstance): ProviderInstance {
  const { program, home, ...rest } = instance;
  return {
    ...rest,
    env: instance.env.filter((v) => !v.secret),
    ...(program && (instance.kind === "acp" || !isAbsolute(program)) && { program }),
    ...(home && instance.kind !== "ollamaCloud" && { home: portableHome(instance.id, home) }),
  };
}

/** `value` as text that's the same whatever order its objects' keys are in. */
const canonical = (value: unknown) =>
  JSON.stringify(value, (_, part: unknown) =>
    part && typeof part === "object" && !Array.isArray(part)
      ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b)))
      : part,
  );

/**
 * A computer's own variables with the list's plain ones: its secrets stay, in their order, since
 * plxd reads the keychain when they change, and one the list has as plain stays a secret.
 */
const mergedEnv = (want: ProviderInstance, have: ProviderInstance) => [
  ...have.env.flatMap((v) => {
    const listed = want.env.find((w) => w.name === v.name);
    return v.secret ? [v] : listed ? [listed] : [];
  }),
  ...want.env.filter((w) => !have.env.some((v) => v.name === w.name)),
];

/** A version's program, which follows the list, unlike a program someone chose for a computer. */
const isVersionProgram = (kind: string, program: string | undefined) =>
  !!versions[kind]?.some((v) => v.program && v.program === program);

/** What a computer listing `current` must save to follow `wanted`, and the ids it can't take. */
export function reconcile(wanted: ProviderInstance[], current: ProviderInfo[]) {
  const own = current.filter((p) => !p.hub).map((p) => p.instance);
  const saves: ProviderInstance[] = [];
  const conflicts: string[] = [];
  for (const want of wanted) {
    const have = own.find((i) => i.id === want.id);
    if (!have) {
      saves.push(want);
    } else if (have.kind !== want.kind) {
      conflicts.push(want.id);
    } else {
      // Its own CLI path, home, and secrets stay. Only a version's program follows the list.
      const { program: _program, ...others } = have;
      const program = isVersionProgram(want.kind, want.program)
        ? want.program
        : isVersionProgram(have.kind, have.program)
          ? undefined
          : have.program;
      const next: ProviderInstance = {
        ...others,
        ...(program && { program }),
        name: want.name,
        enabled: want.enabled,
        args: want.args,
        models: want.models,
        env: mergedEnv(want, have),
        ...(want.reserve !== undefined && { reserve: want.reserve }),
      };
      if (canonical(next) !== canonical(have)) saves.push(next);
    }
  }
  // Turned off, not removed, since removing one deletes its secrets. A list with nothing on would
  // leave a computer with nothing to run on, so it turns nothing off.
  if (wanted.some((w) => w.enabled))
    for (const instance of own)
      if (instance.enabled && !wanted.some((w) => w.id === instance.id))
        saves.push({ ...instance, enabled: false });
  return { saves, conflicts };
}

/** The computers connected to a plxd with `providers`, by id, with their names. */
const reachable = new Map<string, string>();

function report(hostId: string, problem: string) {
  notify({
    tone: "error",
    title: t("Couldn't link providers on {{computer}}", {
      computer: reachable.get(hostId) ?? hostId,
    }),
    body: problem,
  });
}

// One change at a time per computer, each reading the list when its turn comes, so a slow one can't
// undo a newer one.
const queues = new Map<string, Promise<unknown>>();
function inTurn(hostId: string, run: () => Promise<void>) {
  const next = (queues.get(hostId) ?? Promise.resolve())
    .then(run)
    .catch((error: unknown) => report(hostId, String(error)));
  queues.set(hostId, next);
  return next;
}

/** Saves what `hostId` needs to follow the list, and says what it couldn't take. */
const bringInLine = (hostId: string) =>
  inTurn(hostId, async () => {
    if (!linked.get()) return;
    const answer = await window.parallax.request(hostId, "providers/list", { refresh: false });
    if ("error" in answer) return report(hostId, describeError(answer.error));
    const wanted = linked.get();
    if (!wanted) return;
    const { saves, conflicts } = reconcile(wanted, answer.result.providers);
    for (const instance of saves) {
      const failed = await saveProvider(hostId, instance);
      if (failed) report(hostId, `${instance.name}: ${failed}`);
    }
    for (const id of conflicts)
      report(hostId, t("It has a different kind of provider named {{id}}.", { id }));
  });

const spread = (except: string) =>
  Promise.all([...reachable.keys()].filter((id) => id !== except).map(bringInLine));

/**
 * Whether `providers` can be the list: one must be able to run. A new computer lists Cursor, on,
 * with nothing installed, and following it would turn everything off on the others.
 */
export const canLink = (providers: ProviderInfo[]) =>
  providers.some((p) => !p.hub && p.instance.enabled && canRun(p));

/** Whether the list has provider `id`, whose removal then reaches the other computers. */
export const isListed = (id: string | undefined) => !!linked.get()?.some((i) => i.id === id);

/** Links providers, with `hostId`'s as the list, if it can be. */
export async function linkProviders(hostId: string) {
  const list = listedProviders(hostId)?.providers ?? [];
  if (!canLink(list)) return;
  linked.set(list.filter((p) => !p.hub).map((p) => linkable(p.instance)));
  await spread(hostId);
}

/** Unlinks providers. Each computer keeps the ones it has. */
export const unlinkProviders = () => linked.set(null);

/**
 * `saveProvider`, and while linked, on every other computer too. It takes its computer's turn, so a
 * pass bringing that computer in line can't overwrite it.
 */
export async function saveEverywhere(hostId: string, instance: ProviderInstance) {
  let failed: string | undefined;
  await inTurn(hostId, async () => {
    failed = await saveProvider(hostId, instance);
    const wanted = linked.get();
    if (failed || !wanted) return;
    const entry = linkable(instance);
    linked.set(
      wanted.some((i) => i.id === entry.id)
        ? wanted.map((i) => (i.id === entry.id ? entry : i))
        : [...wanted, entry],
    );
  });
  if (!failed && linked.get()) void spread(hostId);
  return failed;
}

/** `removeProvider`, and while linked, on every other computer that has that provider too. */
export async function removeEverywhere(hostId: string, id: string) {
  const kind = listedProviders(hostId)?.providers.find((p) => p.instance.id === id)?.instance.kind;
  let failed: string | undefined;
  let entry: ProviderInstance | undefined;
  await inTurn(hostId, async () => {
    failed = await removeProvider(hostId, id);
    const wanted = linked.get();
    // One outside the list, or of another kind under its id, is only this computer's to remove.
    entry = wanted?.find((i) => i.id === id && i.kind === kind);
    if (!failed && entry) linked.set(wanted!.filter((i) => i !== entry));
  });
  const removed = entry;
  if (failed || !removed) return failed;
  for (const other of reachable.keys()) {
    if (other === hostId) continue;
    void inTurn(other, async () => {
      const answer = await window.parallax.request(other, "providers/list", { refresh: false });
      if ("error" in answer) return report(other, describeError(answer.error));
      // A provider of another kind under this id isn't the one that was removed.
      const same = answer.result.providers.some(
        (p) => p.instance.id === id && p.instance.kind === removed.kind && !p.hub,
      );
      const problem = same ? await removeProvider(other, id) : undefined;
      if (problem) report(other, problem);
    });
  }
  return undefined;
}

/** Keeps track of the computers `hosts` can reach, and brings each in line as it connects. */
export function useProviderLink(hosts: Host[]) {
  // Real, so a computer in a short drop is out of the next change, and caught up once it's back.
  const states = useRealConnections(hosts.map((h) => h.id));
  useEffect(() => {
    const ready = hosts.filter((_, i) => {
      const state = states[i];
      return state?.status === "connected" && "providers" in state.capabilities;
    });
    const newly = ready.filter((h) => !reachable.has(h.id));
    reachable.clear();
    for (const h of ready) reachable.set(h.id, h.name);
    for (const h of newly) void bringInLine(h.id);
  }, [hosts, states]);
}
