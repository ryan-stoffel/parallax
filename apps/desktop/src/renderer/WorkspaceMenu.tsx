import { ChevronDown, Folder, FolderPlus, FolderSearch, Search } from "lucide-react";
import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type ToggleEvent,
} from "react";

import type { ConnectionState } from "../preload/bridge";
import type { Repo } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import { localId, type Host } from "./hosts";
import { GitHubLogo } from "./logos";
import { hostIcon } from "./RunTargetMenu";
import {
  MenuOption,
  menuButton,
  menuHeading,
  menuItem,
  menuPanel,
  moveFocus,
  unavailableBadge,
} from "./ui";

/** A repository on one of Parallax's hosts: where a Project works. */
export type Workspace = { hostId: string; repo: Repo };

/** What the menu knows of a host's repositories, or why it can't list them. */
type Listing =
  | { status: "connecting" }
  | { status: "listing" }
  | { status: "unreachable"; message: string }
  | { status: "failed"; message: string }
  | { status: "listed"; repos: Repo[] };

/**
 * Each host's repo entries, scratch left out. While `open`, every connected host is asked with
 * `thread/list`, and a host that connects meanwhile is asked then. Each host answers on its own,
 * so one that is slow or down never holds up the others.
 */
function useListings(hosts: Host[], open: boolean): Readonly<Record<string, Listing>> {
  const [listings, setListings] = useState<Readonly<Record<string, Listing>>>({});
  const ids = hosts.map((h) => h.id).join("\n");
  useEffect(() => {
    if (!open) return;
    let stopped = false;
    const set = (hostId: string, next: (prev?: Listing) => Listing) => {
      if (!stopped) setListings((all) => ({ ...all, [hostId]: next(all[hostId]) }));
    };
    const list = async (hostId: string, state: ConnectionState) => {
      if (state.status === "connecting") return set(hostId, () => ({ status: "connecting" }));
      if (state.status === "failed")
        return set(hostId, () => ({ status: "unreachable", message: state.error.message }));
      // A host listed before keeps its repositories in view while it's asked again.
      set(hostId, (prev) => (prev?.status === "listed" ? prev : { status: "listing" }));
      const answer = await window.parallax.request(hostId, "thread/list", {});
      set(hostId, () =>
        "error" in answer
          ? { status: "failed", message: describeError(answer.error) }
          : { status: "listed", repos: answer.result.repos.filter((r) => !r.scratch) },
      );
    };
    const hostIds = ids.split("\n");
    const stop = window.parallax.onConnectionState((hostId, state) => {
      if (hostIds.includes(hostId)) void list(hostId, state);
    });
    // It rejects only for a host just removed, which the next render leaves out.
    for (const hostId of hostIds)
      window.parallax.connectionState(hostId).then(
        (state) => list(hostId, state),
        () => {},
      );
    return () => {
      stopped = true;
      stop();
    };
  }, [open, ids]);
  return listings;
}

/**
 * Create Project's Workspace picker. Its button shows the chosen repository and its host's icon.
 * Its menu searches the repositories of every host at once, and groups them by host: this
 * computer, then the SSH hosts, then GitHub. A host that is connecting or can't be reached says
 * so in its own group. This computer's group ends with "Choose folder…", which calls
 * `onChooseFolder`; browsing an SSH host and cloning from GitHub aren't available yet.
 */
