// The app: sign in, then onboarding until a computer is found, then the tabs (Threads, Pull
// requests, Settings) over every computer, with threads and pull requests pushed on top. The
// connections, thread lists, and transcripts are the desktop renderer's (fleet.tsx).
import {
  createNavigationContainerRef,
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
} from "@react-navigation/native";
import { createNativeBottomTabNavigator } from "@react-navigation/bottom-tabs/unstable";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useEffect, useRef, useState } from "react";
import { useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AccountProvider, SignIn, useAccount } from "./Account";
import { useFleet, FleetProvider } from "./fleet";
import { loadSetup, probe, saveSetup, type Setup } from "./machines";
import type { Screens } from "./nav";
import { NewThreadScreen } from "./NewThread";
import { Loading, Onboarding } from "./Onboarding";
import { PullRequestList, PullRequestScreen } from "./PullRequests";
import { alertFor, notify, onOpened, phaseOf, type Phase } from "./push";
import { LightboxHost } from "./Lightbox";
import { getPrefs } from "./prefs";
import { AddComputerScreen, ComputerScreen, SettingsScreen } from "./Settings";
import { ThreadDetailsScreen } from "./ThreadDetails";
import { NightlyBadge } from "./ui";
import { dark, light } from "./theme";
import { ThreadScreen } from "./Thread";
import { ThreadList } from "./ThreadList";

const Stack = createNativeStackNavigator<Screens>();
const Tabs = createNativeBottomTabNavigator();
const nav = createNavigationContainerRef<Screens>();

/** A tab's own stack, for its large title and search bar, with the nightly tag on its left. */
function tab(title: string, Screen: React.ComponentType) {
  const Inner = createNativeStackNavigator();
  return function TabStack() {
    return (
      <Inner.Navigator
        screenOptions={{
          headerLargeTitle: true,
          headerTransparent: true,
          headerLargeTitleShadowVisible: false,
          headerLeft: () => <NightlyBadge />,
        }}
      >
        <Inner.Screen name={title} component={Screen} options={{ title }} />
      </Inner.Navigator>
    );
  };
}

const ThreadsTab = tab("Threads", ThreadList);
const PullRequestsTab = tab("Pull requests", PullRequestList);
const SettingsTab = tab("Settings", SettingsScreen);

function Home() {
  const { computers } = useFleet();
  const needs = computers.reduce(
    (n, m) => n + Object.values(m.view.state.approvals).filter((t) => t.items.some((i) => i.kind === "approval" && !i.resolved)).length,
    0,
  );
  return (
    <Tabs.Navigator screenOptions={{ headerShown: false }}>
      <Tabs.Screen
        name="ThreadsTab"
        component={ThreadsTab}
        options={{
          title: "Threads",
          tabBarIcon: { type: "sfSymbol", name: "bubble.left.and.bubble.right" },
          tabBarBadge: needs || undefined,
        }}
      />
      <Tabs.Screen
        name="PullRequestsTab"
        component={PullRequestsTab}
        options={{ title: "Pull requests", tabBarIcon: { type: "sfSymbol", name: "arrow.triangle.branch" } }}
      />
      <Tabs.Screen
        name="SettingsTab"
        component={SettingsTab}
        options={{ title: "Settings", tabBarIcon: { type: "sfSymbol", name: "gearshape" } }}
      />
    </Tabs.Navigator>
  );
}

/**
 * Notifies when a thread on any computer starts needing the user, or finishes or fails, and
 * opens the thread a tapped notification is about.
 */
function Alerts() {
  const { computers } = useFleet();
  const phases = useRef(new Map<string, Phase>());
  const latest = useRef(computers);
  latest.current = computers;

  for (const m of computers) {
    // A list still loading would look like every run starting over.
    if (!m.connected || m.view.loading) continue;
    const { state } = m.view;
    for (const t of state.threads) {
      if (t.archived) continue;
      const key = `${m.machine.id}:${t.id}`;
      const asks = state.approvals[t.id]?.items.filter((i) => i.kind === "approval" && !i.resolved).length ?? 0;
      const now = phaseOf(state.runs[t.id], asks);
      const alert = alertFor(phases.current.get(key), now);
      phases.current.set(key, now);
      if (alert && getPrefs().notify[alert]) notify(alert, m.machine.id, t.id, state.titles[t.id] ?? "A thread", m.machine.name);
    }
  }

  useEffect(
    () =>
      onOpened(({ hostId, runId }) => {
        const owner =
          hostId ??
          latest.current.find((m) => m.view.state.threads.some((t) => t.id === runId))?.machine.id;
        if (owner && nav.isReady()) nav.navigate("Thread", { hostId: owner, runId });
      }),
    [],
  );
  return null;
}

