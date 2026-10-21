// The Chrome extension APIs Electron leaves out (PLX-888), filled in so an extension's background
// gets past its first calls: `storage.sync` and `storage.session` as `storage.local`, the toolbar's
// `action` and the window, menu, and navigation APIs as no-ops or empty events, since Parallax
// draws the toolbar and has one window, and `alarms` on timers. Main
// registers it for the side panel browser's frames and service workers (extensions.ts). It runs
// only in an extension's own pages and workers: a web page gets nothing from it.

import { contextBridge } from "electron";

// A worker's preload runs in a realm of its own with no location, so `fill` checks where it is
// from inside the page or worker.
contextBridge.executeInMainWorld({ func: fill });

// Runs in the extension's own world, so it can use nothing from outside itself.
function fill() {
  type Fn = (...args: unknown[]) => unknown;
  type Api = Record<string, unknown>;
  if (
    (globalThis as { location?: { protocol: string } }).location?.protocol !== "chrome-extension:"
  )
    return;
  const chrome = (globalThis as unknown as { chrome?: Api }).chrome;
  if (!chrome) return;
  // Answers with `value` through a trailing callback and a promise, as Chrome's APIs do.
  const answer =
    (value?: unknown): Fn =>
    (...args) => {
      const callback = args.findLast((a) => typeof a === "function") as Fn | undefined;
      callback?.(value);
      return Promise.resolve(value);
    };
  const event = () => {
    const listeners = new Set<Fn>();
    return {
      addListener: (f: Fn) => void listeners.add(f),
      removeListener: (f: Fn) => void listeners.delete(f),
      hasListener: (f: Fn) => listeners.has(f),
      hasListeners: () => listeners.size > 0,
      dispatch: (...args: unknown[]) => listeners.forEach((f) => f(...args)),
    };
  };
  // Sets what's missing, over a getter too, without touching what Electron has.
  const fillIn = (target: Api, key: string, value: unknown) => {
    if (target[key] !== undefined) return;
    try {
      Object.defineProperty(target, key, { value, configurable: true, writable: true });
    } catch {
      // A frozen namespace stays as it is.
    }
  };
  const namespace = (key: string) => {
    fillIn(chrome, key, {});
    return chrome[key] as Api;
  };

  const storage = chrome["storage"] as Api | undefined;
  if (storage) {
    // Electron defines `sync` but answers every call with "not available", so it's replaced.
    try {
      Object.defineProperty(storage, "sync", { value: storage["local"], configurable: true });
    } catch {
      // A frozen namespace stays as it is.
    }
    fillIn(storage, "session", storage["local"]);
  }

  const extension = namespace("extension");
  fillIn(extension, "isAllowedFileSchemeAccess", answer(false));
  fillIn(extension, "isAllowedIncognitoAccess", answer(false));
  const runtime = namespace("runtime");
  fillIn(runtime, "setUninstallURL", answer());
  fillIn(runtime, "requestUpdateCheck", answer({ status: "no_update" }));
  fillIn(runtime, "getContexts", answer([]));

  const tabs = namespace("tabs");
  // A popup isn't a tab, so Chrome answers it with no tab too.
  fillIn(tabs, "getCurrent", answer(undefined));
  for (const name of ["onActivated", "onUpdated", "onRemoved", "onCreated", "onReplaced"])
    fillIn(tabs, name, event());
  // Electron's query takes a few properties and refuses the window ones every extension passes.
  const query = tabs["query"] as Fn | undefined;
  if (query)
    tabs["query"] = (info: Api = {}, ...rest: unknown[]) => {
      const kept = { ...info };
      for (const key of ["currentWindow", "lastFocusedWindow", "windowId", "windowType"])
        delete kept[key];
      return query.call(tabs, kept, ...rest);
    };

  const action = {
    setBadgeText: answer(),
    setBadgeBackgroundColor: answer(),
    setBadgeTextColor: answer(),
    getBadgeText: answer(""),
    setIcon: answer(),
    setTitle: answer(),
    getTitle: answer(""),
    setPopup: answer(),
    getPopup: answer(""),
    enable: answer(),
    disable: answer(),
    openPopup: answer(),
    getUserSettings: answer({ isOnToolbar: true }),
    onClicked: event(),
  };
  fillIn(chrome, "action", action);
  fillIn(chrome, "browserAction", action);

  const window = { id: 1, focused: true, type: "normal", state: "normal", incognito: false };
  const windows = namespace("windows");
  fillIn(windows, "WINDOW_ID_NONE", -1);
  fillIn(windows, "WINDOW_ID_CURRENT", -2);
  fillIn(windows, "get", answer(window));
  fillIn(windows, "getCurrent", answer(window));
  fillIn(windows, "getLastFocused", answer(window));
  fillIn(windows, "getAll", answer([window]));
  fillIn(windows, "update", answer(window));
  for (const name of ["onFocusChanged", "onCreated", "onRemoved", "onBoundsChanged"])
    fillIn(windows, name, event());

  const navigation = namespace("webNavigation");
  fillIn(navigation, "getFrame", answer(null));
  fillIn(navigation, "getAllFrames", answer([]));
  for (const name of [
    "onBeforeNavigate",
    "onCommitted",
    "onDOMContentLoaded",
    "onCompleted",
    "onErrorOccurred",
    "onCreatedNavigationTarget",
    "onReferenceFragmentUpdated",
    "onHistoryStateUpdated",
    "onTabReplaced",
  ])
    fillIn(navigation, name, event());

  const menus = { create: () => 0, update: answer(), remove: answer(), removeAll: answer() };
  fillIn(chrome, "contextMenus", { ...menus, onClicked: event() });
  fillIn(chrome, "commands", { getAll: answer([]), onCommand: event() });
  fillIn(chrome, "idle", {
    queryState: answer("active"),
    setDetectionInterval: () => {},
    onStateChanged: event(),
  });
  fillIn(chrome, "notifications", {
    create: answer(""),
    clear: answer(true),
    onClicked: event(),
    onClosed: event(),
    onButtonClicked: event(),
  });
  fillIn(chrome, "permissions", {
    contains: answer(true),
    request: answer(true),
    getAll: answer({ permissions: [], origins: [] }),
    onAdded: event(),
    onRemoved: event(),
  });

  // ponytail: alarms live on this context's timers, so a worker that stops loses them; keep them
  // in storage if an extension needs them to outlast its worker.
  const alarms = new Map<string, { name: string; scheduledTime: number; timer: number }>();
  const onAlarm = event();
  fillIn(chrome, "alarms", {
    create(...args: unknown[]) {
      const [name, info] = (typeof args[0] === "string" ? args : ["", args[0]]) as [
        string,
        { when?: number; delayInMinutes?: number; periodInMinutes?: number },
      ];
      clearTimeout(alarms.get(name)?.timer);
      const delay = info.when
        ? info.when - Date.now()
        : (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60_000;
      const fire = () => {
        onAlarm.dispatch({ name, scheduledTime: Date.now() });
        if (info.periodInMinutes) set(info.periodInMinutes * 60_000);
        else alarms.delete(name);
      };
      const set = (ms: number) =>
        alarms.set(name, {
          name,
          scheduledTime: Date.now() + ms,
          timer: setTimeout(fire, Math.max(0, ms)) as unknown as number,
        });
      set(delay);
      return Promise.resolve();
    },
    get: (name: string, ...rest: unknown[]) => {
      const alarm = alarms.get(typeof name === "string" ? name : "");
      return answer(alarm && { name: alarm.name, scheduledTime: alarm.scheduledTime })(...rest);
    },
    getAll: (...rest: unknown[]) =>
      answer([...alarms.values()].map(({ name, scheduledTime }) => ({ name, scheduledTime })))(
        ...rest,
      ),
    clear: (name: string, ...rest: unknown[]) => {
      const key = typeof name === "string" ? name : "";
      clearTimeout(alarms.get(key)?.timer);
      return answer(alarms.delete(key))(...rest);
    },
    clearAll: (...rest: unknown[]) => {
      for (const { timer } of alarms.values()) clearTimeout(timer);
      alarms.clear();
      return answer(true)(...rest);
    },
    onAlarm,
  });
}
