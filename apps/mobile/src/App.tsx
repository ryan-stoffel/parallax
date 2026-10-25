// The app: sign in, then onboarding until a computer is found, then the shell Claude's app has.
// The main view is always one thread, or a new thread's page, with no back stack of threads. A
// swipe right anywhere on it, or its header's sidebar button, slides the sidebar (Sidebar.tsx) in
// from the left, pushing the main view along. Search, Settings, and the pull requests rise as
// sheets up to just below the notch that drag away, and what they open rises as another sheet
// over them, with a back chevron. The connections, thread lists, and transcripts are the desktop
// renderer's (fleet.tsx).
import {
  CommonActions,
  createNavigationContainerRef,
  DarkTheme,
  DefaultTheme,
  getStateFromPath,
  NavigationContainer,
  type LinkingOptions,
} from "@react-navigation/native";
import { createNativeStackNavigator, type NativeStackNavigationOptions } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { ChevronLeft, Info, X } from "lucide-react-native";
import { useContext, useEffect, useRef, useState } from "react";
import { Linking, StatusBar, StyleSheet, useColorScheme, useWindowDimensions, View } from "react-native";
import { Drawer, useDrawerProgress } from "react-native-drawer-layout";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { interpolate, useAnimatedStyle } from "react-native-reanimated";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AccountProvider, SignIn, useAccount } from "./Account";
import { useFleet, FleetProvider } from "./fleet";
import { GlassButton, SidebarIcon } from "./Glass";
import { loadSetup, probe, saveSetup, type Setup } from "./machines";
import { SidebarControl, type Screens } from "./nav";
import { NewThreadScreen, StartThreadScreen } from "./NewThread";
import { Loading, Onboarding } from "./Onboarding";
import { PullRequestList, PullRequestScreen } from "./PullRequests";
import { alertFor, notify, onOpened, phaseOf, type Phase } from "./push";
import { LightboxHost } from "./Lightbox";
import { getPrefs } from "./prefs";
import { SearchScreen } from "./Search";
import { AboutScreen, AddComputerScreen, ComputerScreen, SettingsScreen } from "./Settings";
import { ComputerSettingsScreen } from "./SettingsComputer";
import { ProviderScreen } from "./SettingsProviders";
import { Sidebar, SidebarSky, sidebarWidth } from "./Sidebar";
import { ThreadDetailsScreen } from "./ThreadDetails";
import { dark, light, type Colors } from "./theme";
import { ThreadScreen } from "./Thread";
import { Icon, useColors } from "./ui";
import { UsageScreen } from "./Usage";

const Stack = createNativeStackNavigator<Screens>();
const nav = createNavigationContainerRef<Screens>();

/** The main view's header button that opens the sidebar: a sidebar's mark in a glass circle. */
function SidebarButton() {
  const c = useColors();
  const { open } = useContext(SidebarControl);
  return (
    <GlassButton label="Open sidebar" onPress={open}>
      <SidebarIcon color={c.foreground} />
    </GlassButton>
  );
}

/**
 * The main view's header: no title and no line, with only the glass sidebar button on the left
 * (the back button when something is pushed over it) and the thread's own glass menu on the right.
 * A new thread's page makes it transparent itself (NewThread.tsx).
 */
const mainHeader: NativeStackNavigationOptions = {
  title: "",
  headerLeft: ({ canGoBack }) => (canGoBack ? null : <SidebarButton />),
  headerLeftBackgroundVisible: false,
  headerShadowVisible: false,
};

/**
 * Every sheet's look, as Claude's app raises Search and Settings: up to just below the notch, a
 * grabber that drags it away, and a clear header with no line, its buttons our own glass circles.
 * A form sheet sizes only the scroll view at the root of its screen (react-native-screens), so
 * each such screen is a scroll view, or a header view then one, with
 * `contentInsetAdjustmentBehavior="automatic"`, which keeps its rows clear of the header and the
 * home indicator.
 */
const sheet = (c: Colors): NativeStackNavigationOptions => ({
  presentation: "formSheet",
  sheetAllowedDetents: [1],
  sheetGrabberVisible: true,
  headerTransparent: true,
  headerShadowVisible: false,
  headerLeftBackgroundVisible: false,
  headerRightBackgroundVisible: false,
  contentStyle: { backgroundColor: c.background },
});

/**
 * The same look for a sheet whose screen doesn't keep clear of a clear header yet (the pull
 * requests, and Add computer): its header on the sheet's background with no line, as a page sheet,
 * which drags away but draws no grabber. It takes `sheet` once its root scroll view has
 * `contentInsetAdjustmentBehavior="automatic"`.
 */
const pageSheet = (c: Colors): NativeStackNavigationOptions => ({
  presentation: "modal",
  headerShadowVisible: false,
  headerStyle: { backgroundColor: c.background },
  headerLeftBackgroundVisible: false,
  headerRightBackgroundVisible: false,
  contentStyle: { backgroundColor: c.background },
});

/** A sheet's glass close button. */
function CloseButton({ onPress }: { onPress: () => void }) {
  return (
    <GlassButton label="Close" onPress={onPress}>
      <Icon icon={X} size={20} />
    </GlassButton>
  );
}

