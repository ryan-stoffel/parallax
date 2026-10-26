import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  GitPullRequest,
  Laptop,
  LoaderCircle,
  Server,
  Smartphone,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";

import { NPM_INSTALLS, type Profile } from "../preload/bridge";
import type { ProviderInfo } from "../protocol/generated/protocol";
import { SecuredByClerk } from "./Account";
import { useConnection } from "./ConnectionStatus";
import { describeError } from "./errors";
import { localId, useHosts } from "./hosts";
import { bindingsOf, formatKeybinding, type Command } from "./keybindings";
import { ClaudeLogo, CursorLogo, OpenAILogo, OpenCodeLogo, ParallaxMark } from "./logos";
import { dismiss, notify } from "./notifications";
import { agents, finishOnboarding, infoOf, ready, setUpAgents, type Agent } from "./firstRun";
import { Avatar, useProfile } from "./profile";
import { kindOf, loadProviders, useProviders } from "./providers";
import { ImportStepBody } from "./ImportSessions";
import { capitalized } from "./settings/shared";
import { IconButton } from "./ui";

const SignInTerminal = lazy(() =>
  import("./SignInTerminal").then((m) => ({ default: m.SignInTerminal })),
);

const steps = ["Account", "Agents", "Import", "Tour", "Start"];

/** The tour's step, whose arrows and Back move between its slides. */
const tourStep = steps.indexOf("Tour");

const bigPrimary =
  "flex items-center justify-center gap-1.5 rounded-lg bg-send px-4 py-2 text-body font-medium text-send-foreground enabled:hover:opacity-90 disabled:opacity-50 [&_svg]:size-4";
const bigOutline =
  "flex items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-4 py-2 text-body font-medium hover:bg-hover disabled:opacity-50";
const quiet =
  "flex items-center gap-1 rounded-lg px-3 py-2 text-body text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4";
const small =
  "shrink-0 rounded-md border border-border bg-surface px-2.5 py-1 text-body font-medium hover:bg-hover";

/**
 * First-launch onboarding (PLX-806), a native modal <dialog> open while it's mounted: a Parallax
 * account, then this computer's agents, set up as it finds them, then importing past sessions
 * from other apps (PLX-881), then a tour, then a first thread.
 * Finishing, skipping, or Escape ends it for good; Start a thread then calls `onStart`.
 */