/**
 * Links into the app: `parallax://threads`, `prs`, and `settings` for the tabs,
 * `parallax://thread/<computer>/<thread>`, and a thread's pull request at
 * `parallax://pr/<computer>/<thread>?url=<its URL>`.
 */
const linking = {
  prefixes: ["parallax://"],
  config: {
    screens: {
      Tabs: { screens: { ThreadsTab: "threads", PullRequestsTab: "prs", SettingsTab: "settings" } },
      Thread: "thread/:hostId/:runId",
      PullRequest: "pr/:hostId/:runId",
    },
  },
};

function Main({ setup }: { setup: Setup }) {
  const scheme = useColorScheme();
  const c = scheme === "dark" ? dark : light;
  const base = scheme === "dark" ? DarkTheme : DefaultTheme;
  const theme = {
    ...base,
    colors: {
      ...base.colors,
      primary: c.accent,
      background: c.background,
      card: c.surface,
      text: c.foreground,
      border: c.border,
      notification: c.markCoral,
    },
    fonts: {
      regular: { fontFamily: "System", fontWeight: "400" as const },
      medium: { fontFamily: "System", fontWeight: "500" as const },
      bold: { fontFamily: "System", fontWeight: "600" as const },
      heavy: { fontFamily: "System", fontWeight: "700" as const },
    },
  };
  return (
    <FleetProvider setup={setup}>
      <NavigationContainer ref={nav} theme={theme} linking={linking}>
        <Alerts />
        <LightboxHost />
        <Stack.Navigator
          screenOptions={{ headerBackButtonDisplayMode: "minimal" }}
        >
          <Stack.Screen name="Tabs" component={Home} options={{ headerShown: false }} />
          <Stack.Screen name="Thread" component={ThreadScreen} />
          <Stack.Screen name="PullRequest" component={PullRequestScreen} />
          <Stack.Screen
            name="ThreadDetails"
            component={ThreadDetailsScreen}
            options={{ presentation: "formSheet", title: "Thread details", sheetAllowedDetents: [0.6, 0.95] }}
          />
          <Stack.Screen name="Computer" component={ComputerScreen} />
          <Stack.Screen
            name="NewThread"
            component={NewThreadScreen}
            options={{ presentation: "formSheet", title: "New thread", sheetAllowedDetents: [0.92] }}
          />
          <Stack.Screen
            name="AddComputer"
            component={AddComputerScreen}
            options={{ presentation: "formSheet", headerShown: false, sheetAllowedDetents: [0.92] }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </FleetProvider>
  );
}

/**
 * A development build's shortcut for the simulator, which scripts can't tap: with
 * EXPO_PUBLIC_DEV_COMPUTER set to a computer's address, it skips the account and finds the
 * computers from that one. A release build inlines `__DEV__` as false and drops it.
 */
const devComputer = __DEV__ ? process.env.EXPO_PUBLIC_DEV_COMPUTER : undefined;

function Gate() {
  const { user } = useAccount();
  const [setup, setSetup] = useState(loadSetup);
  useEffect(() => {
    if (devComputer && setup.machines.length === 0)
      void probe(devComputer).then((machines) => {
        const next = { machines, defaultId: machines[0]?.id };
        saveSetup(next);
        setSetup(next);
      });
  }, []);
  if (user === undefined) return <Loading />;
  if (!user && !devComputer) return <SignIn />;
  if (setup.machines.length === 0)
    return (
      <Onboarding
        onDone={(next) => {
          saveSetup(next);
          setSetup(next);
        }}
      />
    );
  return <Main setup={setup} />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AccountProvider>
        <Gate />
      </AccountProvider>
    </SafeAreaProvider>
  );
}
