import { ChevronDown, Folder, FolderGit2, Laptop, Server } from "lucide-react";
import { useId, useState } from "react";

import { localId, type Host } from "./hosts";
import { MenuOption, menuButton, menuHeading, menuPanel, moveFocus, type PickerOption } from "./ui";

const workspaces: PickerOption[] = [
  {
    value: "worktree",
    label: "New worktree",
    icon: <FolderGit2 />,
    description: "A fresh branch and folder, so your checkout stays as it is.",
  },
  {
    value: "checkout",
    label: "Current checkout",
    icon: <Folder />,
    description: "Right in the repository, on the branch you have out.",
  },
];

const hostIcon = (host: Host) => (host.destination ? <Server /> : <Laptop />);

/**
 * Where a thread runs: which of wisp's computers, and in a new worktree or the current checkout.
 * The menu stays open while you pick both. A placeholder: nothing here is sent yet, and wispd
 * starts every thread in a new worktree on the computer that got the request.
 */
export function RunTargetMenu({ hosts, hostId }: { hosts: Host[]; hostId: string }) {
  const id = useId();
  const [hostChoice, setHostChoice] = useState(hostId);
  const [workspaceChoice, setWorkspaceChoice] = useState("worktree");
  const host = hosts.find((h) => h.id === hostChoice) ?? hosts[0]!;
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
                hint: h.id === localId ? "this one" : undefined,
              }}
              checked={h === host}
              onClick={() => setHostChoice(h.id)}
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
          {workspaces.map((w) => (
            <MenuOption
              key={w.value}
              option={w}
              checked={w === workspace}
              onClick={() => setWorkspaceChoice(w.value)}
            />
          ))}
        </div>
      </div>
    </>
  );
}