export function Onboarding({ onStart }: { onStart: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [step, setStep] = useState(0);
  const [slide, setSlide] = useState(0);
  const profile = useProfile();
  const host = useHosts()[0]!;
  const providers = useProviders(localId)?.providers;
  useEffect(() => {
    dialog.current?.showModal();
    // showModal focuses the first button, Skip setup, and draws its ring before anyone has typed.
    // The dialog holds focus instead, so Tab starts at its first button with nothing lit at rest.
    dialog.current?.focus();
  }, []);

  // The tour's layers lean with the pointer: --px and --py, each -1 to 1, on the dialog.
  const lean = (e: PointerEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty(
      "--px",
      ((e.clientX - box.left) / box.width - 0.5).toFixed(3),
    );
    e.currentTarget.style.setProperty(
      "--py",
      ((e.clientY - box.top) / box.height - 0.5).toFixed(3),
    );
  };
  const finish = (start: boolean) => {
    dialog.current?.close();
    if (start) onStart();
  };
  const next = () => setStep((s) => s + 1);

  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      aria-labelledby={titleId}
      onClose={finishOnboarding}
      onPointerMove={lean}
      onKeyDown={(e) => {
        if (step !== tourStep) return;
        if (e.key === "ArrowRight" && slide < tour.length - 1) setSlide(slide + 1);
        if (e.key === "ArrowLeft" && slide > 0) setSlide(slide - 1);
      }}
      className="m-auto h-[37rem] max-h-[92vh] w-[44rem] max-w-[94vw] overflow-hidden rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/40 backdrop:backdrop-blur-sm focus-visible:outline-none"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between gap-4 px-5 pt-4">
          <span className="flex w-28 items-center gap-1.5 font-brand text-body font-semibold text-muted-foreground">
            <ParallaxMark className="size-4" />
            Parallax
          </span>
          <ol
            aria-label={`Step ${step + 1} of ${steps.length}: ${steps[step]}`}
            className="flex gap-1.5"
          >
            {steps.map((name, i) => (
              <li
                key={name}
                aria-hidden
                className={`h-1 rounded-full transition-all duration-300 ${i === step ? "w-8 bg-accent" : i < step ? "w-4 bg-accent/50" : "w-4 bg-selected"}`}
              />
            ))}
          </ol>
          <span className="flex w-28 justify-end">
            <IconButton label="Skip setup" onClick={() => finish(false)}>
              <X aria-hidden />
            </IconButton>
          </span>
        </header>

        <div key={step} className="onboard-step min-h-0 flex-1 overflow-y-auto px-12 pt-6 pb-4">
          {step === 0 ? (
            <AccountStep titleId={titleId} profile={profile} onSignedIn={next} />
          ) : step === 1 ? (
            <AgentsStep titleId={titleId} hostName={host.name} />
          ) : step === 2 ? (
            <ImportStep titleId={titleId} />
          ) : step === tourStep ? (
            <Tour titleId={titleId} slide={slide} onSlide={setSlide} />
          ) : (
            <DoneStep titleId={titleId} profile={profile} providers={providers} />
          )}
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-border px-5 py-3">
          {step > 0 ? (
            <button
              type="button"
              onClick={() =>
                step === tourStep && slide > 0 ? setSlide(slide - 1) : setStep(step - 1)
              }
              className={quiet}
            >
              <ArrowLeft aria-hidden />
              Back
            </button>
          ) : (
            <span />
          )}
          {step === 0 ? (
            profile ? (
              <button type="button" onClick={next} className={bigPrimary}>
                Continue
                <ArrowRight aria-hidden />
              </button>
            ) : (
              <button type="button" onClick={next} className={quiet}>
                Not now
              </button>
            )
          ) : step < tourStep ? (
            <button type="button" onClick={next} className={bigPrimary}>
              Continue
              <ArrowRight aria-hidden />
            </button>
          ) : step === tourStep ? (
            <button
              type="button"
              onClick={() => (slide < tour.length - 1 ? setSlide(slide + 1) : next())}
              className={bigPrimary}
            >
              {slide < tour.length - 1 ? "Next" : "Continue"}
              <ArrowRight aria-hidden />
            </button>
          ) : (
            <span className="flex gap-2">
              <button type="button" onClick={() => finish(false)} className={quiet}>
                Explore on my own
              </button>
              <button type="button" autoFocus onClick={() => finish(true)} className={bigPrimary}>
                Start a thread
                <ArrowRight aria-hidden />
              </button>
            </span>
          )}
        </footer>
      </div>
    </dialog>
  );
}

/** The two circles of the logo, gliding together. */
function Hero() {
  const clip = useId();
  return (
    <div className="relative mb-5 grid size-20 place-items-center">
      <svg viewBox="0 0 24 24" aria-hidden className="onboard-mark relative size-18">
        <clipPath id={clip}>
          <circle cx="9.5" cy="9.5" r="7" className="blue" />
        </clipPath>
        <circle cx="9.5" cy="9.5" r="7" className="blue fill-mark-blue" />
        <circle cx="14.5" cy="14.5" r="7" className="coral fill-mark-coral" />
        <circle
          cx="14.5"
          cy="14.5"
          r="7"
          clipPath={`url(#${clip})`}
          className="coral fill-mark-overlap"
        />
      </svg>
    </div>
  );
}

/**
 * Step one: create a Parallax account, or sign in, on Clerk's page in the browser (0067). Signing
 * in here moves on by itself once the profile arrives.
 */
