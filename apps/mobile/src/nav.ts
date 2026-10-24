// The app's screens and what each opens with, for typed navigation.
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

import type { SettingsPage } from "./settingsLogic";

export type Screens = {
  Tabs: undefined;
  Thread: { hostId: string; runId: string };
  ThreadDetails: { hostId: string; runId: string };
  Computer: { id: string };
  ComputerSettings: { id: string; page: SettingsPage };
  Provider: { id: string; instance: string };
  PullRequest: { hostId: string; runId: string; url: string };
  NewThread: undefined;
  StartThread: { hostId: string; groupId: string };
  AddComputer: undefined;
};

export const useNav = () => useNavigation<NativeStackNavigationProp<Screens>>();

/** "now", "5m", "3h", "2d": how long ago `iso` was, as the desktop's sidebar says it. */
export function ago(iso: string, now = Date.now()) {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  return minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}
