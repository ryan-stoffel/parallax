import { Cloud, GitBranch } from "lucide-react";

import type { RemoteControlSession } from "../protocol/generated/protocol";
import { ClaudeLogo, GitHubLogo } from "./logos";
import { remoteControlLook } from "./remoteControl";
import { menuItem } from "./ui";

/** The name Parallax gives these threads wherever it marks them. */
const NAME = "Claude Remote Control";

/** A Claude Remote Control thread's mark beside its provider's logo, as the sidebar shows it. */
export function RemoteControlBadge({ className = "size-3.5" }: { className?: string }) {
  return (
    <span title={NAME} role="img" aria-label={NAME} className="flex shrink-0">
      <Cloud aria-hidden className={className} />
    </span>
  );
}

/** The state's dot, in its color, pulsing while Claude works. */
function StateDot({ session }: { session?: RemoteControlSession }) {
  const look = session?.state && remoteControlLook[session.state];
  return (
    <span
      aria-hidden
      className={`size-1.5 shrink-0 rounded-full ${look?.dot ?? "bg-faint-foreground/45"} ${look?.pulse ? "animate-pulse" : ""}`}
    />
  );
}

/** Open in Claude: the session at `claude.ai/code`, in the browser. */
function OpenInClaude({ url, className }: { url: string; className: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" title="Open in Claude" className={className}>
      <ClaudeLogo aria-hidden />
      Open in Claude
    </a>
  );
}

/**
 * The composer's tab for a Claude Remote Control thread: Remote Control, what the session is
 * doing, and what that means for a message, with Open in Claude, where a prompt waiting on the
 * user can be answered. `compact` is the cloud and the state's dot, for a place beside other tabs.
 */
export function RemoteControlTab({
  session,
  compact = false,
}: {
  session?: RemoteControlSession;
  compact?: boolean;
}) {
  const look = session?.state && remoteControlLook[session.state];
  if (compact)
    return (
      <span
        title={look ? `${NAME}: ${look.label}` : NAME}
        className="flex h-7 items-center gap-1.5 px-1.5 text-muted-foreground [&_svg]:size-3.5"
      >
        <Cloud aria-hidden />
        <StateDot session={session} />
      </span>
    );
  return (
    <section
      aria-label={NAME}
      className="flex min-w-0 items-center gap-2 py-0.5 pr-1 pl-3 text-body [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      <Cloud aria-hidden className="text-muted-foreground" />
      <span className="shrink-0 font-medium">Remote Control</span>
      {look && (
        <>
          <StateDot session={session} />
          <span className="shrink-0">{look.label}</span>
          {look.detail && (
            <span className="min-w-0 truncate text-muted-foreground">{look.detail}</span>
          )}
        </>
      )}
      {session && (
        <OpenInClaude
          url={session.url}
          className="ml-auto flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 font-medium text-foreground hover:bg-hover"
        />
      )}
    </section>
  );
}

/**
 * Thread details' section for a Claude Remote Control thread: that it is one, what the session is
 * doing, the repository and branch it works in on its own computer, and Open in Claude.
 */
export function RemoteControlSection({ session }: { session?: RemoteControlSession }) {
  const look = session?.state && remoteControlLook[session.state];
  const row = "flex min-w-0 items-center gap-2 px-2 py-1 text-body";
  return (
    <section aria-label={NAME} className="border-b border-border p-2">
      <div className="flex items-center gap-2 px-2 py-1.5 text-body font-medium">
        <span className="relative flex shrink-0">
          <ClaudeLogo aria-hidden />
          <span className="absolute -right-2 -bottom-2 grid size-4 place-items-center rounded-full border border-border bg-surface text-muted-foreground">
            <Cloud aria-hidden className="!size-2.5" strokeWidth={2.5} />
          </span>
        </span>
        <span className="ml-1 truncate">{NAME}</span>
      </div>
      {look && (
        <div className={row} title={look.detail}>
          <span className="grid size-4 shrink-0 place-items-center">
            <StateDot session={session} />
          </span>
          <span className="truncate">{look.label}</span>
        </div>
      )}
      {session?.repository && (
        <div className={row} title={session.repository}>
          <GitHubLogo aria-hidden className="shrink-0 text-muted-foreground" />
          <span className="truncate">{session.repository}</span>
        </div>
      )}
      {session?.branch && (
        <div className={row} title={session.branch}>
          <GitBranch aria-hidden className="shrink-0 text-muted-foreground" />
          <span className="truncate">{session.branch}</span>
        </div>
      )}
      {session && <OpenInClaude url={session.url} className={`${menuItem} [&_svg]:!size-4`} />}
    </section>
  );
}