function AccountStep({
  titleId,
  profile,
  onSignedIn,
}: {
  titleId: string;
  profile: Profile | null | undefined;
  onSignedIn: () => void;
}) {
  const [waiting, setWaiting] = useState(false);
  const [asked, setAsked] = useState(false);
  const [note, setNote] = useState<string>();
  // Only the latest sign-in's answer shows: a replaced one answers "cancelled" late.
  const latest = useRef(0);
  const signIn = async (create: boolean) => {
    const n = ++latest.current;
    setAsked(true);
    setWaiting(true);
    setNote(undefined);
    const answer = await window.parallax.signIn(create);
    if (n !== latest.current) return;
    setWaiting(false);
    setNote(answer);
  };
  // Signed in from here: a moment to see the welcome, then on.
  const signedIn = !!profile && asked;
  useEffect(() => {
    if (!signedIn) return;
    const timer = setTimeout(onSignedIn, 1400);
    return () => clearTimeout(timer);
  }, [signedIn, onSignedIn]);

  return (
    <div className="flex flex-col items-center pt-4 text-center">
      <Hero />
      <h1 id={titleId} className="text-display font-semibold tracking-tight">
        Welcome to Parallax
      </h1>
      <p className="mt-2 max-w-md text-reading text-muted-foreground">
        Run Claude Code, Codex, Cursor, and more side by side, on every computer you use.
      </p>
      {profile ? (
        <div className="onboard-rise mt-9 flex items-center gap-3 rounded-xl border border-border bg-surface py-3 pr-5 pl-3 text-left">
          <Avatar profile={profile} size={40} />
          <div className="min-w-0">
            <p className="truncate text-reading font-medium">
              {profile.firstName ? `Welcome, ${profile.firstName}` : "You're signed in"}
            </p>
            <p className="truncate text-body text-muted-foreground">{profile.email}</p>
          </div>
          <Check aria-hidden className="ml-2 size-5 text-added" />
        </div>
      ) : (
        <div className="mt-9 flex w-80 flex-col gap-2">
          <button type="button" onClick={() => void signIn(true)} className={bigPrimary}>
            Create your Parallax account
          </button>
          <button type="button" onClick={() => void signIn(false)} className={bigOutline}>
            I already have an account
          </button>
          <p role="status" className="mt-2 min-h-10 text-body text-muted-foreground">
            {waiting
              ? "Finish in your browser, then come back here."
              : (note ?? "Your account links your computers and your phone to Parallax.")}
          </p>
        </div>
      )}
      <div className="mt-auto pt-6">
        <SecuredByClerk />
      </div>
    </div>
  );
}

/** A step's heading and the line under it. */
function Heading({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <div className="mb-5">
      <h1 id={id} className="text-display font-semibold tracking-tight">
        {title}
      </h1>
      <p className="mt-1 text-body text-muted-foreground">{children}</p>
    </div>
  );
}

/**
 * Says why setting up, installing, or signing in to an agent failed, when it did, and closes that
 * once one works.
 */
function agentFailed(title: string, error: string | undefined) {
  if (error) notify({ key: "onboarding-agent", tone: "error", title, body: error });
  else dismiss("onboarding-agent");
}

/**
 * Step two: this computer's agents (`agents`), set up as they're found (`setUpAgents`). Each
 * installed and signed in is on without a click; one signed out offers Sign in, and one that
 * isn't installed offers Install, after which it's set up again.
 */
