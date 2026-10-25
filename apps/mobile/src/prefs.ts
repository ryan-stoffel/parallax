// What this phone keeps of the user's choices: which notifications to show, the appearance, where
// the last new thread started, and the access new threads start with.
// One file, out of backups like the rest of the app's (machines.ts), read once at launch.
import { File } from "expo-file-system";
import { useSyncExternalStore } from "react";
import { Appearance } from "react-native";

import type { AgentPermission } from "../../desktop/src/protocol/generated/protocol";
import { privateFile } from "../modules/pinned-tls";

export interface Prefs {
  /** Which kinds of notification show. */
  notify: { needsYou: boolean; done: boolean; failed: boolean };
  appearance: "system" | "light" | "dark";
  /** The computer and repository (or no repo) the last new thread started in, where the next goes. */
  lastStart?: { hostId: string; groupId: string };
  /** The access a new thread starts with, as the desktop's New thread default. Unset: the provider's own. */
  access?: AgentPermission;
}

const defaults: Prefs = { notify: { needsYou: true, done: true, failed: true }, appearance: "system" };
const file = new File(privateFile("prefs.json"));

let prefs: Prefs = (() => {
  try {
    return file.exists ? { ...defaults, ...(JSON.parse(file.textSync()) as Partial<Prefs>) } : defaults;
  } catch {
    return defaults;
  }
})();
const listeners = new Set<() => void>();

const apply = (p: Prefs) =>
  Appearance.setColorScheme(p.appearance === "system" ? "unspecified" : p.appearance);
apply(prefs);

export const getPrefs = () => prefs;

export function setPrefs(change: Partial<Prefs>) {
  prefs = { ...prefs, ...change };
  file.write(JSON.stringify(prefs));
  apply(prefs);
  for (const l of listeners) l();
}

export const usePrefs = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => prefs,
  );