/** A sheet opened over another sheet's glass back chevron, which returns to the one under it. */
const back = ({ navigation }: { navigation: { goBack: () => void } }): NativeStackNavigationOptions => ({
  headerLeft: () => (
    <GlassButton label="Back" onPress={() => navigation.goBack()}>
      <Icon icon={ChevronLeft} size={22} />
    </GlassButton>
  ),
});

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
        if (owner && nav.isReady())
          nav.reset({ index: 0, routes: [{ name: "Thread", params: { hostId: owner, runId } }] });
      }),
    [],
  );
  return null;
}

/** The link that opens the sidebar, the threads view, over whatever the main view shows. */
const THREADS = "parallax://threads";

/**
 * Links into the app: `parallax://threads` opens the sidebar, and `prs`, `usage`, `settings`,
 * and `search` their sheets; `parallax://thread/<computer>/<thread>` a thread, its details at
 * `details/<computer>/<thread>`, a computer's settings at `computer/<computer>` and its pages at
 * `computer/<computer>/<page>`, and a thread's pull request at
 * `parallax://pr/<computer>/<thread>?url=<its URL>`; a new thread's picker at `new` and its page
 * at `new/<computer>/<repo>`. A thread or a new thread's page becomes the main view.
 */
const linking: LinkingOptions<Screens> = {
  prefixes: ["parallax://"],
  config: {
    // A link to a sheet opens it over a new thread's page, so closing it leaves a main view.
    initialRouteName: "StartThread",
    screens: {
      Thread: "thread/:hostId/:runId",
      ThreadDetails: "details/:hostId/:runId",
      Computer: "computer/:id",
      ComputerSettings: "computer/:id/:page",
      PullRequest: "pr/:hostId/:runId",
      PullRequests: "prs",
      Usage: "usage",
      Settings: "settings",
      Search: "search",
      NewThread: "new",
      StartThread: "new/:hostId/:groupId",
    },
  },
  // A launch: a thread or a new thread's page is the main view alone, with nothing to go back to.
  getStateFromPath(path, options) {
    const state = getStateFromPath(path, options);
    const route = state?.routes[state.routes.length - 1];
    return route && (route.name === "Thread" || route.name === "StartThread")
      ? { routes: [{ name: route.name, params: route.params }] }
      : state;
  },
  // An open app: a thread or a new thread's page becomes the main view, and anything else opens
  // over it. The link's state starts at `initialRouteName`, so its own screen is the last.
  getActionFromState(state) {
    const route = state.routes[state.routes.length - 1];
    if (!route) return undefined;
    return route.name === "Thread" || route.name === "StartThread"
      ? CommonActions.reset({ index: 0, routes: [{ name: route.name, params: route.params }] })
      : CommonActions.navigate(route.name, route.params);
  },
};

/**
 * The sidebar around the main stack. A swipe right anywhere on the main view opens it, and a
 * swipe left or a tap on the main view closes it, while the main view is at its root; a screen
 * pushed over it swipes back instead. A new main view closes it.
 */
function Shell({ children }: { children: React.ReactNode }) {
  const c = useColors();
  const scheme = useColorScheme();
  const { width } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const opened = useRef(false);
  const [depth, setDepth] = useState(0);
  const root = useRef<string>(undefined);
  const drawerWidth = sidebarWidth(width);

  const toggle = (next: boolean) => {
    if (next && !opened.current) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      if (nav.isReady()) root.current = nav.getRootState()?.routes[0]?.key;
    }
    opened.current = next;
    setOpen(next);
  };

  useEffect(() => {
    void Linking.getInitialURL().then((url) => url === THREADS && toggle(true));
    const sub = Linking.addEventListener("url", ({ url }) => url === THREADS && toggle(true));
    // The stack's root changing is a new main view, which closes the sidebar.
    const unsubscribe = nav.addListener("state", ({ data }) => {
      const key = data.state?.routes[0]?.key;
      if (opened.current && key !== root.current) toggle(false);
      root.current = key;
      setDepth(data.state?.index ?? 0);
    });
    return () => {
      sub.remove();
      unsubscribe();
    };
  }, []);

  return (
    <SidebarControl value={{ open: () => toggle(true), close: () => toggle(false) }}>
      <StatusBar barStyle={open ? "light-content" : "default"} animated />
      <View style={{ flex: 1, backgroundColor: c.background }}>
      <SidebarSky />
      <Drawer
        open={open}
        onOpen={() => toggle(true)}
        onClose={() => toggle(false)}
        drawerType="slide"
        drawerStyle={{ width: drawerWidth, backgroundColor: "transparent" }}
        // The dim is the main view's own (`Rounded`), so it rounds with it; the overlay only closes.
        overlayStyle={{ backgroundColor: "transparent" }}
        style={{ backgroundColor: "transparent" }}
        overlayAccessibilityLabel="Close sidebar"
        swipeEnabled={depth === 0}
        swipeEdgeWidth={width}
        // Closed, only a swipe right opens it, so a swipe left still scrolls what's under it. Open,
        // only the main view's strip closes it, so a thread's row can still swipe to archive.
        configureGestureHandler={(pan) =>
          open
            ? pan.activeOffsetX(-5).failOffsetX(5).hitSlop({ right: 0, width: width - drawerWidth })
            : pan.activeOffsetX(5).failOffsetX(-5)
        }
        renderDrawerContent={() => <Sidebar />}
      >
        <Rounded dim={scheme === "dark" ? "rgba(0, 0, 0, 0.5)" : "rgba(14, 12, 40, 0.18)"}>{children}</Rounded>
      </Drawer>
      </View>
    </SidebarControl>
  );
}