function AgentsStep({ titleId, hostName }: { titleId: string; hostName: string }) {
  const connection = useConnection(localId);
  const providers = useProviders(localId)?.providers;
  // Until the first setup ends, a row plxd hasn't probed yet is still looking.
  const [scanned, setScanned] = useState(false);
  // The agent installing in the background (npm, Cursor's SDK), if any.
  const [working, setWorking] = useState<string>();
  // The one terminal, as main runs one sign-in terminal per window: a sign-in, or an install.
  const [terminal, setTerminal] = useState<{ agent: Agent; install: boolean }>();
  const [cursorWaiting, setCursorWaiting] = useState(false);

  // setUpAgents runs one at a time, so a sign-in's never races the first.
  const setUp = useCallback((refresh: boolean) => {
    void setUpAgents(localId, refresh).then((failed) => {
      agentFailed("Couldn't set up your agents", failed);
      setScanned(true);
    });
  }, []);
  const connected = connection?.status === "connected";
  useEffect(() => {
    if (connected) setUp(false);
  }, [connected, setUp]);

  // While plxd installs one, or Cursor's browser sign-in waits, list again every two seconds;
  // once either ends, set up again, which turns the agent on.
  const installing = agents.some((a) => infoOf(providers, a)?.installing);
  const cursor = infoOf(
    providers,
    agents.find((a) => a.kind === "cursor")!,
  );
  useEffect(() => {
    if (!installing && !cursorWaiting) return;
    const timer = setInterval(() => void loadProviders(localId, cursorWaiting), 2000);
    return () => clearInterval(timer);
  }, [installing, cursorWaiting]);
  const wasInstalling = useRef(false);
  useEffect(() => {
    if (wasInstalling.current && !installing) setUp(true);
    wasInstalling.current = installing;
  }, [installing, setUp]);
  useEffect(() => {
    if (!cursorWaiting) return;
    if (cursor?.signedIn === true) {
      setCursorWaiting(false);
      setUp(false);
    } else if (cursor?.signInError) {
      setCursorWaiting(false);
      agentFailed("Couldn't sign in to Cursor", cursor.signInError);
    }
  }, [cursorWaiting, cursor, setUp]);

  const install = async (agent: Agent) => {
    const background = agent.kind === "cursor" || NPM_INSTALLS[agent.kind];
    if (!background) return setTerminal({ agent, install: true });
    setWorking(agent.id);
    let failed: string | undefined;
    if (agent.kind === "cursor") {
      const answer = await window.parallax.request(localId, "cursor/install", {});
      if ("error" in answer) failed = describeError(answer.error);
    } else failed = await window.parallax.install(localId, agent.kind);
    setWorking(undefined);
    if (failed) agentFailed(`Couldn't install ${agent.name}`, failed);
    else setUp(true);
  };
  const signIn = async (agent: Agent, info: ProviderInfo) => {
    // Cursor signs in in the browser, unless the instance runs on its own CURSOR_API_KEY.
    if (agent.kind !== "cursor" || info.instance.env.some((v) => v.name === "CURSOR_API_KEY"))
      return setTerminal({ agent, install: false });
    const answer = await window.parallax.request(localId, "cursor/signIn", {
      instance: info.instance.id,
    });
    if ("error" in answer)
      return agentFailed(`Couldn't sign in to ${agent.name}`, describeError(answer.error));
    window.open(answer.result.url, "_blank");
    setCursorWaiting(true);
  };

  const count = providers?.filter((p) => p.instance.enabled && ready(p)).length ?? 0;
  const terminalInfo = terminal && infoOf(providers, terminal.agent);

  return (
    <>
      <Heading id={titleId} title="Your agents">
        {!scanned
          ? `Looking for coding agents on ${hostName}…`
          : count > 0
            ? `${count === 1 ? "One is" : `${count} are`} ready on ${hostName}, and on for every thread. Add more any time in Settings.`
            : `None are ready on ${hostName} yet. Install or sign in to one to start a thread.`}
      </Heading>
      {connection?.status === "failed" ? (
        <p role="alert" className="rounded-xl border border-border bg-surface px-4 py-3 text-body">
          Parallax couldn't start on {hostName}. You can set up agents later in Settings &gt;
          Providers.
        </p>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-border bg-surface">
          {agents.map((agent, i) => {
            const info = infoOf(providers, agent);
            const Logo = kindOf(agent.kind).Logo;
            const looking = !scanned && !info;
            let line: string;
            let action: ReactNode = null;
            if (looking) {
              line = "Looking…";
              action = <Spinner />;
            } else if (working === agent.id || info?.installing) {
              line = info?.note ?? `Installing ${agent.name}…`;
              action = <Spinner />;
            } else if (agent.kind === "cursor" && cursorWaiting) {
              line = "Approve the sign-in in your browser.";
              action = (
                <button type="button" onClick={() => setCursorWaiting(false)} className={small}>
                  Cancel
                </button>
              );
            } else if (info && ready(info)) {
              line = info.account ? `Ready · ${capitalized(info.account)}` : "Ready";
              action = (
                <span className="onboard-pop flex shrink-0 items-center gap-1 rounded-full bg-added/15 px-2.5 py-1 text-meta font-medium text-added [&_svg]:size-3.5">
                  <Check aria-hidden />
                  Set up
                </span>
              );
            } else if (info?.installed) {
              line = "Installed, but not signed in";
              action =
                info.login || agent.kind === "cursor" ? (
                  <button
                    type="button"
                    aria-label={`Sign in to ${agent.name}`}
                    disabled={!!terminal}
                    onClick={() => void signIn(agent, info)}
                    className={small}
                  >
                    Sign in
                  </button>
                ) : null;
            } else {
              line = `${agent.blurb} · Not installed`;
              action = (
                <button
                  type="button"
                  aria-label={`Install ${agent.name}`}
                  disabled={!!terminal || !!working}
                  onClick={() => void install(agent)}
                  className={`${small} text-muted-foreground`}
                >
                  Install
                </button>
              );
            }
            return (
              <li
                key={agent.id}
                style={{ animationDelay: `${i * 50}ms` }}
                className="onboard-rise flex items-center gap-3 border-border px-4 py-2.5 not-last:border-b"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-background">
                  <Logo className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-baseline gap-2">
                    <span className="text-body font-medium">{agent.name}</span>
                    {info?.version && (
                      <span className="truncate font-mono text-meta text-faint-foreground">
                        {info.version}
                      </span>
                    )}
                  </p>
                  <p
                    className={`truncate text-body text-muted-foreground ${looking ? "onboard-scan" : ""}`}
                  >
                    {line}
                  </p>
                </div>
                {action}
              </li>
            );
          })}
        </ul>
      )}
      {terminal && (
        <div className="mt-4 overflow-hidden rounded-xl border border-border bg-surface">
          <Suspense>
            <SignInTerminal
              target={
                terminal.install || !terminalInfo
                  ? { hostId: localId, install: terminal.agent.kind }
                  : { hostId: localId, provider: terminalInfo.instance.id }
              }
              name={terminal.agent.name}
              onExit={() => setUp(true)}
              onClose={() => setTerminal(undefined)}
            />
          </Suspense>
        </div>
      )}
    </>
  );
}

