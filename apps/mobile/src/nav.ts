// The app's screens and what each opens with, for typed navigation, and the sidebar's controls.
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { createContext, useContext } from "react";

import type { SettingsPage } from "./settingsLogic";

export type Screens = {
  /** `instant`: shown without a transition, as a new thread its page started becomes. */
  Thread: { hostId: string; runId: string; instant?: boolean };
  ThreadDetails: { hostId: string; runId: string };
  Computer: { id: string };
  ComputerSettings: { id: string; page: SettingsPage };
  Provider: { id: string; instance: string };
  PullRequest: { hostId: string; runId: string; url: string };
  /** The repository, then computer, picker for a new thread, as a sheet. */
  NewThread: undefined;
  /** A new thread's page, the app's home: with no params, where the last new thread started. */
  StartThread: { hostId?: string; groupId?: string } | undefined;
  /** Search every thread, as a sheet. */
  Search: undefined;
  /** Settings, as a sheet, which pushes Computer, ComputerSettings, Provider, Usage, About, and AddComputer. */
  Settings: undefined;
  /** The app's version and links, pushed in the Settings sheet. */
  About: undefined;
  Usage: undefined;
  /** Every pull request, as a sheet, which pushes PullRequest. */
  PullRequests: undefined;
  AddComputer: undefined;
};

export const useNav = () => useNavigation<NativeStackNavigationProp<Screens>>();

/** What the main view can show: a thread, or a new thread's page. */
export type Main =
  | { name: "Thread"; params: Screens["Thread"] }
  | { name: "StartThread"; params?: Screens["StartThread"] };

/** Opens and closes the sidebar (App.tsx). */
export const SidebarControl = createContext({ open: () => {}, close: () => {} });

/**
 * Makes `route` the main view, with no back stack of threads, as Claude's app has none. The
 * sidebar closes when the main view changes; showing the one already there just closes it.
 */
export function useShow() {
  const nav = useNav();
  const { close } = useContext(SidebarControl);
  return (route: Main) => {
    const state = nav.getState();
    const now = state?.routes[0];
    // The same screen of the same thread or page, whatever else its params carry (`instant`).
    const key = (params?: object) => {
      const { hostId, runId, groupId } = (params ?? {}) as { hostId?: string; runId?: string; groupId?: string };
      return `${hostId}/${runId}/${groupId}`;
    };
    const same = state?.index === 0 && now?.name === route.name && key(now.params) === key(route.params);
    if (same) close();
    else nav.reset({ index: 0, routes: [route] });
  };
}

/** "now", "5m", "3h", "2d": how long ago `iso` was, as the desktop's sidebar says it. */
export function ago(iso: string, now = Date.now()) {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  return minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}
