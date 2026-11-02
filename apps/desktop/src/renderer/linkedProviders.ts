import { useEffect } from "react";

import { useConnections } from "./ConnectionStatus";
import { describeError } from "./errors";
import type { Host } from "./hosts";
import { notify } from "./notifications";
import { listedProviders, removeProvider, saveProvider } from "./providers";
import { stored } from "./stored";
import type { ProviderInfo, ProviderInstance } from "../protocol/generated/protocol";

// Linked providers (0096): one list of provider instances this app keeps every computer it reaches
// on, through their own `providers/*`. A secret, a sign-in, a CLI's path, and a hub stay per computer.

const key = "parallax.linkedProviders";
const parse = (raw: unknown, fallback: ProviderInstance[] | null) =>
  Array.isArray(raw) ? (raw as ProviderInstance[]) : fallback;

/** The list every computer follows, or null while providers aren't linked. */
const linked = stored<ProviderInstance[] | null>(key, null, parse);

// Another window's change, which `stored` alone only sees once this one reloads.
window.addEventListener("storage", (e) => {
  if (e.key === key) linked.set(e.newValue ? parse(JSON.parse(e.newValue), null) : null);
});

/** Whether providers are linked, kept current. */
export const useProvidersLinked = () => linked.use() !== null;

/** A home folder under a user's home as `~/...`, which each computer reads as its own. */
const portableHome = (home: string) => {
  const under = /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\]|$)/;
  return under.test(home) ? home.replace(under, "~").replaceAll("\\", "/") : home;
};

/**
 * `instance` as the list keeps it: never a secret's value, which only its computer's keychain
 * holds, nor its CLI's path. Ollama Cloud's home is the one plxd makes in its own data folder.
 */
export function linkable(instance: ProviderInstance): ProviderInstance {
  const { program: _program, home, ...rest } = instance;
  return {
    ...rest,
    env: instance.env.map(({ name, value, secret }) =>
      secret ? { name, secret } : { name, secret, ...(value !== undefined && { value }) },
    ),
    ...(home && instance.kind !== "ollamaCloud" && { home: portableHome(home) }),
  };
}

/** `value` as text that's the same whatever order its objects' keys are in. */
const canonical = (value: unknown) =>
  JSON.stringify(value, (_, part: unknown) =>
    part && typeof part === "object" && !Array.isArray(part)
      ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b)))
      : part,
  );

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
      // Its own CLI path, home, and secrets stay, including a secret the list doesn't have.
      const next: ProviderInstance = {
        ...have,
        name: want.name,
        enabled: want.enabled,
        args: want.args,
        models: want.models,
        env: [
          ...want.env,
          ...have.env.filter((v) => v.secret && !want.env.some((w) => w.name === v.name)),
        ],
        ...(want.reserve !== undefined && { reserve: want.reserve }),
      };
      if (canonical(next) !== canonical(have)) saves.push(next);
    }
  }
  // Turned off, not removed, since removing one deletes its secrets.
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
    title: `Couldn't link providers on ${reachable.get(hostId) ?? hostId}`,
    body: problem,
  });
}

/** Saves what `hostId` needs to follow the list, and says what it couldn't take. */
async function bringInLine(hostId: string) {
  const wanted = linked.get();
  if (!wanted) return;
  const answer = await window.parallax.request(hostId, "providers/list", { refresh: false });
  if ("error" in answer) return report(hostId, describeError(answer.error));
  const { saves, conflicts } = reconcile(wanted, answer.result.providers);
  for (const instance of saves) {
    const failed = await saveProvider(hostId, instance);
    if (failed) report(hostId, `${instance.name}: ${failed}`);
  }
  for (const id of conflicts) report(hostId, `It has a different kind of provider named ${id}.`);
}

const spread = (except: string) =>
  Promise.all([...reachable.keys()].filter((id) => id !== except).map(bringInLine));

/** Links providers, with `hostId`'s as the list. */
export function linkProviders(hostId: string) {
  const list = listedProviders(hostId)?.providers ?? [];
  linked.set(list.filter((p) => !p.hub).map((p) => linkable(p.instance)));
  return spread(hostId);
}

/** Unlinks providers. Each computer keeps the ones it has. */
export const unlinkProviders = () => linked.set(null);

/** `saveProvider`, and while linked, on every other computer too. */
export async function saveEverywhere(hostId: string, instance: ProviderInstance) {
  const failed = await saveProvider(hostId, instance);
  const wanted = linked.get();
  if (failed || !wanted) return failed;
  const entry = linkable(instance);
  linked.set(
    wanted.some((i) => i.id === entry.id)
      ? wanted.map((i) => (i.id === entry.id ? entry : i))
      : [...wanted, entry],
  );
  void spread(hostId);
  return undefined;
}

/** `removeProvider`, and while linked, on every other computer that has it too. */
export async function removeEverywhere(hostId: string, id: string) {
  const failed = await removeProvider(hostId, id);
  const wanted = linked.get();
  if (failed || !wanted) return failed;
  linked.set(wanted.filter((i) => i.id !== id));
  for (const other of reachable.keys()) {
    if (other === hostId) continue;
    const answer = await window.parallax.request(other, "providers/list", { refresh: false });
    if ("error" in answer) report(other, describeError(answer.error));
    else if (answer.result.providers.some((p) => p.instance.id === id && !p.hub)) {
      const problem = await removeProvider(other, id);
      if (problem) report(other, problem);
    }
  }
  return undefined;
}

/** Keeps track of the computers `hosts` can reach, and brings each in line as it connects. */
export function useProviderLink(hosts: Host[]) {
  const states = useConnections(hosts.map((h) => h.id));
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