/**
 * Step three: past sessions from the Claude, Codex, and Cursor apps, or chats from a ChatGPT or
 * Claude export, to pick and import.
 */
function ImportStep({ titleId }: { titleId: string }) {
  return (
    <div className="flex h-full flex-col">
      <Heading id={titleId} title="Bring your history">
        Pick past sessions from the Claude, Codex, and Cursor apps. Each lands in Archived as a
        thread you can pick up again. Find this in Settings &gt; Threads.
      </Heading>
      <ImportStepBody className="onboard-rise min-h-0 flex-1" />
    </div>
  );
}

function Spinner() {
  return (
    <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin text-faint-foreground" />
  );
}

/** A layer of the tour's stage, shifted with the pointer by `depth` pixels at the edge. */
function Layer({
  depth,
  className = "",
  children,
}: {
  depth: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{ "--depth": `${depth}px` } as CSSProperties}
      className={`onboard-layer absolute inset-0 ${className}`}
    >
      {children}
    </div>
  );
}

/** Rises in after `delay` milliseconds. */
const after = (delay: number): CSSProperties => ({ animationDelay: `${delay}ms` });

/** Three threads at work on one repository, a card each, fanned out at different depths. */
function Parallel() {
  const threads = [
    {
      Logo: ClaudeLogo,
      title: "Fix the login redirect",
      at: "left-[6%] top-[22%] -rotate-6",
      depth: 10,
    },
    { Logo: OpenAILogo, title: "Add rate limiting", at: "left-[33%] top-[10%]", depth: 22 },
    {
      Logo: CursorLogo,
      title: "Write the API tests",
      at: "left-[60%] top-[24%] rotate-6",
      depth: 14,
    },
  ];
  return (
    <>
      {threads.map(({ Logo, title, at, depth }, i) => (
        <Layer key={title} depth={depth}>
          <div
            style={after(i * 120)}
            className={`onboard-rise absolute w-[11.5rem] rounded-xl border border-border bg-surface p-3 shadow-composer ${at}`}
          >
            <p className="mb-2.5 flex items-center gap-2 text-meta font-medium">
              <Logo className="size-3.5 shrink-0" />
              <span className="truncate">{title}</span>
              <span className="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-working" />
            </p>
            {[92, 74, 56].map((width, line) => (
              <span
                key={line}
                style={{ width: `${width}%` }}
                className="mb-1.5 block h-1.5 overflow-hidden rounded-full bg-selected"
              >
                <span
                  style={after(i * 300 + line * 500)}
                  className="onboard-bar block h-full rounded-full bg-accent/70"
                />
              </span>
            ))}
          </div>
        </Layer>
      ))}
      <Layer depth={34} className="flex items-end justify-center pb-[9%]">
        <span
          style={after(500)}
          className="onboard-pop flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-meta font-medium whitespace-nowrap shadow-composer"
        >
          <span className="size-1.5 animate-pulse rounded-full bg-working" />3 threads, 3 worktrees
        </span>
      </Layer>
    </>
  );
}

