import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  initialAutoDecisions,
  initialChat,
  initialChildren,
  initialDecisions,
  initialLanded,
  initialMemory,
  projects as initialProjects,
  type AutoDecision,
  type ChatMessage,
  type Child,
  type Decision,
  type Landed,
  type MemoryEntry,
  type Project,
} from "./data";

export type Tab = "home" | "threads" | "knowledge" | "ship";
export type Route =
  | { name: "projects" }
  | { name: "project"; id: string; tab: Tab; child?: string }
  | { name: "thread"; id: string };

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

export interface Settings {
  model: string;
  effort: string;
  permission: string;
  host: string;
}

const now = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function titleFrom(text: string) {
  const words = text.split("@")[0].replace(/\s+/g, " ").trim().split(" ").slice(0, 7).join(" ");
  const t = words.replace(/[.?!,;:]+$/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// Follows an explicit data-theme on <html> first, then the OS.
function initialTheme(): "dark" | "light" {
  const set = document.documentElement.dataset.theme;
  if (set === "dark" || set === "light") return set;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

const pickHost = (n: number) => ["studio", "devbox", "macbook"][n % 3];

function useStoreValue() {
  const [route, setRoute] = useState<Route>({ name: "project", id: "parallax", tab: "home" });
  const [theme, setTheme] = useState<"dark" | "light">(initialTheme);
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [children, setChildren] = useState<Child[]>(initialChildren);
  const [decisions, setDecisions] = useState<Decision[]>(initialDecisions);
  const [autoDecisions, setAutoDecisions] = useState<AutoDecision[]>(initialAutoDecisions);
  const [memory, setMemory] = useState<MemoryEntry[]>(initialMemory);
  const [chat, setChat] = useState<ChatMessage[]>(initialChat);
  const [landed, setLanded] = useState<Landed[]>(initialLanded);
  const [landing, setLanding] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [railOpen, setRailOpen] = useState(true);
  const [digestOpen, setDigestOpen] = useState(true);
  const [brief, setBrief] = useState(initialProjects[0].brief);
  const [settings, setSettings] = useState<Settings>({
    model: "Opus 5.5",
    effort: "High",
    permission: "Auto",
    host: "auto",
  });
  const spawned = useRef(0);
  const toastId = useRef(0);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  // Working children move through their steps so the views feel live.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setChildren((cs) =>
        cs.map((c) => (c.status === "working" && c.steps.length > 1 ? { ...c, step: (c.step + 1) % c.steps.length, add: c.add + 3 + (c.add % 7) } : c)),
      );
    }, 3200);
    return () => window.clearInterval(timer);
  }, []);

  const toast = useCallback((text: string, action?: Toast["action"]) => {
    const id = ++toastId.current;
    setToasts((ts) => [...ts, { id, text, action }]);
    window.setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4800);
  }, []);
  const dismissToast = (id: number) => setToasts((ts) => ts.filter((t) => t.id !== id));

  const go = useCallback((r: Route) => setRoute(r), []);
  const openChild = useCallback((id: string) => setRoute({ name: "project", id: "parallax", tab: "threads", child: id }), []);

  const startChild = useCallback(
    (text: string) => {
      const n = spawned.current++;
      const id = `new-${n}`;
      const host = settings.host === "auto" ? pickHost(n) : settings.host;
      const account = settings.model.startsWith("GPT") ? "chatgpt-pro" : "claude-max";
      const title = titleFrom(text);
      const child: Child = {
        id,
        title,
        status: "starting",
        summary: "Starting",
        host,
        account,
        model: settings.model,
        branch: `parallax/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32)}`,
        add: 0,
        del: 0,
        age: "now",
        steps: ["Reading the brief and memory index", "Exploring the codebase", "Planning the change", "Editing files", "Running checks"],
        step: 0,
        transcript: [{ kind: "brief", text }],
      };
      setChildren((cs) => [child, ...cs]);
      window.setTimeout(() => {
        setChildren((cs) => cs.map((c) => (c.id === id ? { ...c, status: "working", summary: "Exploring the codebase" } : c)));
      }, 1400);
      toast(`Started "${title}" on ${host}`, { label: "View", run: () => openChild(id) });
    },
    [settings, toast, openChild],
  );

  const ask = useCallback(
    (text: string) => {
      const id = `u-${Date.now()}`;
      setChat((m) => [...m, { id, role: "user", text, time: now() }, { id: `${id}-r`, role: "coordinator", text: "", time: now(), thinking: true }]);
      const lower = text.toLowerCase();
      const reply = lower.includes("status") || lower.includes("progress") || lower.includes("where")
        ? "Three threads are working: the palette on macbook, memory proposals on studio and the scheduler on devbox. Inbox read state is ready to land, and the retry work waits on your answer about resuming downloads. The landing-queue test is queued until Claude quota resets at 3:40 PM."
        : lower.includes("merge") || lower.includes("conflict")
          ? "The palette and memory proposals both touch keybindings.ts. I'll land memory proposals first and ask the palette thread to rebase on the project branch when it finishes."
          : "Noted. I checked memory and the two threads it affects. Nothing running needs to change, and I'll apply it to new threads from here.";
      window.setTimeout(() => {
        setChat((m) => m.map((x) => (x.id === `${id}-r` ? { ...x, text: reply, thinking: false } : x)));
      }, 1600);
    },
    [],
  );

  const answer = useCallback(
    (decisionId: string, label: string) => {
      const d = decisions.find((x) => x.id === decisionId);
      setDecisions((ds) => ds.map((x) => (x.id === decisionId ? { ...x, answer: label } : x)));
      if (!d) return;
      if (decisionId === "d-pr" && label === "Land it") {
        land(d.childId);
        return;
      }
      setChildren((cs) =>
        cs.map((c) =>
          c.id === d.childId
            ? {
                ...c,
                status: "working",
                steps: ["Applying your answer", "Editing src/main/updater.ts", "Running pnpm test updater"],
                step: 0,
                summary: `Going with: ${label}`,
                transcript: [...c.transcript, { kind: "user", text: label }],
              }
            : c,
        ),
      );
      toast(`Sent "${label}" to ${children.find((c) => c.id === d.childId)?.title ?? "the thread"}`);
    },
    [decisions, children, toast],
  );

  const undoAnswer = (decisionId: string) => setDecisions((ds) => ds.map((x) => (x.id === decisionId ? { ...x, answer: undefined } : x)));

  const changeAuto = (id: string) => {
    setAutoDecisions((as) => as.map((a) => (a.id === id ? { ...a, changed: !a.changed } : a)));
  };

  function land(childId: string) {
    setLanding(childId);
    setChildren((cs) => cs.map((c) => (c.id === childId ? { ...c, status: "review", summary: "Landing: running checks" } : c)));
    window.setTimeout(() => {
      setChildren((cs) => {
        const c = cs.find((x) => x.id === childId);
        if (c) {
          const sha = Math.random().toString(16).slice(2, 9);
          setLanded((l) => [...l, { sha, title: c.title, childId, add: c.add, del: c.del, when: "now" }]);
        }
        return cs.map((x) => (x.id === childId ? { ...x, status: "landed", summary: "Landed on the project branch" } : x));
      });
      setDecisions((ds) => ds.map((x) => (x.childId === childId ? { ...x, answer: x.answer ?? "Land it" } : x)));
      setLanding(null);
      toast("Landed on parallax/projects-m4. Checks passed.");
    }, 2600);
  }

  const stopChild = (id: string) => {
    setChildren((cs) => cs.map((c) => (c.id === id ? { ...c, status: "failed", summary: "Stopped by you" } : c)));
    toast("Stopped. The worktree is kept.");
  };
  const retryChild = (id: string) => {
    setChildren((cs) => cs.map((c) => (c.id === id ? { ...c, status: "working", summary: "Retrying", steps: ["Reading the failure", "Editing projectIcons.ts", "Running pnpm test projectIcons"], step: 0 } : c)));
  };
  const messageChild = (id: string, text: string) => {
    setChildren((cs) => cs.map((c) => (c.id === id ? { ...c, transcript: [...c.transcript, { kind: "user", text }], status: c.status === "needs" ? "working" : c.status } : c)));
  };

  const memoryOps = {
    accept: (id: string) => setMemory((m) => m.map((e) => (e.id === id ? { ...e, proposed: false, fresh: true } : e))),
    remove: (id: string) => setMemory((m) => m.filter((e) => e.id !== id)),
    edit: (id: string, text: string) => setMemory((m) => m.map((e) => (e.id === id ? { ...e, text, source: "You", date: "Today", stale: undefined } : e))),
    scope: (id: string, scope: MemoryEntry["scope"]) => setMemory((m) => m.map((e) => (e.id === id ? { ...e, scope } : e))),
    apply: (replaceId: string | null, entry: MemoryEntry) =>
      setMemory((m) => (replaceId ? m.map((e) => (e.id === replaceId ? entry : e)) : [...m, entry])),
  };

  const addProject = (p: Project) => {
    setProjects((ps) => [...ps, p]);
    setRoute({ name: "project", id: p.id, tab: "home" });
  };

  return {
    route,
    go,
    openChild,
    theme,
    setTheme,
    projects,
    addProject,
    children,
    decisions,
    autoDecisions,
    memory,
    memoryOps,
    chat,
    landed,
    landing,
    land,
    toasts,
    toast,
    dismissToast,
    railOpen,
    setRailOpen,
    digestOpen,
    setDigestOpen,
    brief,
    setBrief,
    settings,
    setSettings,
    startChild,
    ask,
    answer,
    undoAnswer,
    changeAuto,
    stopChild,
    retryChild,
    messageChild,
  };
}

type Store = ReturnType<typeof useStoreValue>;
const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const value = useStoreValue();
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const s = useContext(StoreContext);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}
