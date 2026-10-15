import { Check, ChevronDown, Folder, FolderGit2, Laptop, Search, Server } from "lucide-react";

import { useId, useState } from "react";

import { useConnection } from "./ConnectionStatus";

import { DeviceIcon } from "./DeviceIcon";
import { localId, type Host } from "./hosts";
import { Menu, MenuOption, menuButton, menuHeading, menuItem, type PickerOption } from "./ui";

/** Where a new thread works: a worktree of its own, or the repository's own checkout. */
export type Workspace = "worktree" | "checkout";

export const workspaces: (PickerOption & { value: Workspace })[] = [
  {
    value: "worktree",
    label: "New worktree",
    icon: <FolderGit2 />,
    description: "A fresh branch and folder, so your checkout stays as it is.",
  },
  {
    value: "checkout",
    label: "Local checkout",
    icon: <Folder />,
    description: "Right in the repository, on the branch you have out.",
  },
];

/**
 * A host's icon: its Parallax Connect icon (0056), else a laptop for this computer and a server
 * for an SSH host.
 */
export const hostIcon = (host: Host) =>
  host.icon ? (
    <DeviceIcon icon={host.icon} />
  ) : host.destination || host.routes ? (
    <Server />
  ) : (
    <Laptop />
  );

/** How a computer is reached, under its name. */
export const connection = (host: Host) =>
  host.id === localId
    ? "This computer"
    : host.destination
      ? `SSH · ${host.destination}`
      : host.routes
        ? "Same network"
        : "Parallax Connect";

/** Past this many computers, the menu adds a search box. */
const searchFrom = 7;

/** A computer's row: its icon with a dot for whether it's connected, its name, and how it's reached. */
function HostOption({
  host,
  checked,
  missing,
  onClick,
}: {
  host: Host;
  checked: boolean;
  missing?: string;
  onClick: () => void;
}) {
  const status = useConnection(host.id)?.status;
  const offline = status === "failed";
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onClick={onClick}
      className={`${menuItem} [&_svg]:size-4`}
    >
      <span
        className={`relative grid h-5 place-items-center ${offline ? "text-faint-foreground" : ""}`}
      >
        {hostIcon(host)}
        <span
          aria-hidden
          className={`absolute -right-0.5 -bottom-0.5 size-[7px] rounded-full ring-2 ring-surface ${status === "connected" ? "bg-added" : status === "connecting" ? "bg-warning" : "bg-faint-foreground"}`}
        />
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className={`shrink-0 truncate ${offline ? "text-muted-foreground" : ""}`}>
          {host.name}
        </span>
        <span className="truncate text-[12px] text-faint-foreground">
          {offline ? "Offline" : connection(host)}
        </span>
      </span>
      {missing && (
        <span className="shrink-0 rounded-[5px] bg-warning/12 px-1.5 text-[11.5px] leading-5 text-warning">
          no {missing}
        </span>
      )}
      <span className={`grid h-5 place-items-center ${checked ? "" : "invisible"}`}>
        <Check aria-hidden className="size-3.5! text-accent" />
      </span>
    </button>
  );
}

/**
 * Where a thread runs: which of Parallax's computers, and in a new worktree or the local checkout.
 * The menu stays open while you pick both. The computer and the workspace are the caller's, which
 * starts the thread on that computer with that workspace; `checkoutUnavailable`, when set, says why
 * Local checkout can't be picked. `missing` names the computers, by id, that lack the picked
 * repository, which say so. Each computer shows whether it's connected, the list scrolls, and past
 * a handful of computers a search box filters them.
 */
export function RunTargetMenu({
  hosts,
  hostId,
  onHostChange,
  workspace: workspaceChoice,
  onWorkspaceChange,
  checkoutUnavailable,
  missing,
}: {
  hosts: Host[];
  hostId: string;
  onHostChange: (hostId: string) => void;
  workspace: Workspace;
  onWorkspaceChange: (workspace: Workspace) => void;
  checkoutUnavailable?: string;
  missing?: { repo: string; hostIds: ReadonlySet<string> };
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const host = hosts.find((h) => h.id === hostId) ?? hosts[0]!;
  const workspace = workspaces.find((w) => w.value === workspaceChoice)!;
  const searchable = hosts.length >= searchFrom;
  const q = query.trim().toLowerCase();
  const shown = q ? hosts.filter((h) => h.name.toLowerCase().includes(q)) : hosts;
  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        aria-haspopup="menu"
        aria-label={`Runs on: ${host.name}, ${workspace.label}`}
        className={menuButton}
      >
        {hostIcon(host)}
        {host.name}
        <span aria-hidden className="text-faint-foreground">
          ·
        </span>
        {workspace.label}
        <ChevronDown aria-hidden className="opacity-70" />
      </button>
      <Menu
        id={id}
        label="Runs on"
        className="w-80 overflow-hidden p-0"
        focus={searchable ? "input" : '[aria-checked="true"]'}
        onClose={() => setQuery("")}
      >
        {searchable && (
          <label className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
            <input
              type="search"
              aria-label="Search computers"
              placeholder="Search computers..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shown[0]) onHostChange(shown[0].id);
              }}
              className="min-w-0 flex-1 bg-transparent text-[13px] placeholder:text-faint-foreground focus-visible:outline-none"
            />
          </label>
        )}
        <div role="group" aria-label="Computer" className="p-1">
          <p aria-hidden className={menuHeading}>
            Computer
          </p>
          <div className="max-h-72 overflow-y-auto">
            {shown.map((h) => (
              <HostOption
                key={h.id}
                host={h}
                checked={h === host}
                missing={missing?.hostIds.has(h.id) ? missing.repo : undefined}
                onClick={() => onHostChange(h.id)}
              />
            ))}
          </div>
          {shown.length === 0 && (
            <p className="px-2 py-1.5 text-[12.5px] text-faint-foreground">No matches</p>
          )}
          {hosts.length === 1 && (
            <p className="px-2 pt-0.5 pb-1.5 text-[12px] text-faint-foreground">
              Computers you add under Hosts show up here.
            </p>
          )}
        </div>
        <div role="group" aria-label="Workspace" className="border-t border-border p-1">
          <p aria-hidden className={menuHeading}>
            Workspace
          </p>
          {workspaces.map((w) => (
            <MenuOption
              key={w.value}
              option={{ value: w.value, label: w.label, icon: w.icon }}
              checked={w === workspace}
              disabled={w.value === "checkout" && !!checkoutUnavailable}
              onClick={() => onWorkspaceChange(w.value)}
            />
          ))}
          {checkoutUnavailable && (
            <p className="px-2 pt-0.5 pb-1.5 text-[12px] text-faint-foreground">
              Local checkout {checkoutUnavailable}.
            </p>
          )}
        </div>
      </Menu>
    </>
  );
}