/** A coordinator handing a Project's work to three agents, each checking off in turn. */
function Delegate() {
  // In the stage's 400 by 240 viewBox, stretched to fill it, so the nodes' percentages match.
  const children = [
    { Logo: ClaudeLogo, name: "Plan the API", x: 80, y: 180 },
    { Logo: OpenAILogo, name: "Build it", x: 200, y: 195 },
    { Logo: OpenCodeLogo, name: "Test it", x: 320, y: 180 },
  ];
  const pos = (x: number, y: number) => ({ left: `${x / 4}%`, top: `${y / 2.4}%` });
  return (
    <>
      <Layer depth={8}>
        <svg viewBox="0 0 400 240" preserveAspectRatio="none" className="size-full" aria-hidden>
          {children.map(({ name, x, y }, i) => (
            <path
              key={name}
              d={`M200 78 C200 130 ${x} 120 ${x} ${y - 14}`}
              pathLength={1}
              style={after(200 + i * 150)}
              className="onboard-draw fill-none stroke-accent/50"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          ))}
        </svg>
      </Layer>
      <Layer depth={24}>
        <div
          style={pos(200, 60)}
          className="onboard-pop absolute -translate-1/2 rounded-xl border border-border bg-surface px-4 py-2.5 shadow-composer"
        >
          <p className="flex items-center gap-2 text-body font-semibold">
            <ParallaxMark className="size-5" />
            Coordinator
          </p>
          <p className="mt-0.5 text-meta text-muted-foreground">Ship the billing API</p>
        </div>
      </Layer>
      <Layer depth={16}>
        {children.map(({ Logo, name, x, y }, i) => (
          <div key={name} style={pos(x, y)} className="absolute -translate-1/2">
            <span
              style={after(700 + i * 150)}
              className="onboard-pop flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-meta font-medium shadow-composer"
            >
              <Logo className="size-3.5" />
              {name}
              <span
                style={after(1400 + i * 400)}
                className="onboard-pop grid size-4 place-items-center rounded-full bg-added text-white [&_svg]:size-2.5"
              >
                <Check aria-hidden strokeWidth={3} />
              </span>
            </span>
          </div>
        ))}
      </Layer>
    </>
  );
}

/** A thread's diff writing itself, and its pull request, ready. */
function Review() {
  const lines: [" " | "+" | "-", string][] = [
    [" ", "export async function refresh(session) {"],
    ["-", "  const token = await fetchToken();"],
    ["+", "  const token = await fetchToken({ retry: 3 });"],
    ["+", "  if (!token) return signOut(session);"],
    [" ", "  session.token = token;"],
    ["+", "  session.expiresAt = expiry(token);"],
  ];
  return (
    <>
      <Layer depth={10}>
        <div className="onboard-rise absolute top-[10%] left-1/2 w-[24rem] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface font-mono text-caption shadow-composer">
          <p className="flex items-center justify-between border-b border-border px-3 py-2 font-sans text-meta font-medium">
            src/session.ts
            <span className="font-mono text-caption">
              <span className="text-added">+3</span> <span className="text-danger">−1</span>
            </span>
          </p>
          {lines.map(([mark, text], i) => (
            <p
              key={i}
              style={after(250 + i * 140)}
              className={`onboard-rise truncate px-3 py-[3px] ${mark === "+" ? "bg-added/10 text-added" : mark === "-" ? "bg-danger/10 text-danger" : "text-muted-foreground"}`}
            >
              <span className="mr-2 opacity-60">{mark}</span>
              {text}
            </p>
          ))}
        </div>
      </Layer>
      <Layer depth={30}>
        <span
          style={after(1300)}
          className="onboard-pop absolute right-[8%] bottom-[8%] flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-meta font-medium shadow-composer [&_svg]:size-4"
        >
          <GitPullRequest aria-hidden className="text-added" />
          Pull request #128
          <span className="rounded-full bg-added/15 px-2 py-0.5 text-caption text-added">
            Checks passed
          </span>
        </span>
      </Layer>
    </>
  );
}

