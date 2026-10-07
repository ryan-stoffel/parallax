import { ChevronDown, Folder, FolderGit2, Laptop, Server } from "lucide-react";

import { useId, type ToggleEvent } from "react";

import { DeviceIcon } from "./DeviceIcon";
import { localId, type Host } from "./hosts";
import { MenuOption, menuButton, menuHeading, menuPanel, moveFocus, type PickerOption } from "./ui";

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
  host.icon ? <DeviceIcon icon={host.icon} /> : host.destination ? <Server /> : <Laptop />;

/**
 * Where a thread runs: which of Parallax's computers, and in a new worktree or the local checkout.
 * The menu stays open while you pick both. The computer and the workspace are the caller's, which
 * starts the thread on that computer with that workspace; `checkoutUnavailable`, when set, says why
 * Local checkout can't be picked. `missing` names the computers, by id, that lack the picked
 * repository, which say so.
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
  const host = hosts.find((h) => h.id === hostId) ?? hosts[0]!;
  const workspace = workspaces.find((w) => w.value === workspaceChoice)!;
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
      <div
        id={id}
        popover="auto"
        role="menu"
        aria-label="Runs on"
        onToggle={(e: ToggleEvent<HTMLDivElement>) => {
          if (e.newState === "open")
            e.currentTarget.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
        }}
        onKeyDown={moveFocus}
        className={`${menuPanel()} w-[26rem] p-1`}
      >
        <div role="group" aria-label="Computer">
          <p aria-hidden className={menuHeading}>
            Computer
          </p>
          {hosts.map((h) => (
            <MenuOption
              key={h.id}
              option={{
                value: h.id,
                label: h.name,
                icon: hostIcon(h),
                hint: missing?.hostIds.has(h.id)
                  ? `no ${missing.repo}`
                  : h.id === localId
                    ? "this one"
                    : undefined,
              }}
              checked={h === host}
              onClick={() => onHostChange(h.id)}
            />
          ))}
          {hosts.length === 1 && (
            <p className="px-2 pt-0.5 pb-1.5 text-[12px] text-faint-foreground">
              Computers you add under Hosts show up here.
            </p>
          )}
        </div>
        <div role="separator" className="-mx-1 my-1 h-px bg-border" />
        <div role="group" aria-label="Workspace">
          <p aria-hidden className={menuHeading}>
            Workspace
          </p>
          {workspaces.map((w) => {
            const unavailable = w.value === "checkout" ? checkoutUnavailable : undefined;
            return (
              <MenuOption
                key={w.value}
                option={unavailable ? { ...w, hint: unavailable } : w}
                checked={w === workspace}
                disabled={!!unavailable}
                onClick={() => onWorkspaceChange(w.value)}
              />
            );
          })}
        </div>
      </div>
    </>
  );
}