/**
 * The main view, whose corners round as the sidebar slides it aside, as the screen's own are, and
 * which dims as it goes.
 */
function Rounded({ dim, children }: { dim: string; children: React.ReactNode }) {
  const progress = useDrawerProgress();
  const round = useAnimatedStyle(() => ({ borderRadius: interpolate(progress.value, [0, 1], [0, 48]) }));
  const shade = useAnimatedStyle(() => ({ opacity: progress.value }));
  return (
    <Animated.View style={[{ flex: 1, overflow: "hidden", borderCurve: "continuous" }, round]}>
      {children}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: dim }, shade]} />
    </Animated.View>
  );
}

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
        <Shell>
          <Stack.Navigator screenOptions={{ headerBackButtonDisplayMode: "minimal" }}>
            <Stack.Screen name="StartThread" component={StartThreadScreen} options={mainHeader} />
            <Stack.Screen
              name="Thread"
              component={ThreadScreen}
              // The bar is the page's own color, so it reads as no bar. A new thread's page turns
              // into its thread in place, with no slide.
              options={({ route }) => ({
                ...mainHeader,
                headerStyle: { backgroundColor: c.background },
                animation: route.params?.instant ? "none" : "default",
              })}
            />
            <Stack.Screen
              name="PullRequest"
              component={PullRequestScreen}
              // Pushed on a thread it slides in; opened from a sheet it rises as a sheet of its own.
              options={(props) => {
                const routes = props.navigation.getState().routes;
                const at = routes.findIndex((r) => r.key === props.route.key);
                const inSheet = routes.slice(0, at).some((r) => r.name !== "Thread" && r.name !== "StartThread");
                return inSheet ? { ...pageSheet(c), ...back(props) } : {};
              }}
            />
            <Stack.Screen
              name="ThreadDetails"
              component={ThreadDetailsScreen}
              // Its header stays solid, as its screen lays out under one, on the sheet's background.
              options={{
                ...sheet(c),
                headerTransparent: false,
                headerStyle: { backgroundColor: c.background },
                title: "Thread details",
                sheetAllowedDetents: [0.6, 0.95],
              }}
            />
            <Stack.Screen name="NewThread" component={NewThreadScreen} options={{ ...sheet(c), headerShown: false }} />
            <Stack.Screen name="Search" component={SearchScreen} options={{ ...sheet(c), headerShown: false }} />
            <Stack.Screen
              name="Settings"
              component={SettingsScreen}
              options={({ navigation }) => ({
                ...sheet(c),
                title: "Settings",
                headerLeft: () => <CloseButton onPress={() => navigation.goBack()} />,
                headerRight: () => (
                  <GlassButton label="About Parallax" onPress={() => navigation.navigate("About")}>
                    <Icon icon={Info} size={20} />
                  </GlassButton>
                ),
              })}
            />
            <Stack.Screen
              name="PullRequests"
              component={PullRequestList}
              options={({ navigation }) => ({
                ...pageSheet(c),
                title: "Pull requests",
                headerLeft: () => <CloseButton onPress={() => navigation.goBack()} />,
              })}
            />
            <Stack.Screen name="About" component={AboutScreen} options={(p) => ({ ...sheet(c), ...back(p), title: "About" })} />
            {/* Its refresh button is the screen's own (Usage.tsx). */}
            <Stack.Screen name="Usage" component={UsageScreen} options={(p) => ({ ...sheet(c), ...back(p), title: "Usage" })} />
            <Stack.Screen name="Computer" component={ComputerScreen} options={(p) => ({ ...sheet(c), ...back(p) })} />
            <Stack.Screen
              name="ComputerSettings"
              component={ComputerSettingsScreen}
              options={(p) => ({ ...sheet(c), ...back(p) })}
            />
            <Stack.Screen name="Provider" component={ProviderScreen} options={(p) => ({ ...sheet(c), ...back(p) })} />
            <Stack.Screen
              name="AddComputer"
              component={AddComputerScreen}
              options={(p) => ({ ...pageSheet(c), ...back(p), title: "" })}
            />
          </Stack.Navigator>
        </Shell>
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
  const [setup, setSetup] = useState<Setup>();
  useEffect(() => {
    void loadSetup().then(async (loaded) => {
      if (!devComputer || loaded.machines.length) return setSetup(loaded);
      const machines = await probe(devComputer).catch(() => []);
      const next = { machines, defaultId: machines[0]?.id };
      saveSetup(next);
      setSetup(next);
    });
  }, []);
  if (user === undefined || !setup) return <Loading />;
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
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AccountProvider>
          <Gate />
        </AccountProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