/** This computer, a server, and a phone, in touch. */
function Anywhere() {
  const devices: { Icon: LucideIcon; name: string; note: string; depth: number }[] = [
    { Icon: Server, name: "build-box", note: "Over SSH", depth: 10 },
    { Icon: Laptop, name: "This computer", note: "3 threads", depth: 24 },
    { Icon: Smartphone, name: "Your phone", note: "Following along", depth: 14 },
  ];
  return (
    <>
      <Layer depth={6}>
        <div className="absolute top-1/2 right-[18%] left-[18%] h-px border-t border-dashed border-accent/40">
          {[0, 1].map((i) => (
            <span
              key={i}
              style={after(i * 1100)}
              className="onboard-travel absolute -top-[3px] size-1.5 rounded-full bg-accent"
            />
          ))}
        </div>
      </Layer>
      {devices.map(({ Icon, name, note, depth }, i) => (
        <Layer key={name} depth={depth}>
          <div
            style={{ left: `${18 + i * 32}%`, ...after(i * 150) }}
            className={`onboard-pop absolute top-1/2 flex -translate-1/2 flex-col items-center rounded-xl border border-border bg-surface shadow-composer ${i === 1 ? "px-6 py-4" : "px-4 py-3"}`}
          >
            <Icon aria-hidden className={`text-accent ${i === 1 ? "size-8" : "size-6"}`} />
            <p className="mt-2 text-meta font-medium whitespace-nowrap">{name}</p>
            <p className="text-caption text-muted-foreground">{note}</p>
          </div>
        </Layer>
      ))}
    </>
  );
}

const tour = [
  {
    title: "Every agent, side by side",
    body: "Start Claude Code, Codex, and Cursor on the same repository at once. Each thread works in a worktree of its own, so they never step on each other.",
    Scene: Parallel,
  },
  {
    title: "Projects that plan themselves",
    body: "Give a Project a goal. Its coordinator splits the work, hands each piece to an agent, and checks what comes back.",
    Scene: Delegate,
  },
  {
    title: "Review, then ship",
    body: "Every change is a diff you can read before it lands, and a pull request is a click away, right beside the thread.",
    Scene: Review,
  },
  {
    title: "On any computer, even your phone",
    body: "Run agents on a server over SSH or on your other computers with Parallax Connect, and follow along from your phone.",
    Scene: Anywhere,
  },
];

/** Step four: what Parallax does, a slide each, its scene's layers leaning with the pointer. */
function Tour({
  titleId,
  slide,
  onSlide,
}: {
  titleId: string;
  slide: number;
  onSlide: (slide: number) => void;
}) {
  const { title, body, Scene } = tour[slide]!;
  return (
    <div>
      <div className="relative h-64 overflow-hidden rounded-xl border border-border bg-sidebar">
        <Layer depth={-8} className="onboard-dots">
          <span className="onboard-glow absolute top-[-20%] left-[10%] size-48 rounded-full bg-mark-blue/25 blur-3xl" />
          <span className="onboard-glow absolute right-[5%] bottom-[-30%] size-48 rounded-full bg-mark-coral/25 blur-3xl [animation-delay:-3s]" />
        </Layer>
        <div key={slide} className="absolute inset-0">
          <Scene />
        </div>
      </div>
      <div key={`text-${slide}`} className="onboard-rise mt-6">
        <h1 id={titleId} className="text-display font-semibold tracking-tight">
          {title}
        </h1>
        <p className="mt-1.5 max-w-xl text-body text-muted-foreground">{body}</p>
      </div>
      <div role="tablist" aria-label="Tour" className="mt-5 flex gap-1.5">
        {tour.map((s, i) => (
          <button
            key={s.title}
            type="button"
            role="tab"
            aria-selected={i === slide}
            aria-label={s.title}
            onClick={() => onSlide(i)}
            className={`h-1.5 rounded-full transition-all duration-300 ${i === slide ? "w-6 bg-foreground" : "w-1.5 bg-faint-foreground/40 hover:bg-faint-foreground"}`}
          />
        ))}
      </div>
    </div>
  );
}