export function WorkspaceMenu({
  hosts,
  value,
  onChange,
  onChooseFolder,
}: {
  hosts: Host[];
  value?: Workspace;
  onChange: (workspace: Workspace) => void;
  onChooseFolder: () => void;
}) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listings = useListings(hosts, open);
  const host = value && hosts.find((h) => h.id === value.hostId);

  const q = query.trim().toLowerCase();
  const groups = hosts.map((h) => {
    const listing = listings[h.id];
    const repos = listing?.status === "listed" ? listing.repos : [];
    return { host: h, listing, repos: repos.filter((r) => r.name.toLowerCase().includes(q)) };
  });
  // A search shows only the hosts with a match.
  const shown = q ? groups.filter((g) => g.repos.length > 0) : groups;

  const choose = (workspace: Workspace) => {
    menu.current?.hidePopover();
    onChange(workspace);
  };

  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        aria-haspopup="menu"
        aria-label={
          value && host ? `Workspace: ${value.repo.name} on ${host.name}` : "Workspace: none"
        }
        className={`${menuButton} min-w-0`}
      >
        {host ? hostIcon(host) : <Folder />}
        <span className="truncate">{value?.repo.name ?? "Choose a workspace"}</span>
        <ChevronDown aria-hidden className="opacity-70" />
      </button>
      <div
        ref={menu}
        id={id}
        popover="auto"
        role="menu"
        aria-label="Workspace"
        onToggle={(e: ToggleEvent<HTMLDivElement>) => {
          setOpen(e.newState === "open");
          if (e.newState === "open") searchBox.current?.focus();
          else setQuery("");
        }}
        onKeyDown={moveFocus}
        // At most the room under its button, which is 100% of its position area, less its gap
        // above and the same below. So it drops down under the row rather than over the dialog.
        className={`${menuPanel("end")} max-h-[calc(100%-1rem)] w-80 flex-col overflow-hidden p-0 [&:popover-open]:flex`}
      >
        <label className="flex items-center gap-2 border-b border-border px-3 py-2.5 focus-within:border-ring">
          <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
          <input
            ref={searchBox}
            type="search"
            aria-label="Search repositories"
            placeholder="Search repositories"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              // Enter picks the first match, and never submits the dialog's form.
              e.preventDefault();
              const first = shown[0];
              if (first?.repos[0]) choose({ hostId: first.host.id, repo: first.repos[0] });
            }}
            className="min-w-0 flex-1 bg-transparent text-[13.5px] placeholder:text-faint-foreground focus-visible:outline-none"
          />
        </label>
        <div className="max-h-96 min-h-0 overflow-y-auto p-1">
          {shown.map((g, i) => (
            <Fragment key={g.host.id}>
              {i > 0 && <div role="separator" className="-mx-1 my-1 h-px bg-border" />}
              <div role="group" aria-label={g.host.name}>
                <p aria-hidden className={menuHeading}>
                  {g.host.name}
                </p>
                {g.repos.map((repo) => (
                  <MenuOption
                    key={repo.id}
                    option={{ value: repo.id, label: repo.name, icon: <Folder /> }}
                    checked={value?.hostId === g.host.id && value.repo.id === repo.id}
                    onClick={() => choose({ hostId: g.host.id, repo })}
                  />
                ))}
                {!q && <ListingNote listing={g.listing} />}
                {!q &&
                  (g.host.id === localId ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        menu.current?.hidePopover();
                        onChooseFolder();
                      }}
                      className={menuItem}
                    >
                      <FolderPlus aria-hidden />
                      <span className="leading-5">Choose folder…</span>
                    </button>
                  ) : (
                    <Unavailable icon={<FolderSearch aria-hidden />} label="Browse folders" />
                  ))}
              </div>
            </Fragment>
          ))}
          {!q && (
            <>
              <div role="separator" className="-mx-1 my-1 h-px bg-border" />
              <div role="group" aria-label="GitHub">
                <p aria-hidden className={menuHeading}>
                  GitHub
                </p>
                <Unavailable icon={<GitHubLogo />} label="Clone a repository" />
              </div>
            </>
          )}
          {q && shown.length === 0 && (
            <p className="px-2 py-1.5 text-[12.5px] text-faint-foreground">No matches</p>
          )}
        </div>
      </div>
    </>
  );
}

/** A host's state under its repositories, while it has none to show or is still asking. */
function ListingNote({ listing }: { listing?: Listing }) {
  let note: string;
  if (!listing || listing.status === "listing") note = "Loading…";
  else if (listing.status === "connecting") note = "Connecting…";
  else if (listing.status === "unreachable") note = `Can't connect: ${listing.message}`;
  else if (listing.status === "failed") note = `Can't list its repositories: ${listing.message}`;
  else if (listing.repos.length === 0) note = "No repositories yet";
  else return null;
  return (
    <p title={note} className="line-clamp-3 px-2 pt-0.5 pb-1.5 text-[12px] text-faint-foreground">
      {note}
    </p>
  );
}

/** A way to add a repository that Parallax can't offer yet: disabled, with a badge that says so. */
function Unavailable({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled
      className={`${menuItem} disabled:bg-transparent disabled:opacity-60`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate leading-5">{label}</span>
      <span className={unavailableBadge}>Not available yet</span>
    </button>
  );
}