/** A command's first binding, as a key cap. */
function Keys({ command, name }: { command: Command; name: string }) {
  const binding = bindingsOf(command)[0];
  if (!binding) return null;
  return (
    <span className="flex items-center gap-2 text-body text-muted-foreground">
      <kbd className="rounded-md border border-border bg-surface px-1.5 py-0.5 font-sans text-meta text-foreground shadow-[0_1px_0_var(--border)]">
        {formatKeybinding(binding)}
      </kbd>
      {name}
    </span>
  );
}

/** Step five: what's set up, the keys worth knowing, and Start a thread. */
function DoneStep({
  titleId,
  profile,
  providers,
}: {
  titleId: string;
  profile: Profile | null | undefined;
  providers: ProviderInfo[] | undefined;
}) {
  const on = providers?.filter((p) => p.instance.enabled && ready(p)) ?? [];
  const card =
    "onboard-rise flex items-center gap-3 rounded-xl border border-border bg-surface p-4";
  return (
    <div className="flex flex-col items-center pt-4 text-center">
      <svg aria-hidden viewBox="0 0 16 16" className="plan-check-draw mb-5 size-16 text-added">
        <circle cx="8" cy="8" r="7.5" fill="currentColor" opacity="0.16" />
        <path
          d="M4.9 8.3 7.1 10.4 11.2 5.9"
          pathLength={1}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <h1 id={titleId} className="text-display font-semibold tracking-tight">
        {profile?.firstName ? `You're all set, ${profile.firstName}` : "You're all set"}
      </h1>
      <p className="mt-2 max-w-md text-body text-muted-foreground">
        Pick a folder and tell an agent what to build. Start as many threads as you like.
      </p>
      <div className="mt-8 grid w-full max-w-lg grid-cols-2 gap-3 text-left">
        <div style={after(150)} className={card}>
          {profile ? (
            <Avatar profile={profile} size={32} />
          ) : (
            <ParallaxMark className="size-8 shrink-0" />
          )}
          <div className="min-w-0">
            <p className="truncate text-body font-medium">
              {profile ? profile.name || profile.email : "No account yet"}
            </p>
            <p className="truncate text-meta text-muted-foreground">
              {profile ? "Parallax account" : "Sign in from the profile menu"}
            </p>
          </div>
        </div>
        <div style={after(250)} className={card}>
          {on.length ? (
            <span className="flex shrink-0 -space-x-2">
              {on.slice(0, 4).map((p) => {
                const Logo = kindOf(p.instance.kind).Logo;
                return (
                  <span
                    key={p.instance.id}
                    className="grid size-8 place-items-center rounded-full border-2 border-surface bg-background"
                  >
                    <Logo className="size-4" />
                  </span>
                );
              })}
            </span>
          ) : (
            <Bot aria-hidden className="size-8 shrink-0 text-faint-foreground" />
          )}
          <div className="min-w-0">
            <p className="truncate text-body font-medium">
              {on.length === 1 ? "1 agent ready" : `${on.length} agents ready`}
            </p>
            <p className="truncate text-meta text-muted-foreground">
              {on.length ? on.map((p) => p.instance.name).join(", ") : "Add one in Settings"}
            </p>
          </div>
        </div>
      </div>
      <div
        style={after(400)}
        className="onboard-rise mt-8 flex flex-wrap justify-center gap-x-6 gap-y-2"
      >
        <Keys command="newThread" name="New thread" />
        <Keys command="panel" name="Side panel" />
        <Keys command="settings" name="Settings" />
      </div>
    </div>
  );
}
