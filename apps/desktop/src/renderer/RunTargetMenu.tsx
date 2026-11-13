import { t } from "i18next";
import {
  Check,
  ChevronDown,
  Folder,
  FolderGit2,
  Laptop,
  LoaderCircle,
  Scale,
  Search,
  Server,
} from "lucide-react";

import { useId, useState } from "react";

import { msg } from "../i18n";
import { useShownConnection } from "./ConnectionStatus";

import { DeviceIcon } from "./DeviceIcon";
import { localId, type Host } from "./hosts";
import { Menu, MenuOption, menuButton, menuHeading, menuItem, type PickerOption } from "./ui";

/** Where a new thread works: a worktree of its own, or the repository's own checkout. */
export type Workspace = "worktree" | "checkout";

/** Its `label` and `description` are English, marked with `msg`; show them with `t`. */
export const workspaces: (PickerOption & { value: Workspace })[] = [
  {
    value: "worktree",
    label: msg("New worktree"),
    icon: <FolderGit2 />,
    description: msg("A fresh branch and folder, so your checkout stays as it is."),
  },
  {
    value: "checkout",
    label: msg("Local checkout"),
    icon: <Folder />,
    description: msg("Right in the repository, on the branch you have out."),
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
    ? t("This computer")
    : host.destination
      ? t("SSH · {{destination}}", { destination: host.destination })
      : host.routes
        ? t("Same network")
        : "Parallax Connect";

/** Past this many computers, the menu adds a search box. */
const searchFrom = 7;

/** The Load Balancer's mark beside the computer it picked, in the menu and the bar. */
function Picked() {
  return (
    <span
      title={t("Picked by the Load Balancer")}
      className="inline-flex shrink-0 text-faint-foreground"
    >
      <Scale aria-hidden className="size-3.5!" />
      <span className="sr-only">{t(", picked by the Load Balancer")}</span>
    </span>
  );
}

/**
 * A computer's row: its icon with a dot for whether it's connected, its name, and how it's reached,
 * unless that's Parallax Connect, which most computers are. `picked` when the Load Balancer chose it.
 */
function HostOption({
  host,
  checked,
  picked,
  missing,
  why,
  onClick,
}: {
  host: Host;
  checked: boolean;
  picked?: boolean;
  missing?: string;
  /** Why the Load Balancer didn't pick it. */
  why?: string;
  onClick: () => void;
}) {
  const status = useShownConnection(host.id)?.status;
  const offline = status === "failed";
  const note = offline
    ? t("Offline")
    : (why ??
      (host.id === localId || host.destination || host.routes ? connection(host) : undefined));
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
        {/* Both cut off with "…" when long, how it connects first. */}
        <span className={`truncate ${offline ? "text-muted-foreground" : ""}`}>{host.name}</span>
        {picked && <Picked />}
        <span className="shrink-[4] truncate text-meta text-faint-foreground">{note}</span>
      </span>
      {missing && (
        <span
          title={t("Picking it clones {{repo}} there", { repo: missing })}
          className="shrink-0 text-meta text-faint-foreground"
        >
          {t("Clones {{repo}}", { repo: missing })}
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
 * starts the thread on that computer with that workspace; with no `workspace`, as for a thread with
 * no repo, it picks only the computer. `checkoutUnavailable`, when set, says why Local checkout
 * can't be picked. `missing` names the computers, by id, that lack the picked
 * repository, which say picking them clones it. `busy` while the picked computer is set up, which
 * the button shows with a spinner. The button reads the computer's icon and name, then the
 * workspace's. Each computer shows whether it's connected, the list scrolls,
 * and past a handful of computers a search box filters them. With `balancer`, the Load Balancer
 * (0101) is on: `on` while it holds the choice, which marks its pick, `checking` while it chooses,
 * and `none` when no computer could take the thread. `why` says why it passed over each computer,
 * and `problem`, in a quiet line, what it couldn't do, with `onSettings` opening its setting. After
 * a manual pick, a last row gives the choice back to it (`onChoose`).
 */
export function RunTargetMenu({
  hosts,
  hostId,
  onHostChange,
  workspace: workspaceChoice,
  onWorkspaceChange,
  checkoutUnavailable,
  missing,
  busy,
  balancer,
}: {
  hosts: Host[];
  hostId: string;
  onHostChange: (hostId: string) => void;
  workspace?: Workspace;
  onWorkspaceChange?: (workspace: Workspace) => void;
  checkoutUnavailable?: string;
  missing?: { repo: string; hostIds: ReadonlySet<string> };
  busy?: boolean;
  balancer?: {
    on: boolean;
    checking: boolean;
    none: boolean;
    why?: Record<string, string>;
    problem?: string;
    onChoose: () => void;
    onSettings?: () => void;
  };
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const host = hosts.find((h) => h.id === hostId) ?? hosts[0]!;
  const workspace = workspaces.find((w) => w.value === workspaceChoice);
  const searchable = hosts.length >= searchFrom;
  const q = query.trim().toLowerCase();
  const shown = q ? hosts.filter((h) => h.name.toLowerCase().includes(q)) : hosts;
  // While it has no pick, the bar says so, not the computer the draft is on.
  const chosen = balancer?.checking
    ? t("Choosing a computer…")
    : balancer?.none
      ? t("Pick a computer")
      : host.name;
  const picked = !!balancer?.on && !balancer.checking && !balancer.none;
  const where = { computer: chosen, workspace: workspace && t(workspace.label) };
  const runsOn = picked
    ? workspace
      ? t("Runs on: {{computer}}, picked by the Load Balancer, {{workspace}}", where)
      : t("Runs on: {{computer}}, picked by the Load Balancer", where)
    : workspace
      ? t("Runs on: {{computer}}, {{workspace}}", where)
      : t("Runs on: {{computer}}", where);
  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        aria-haspopup="menu"
        aria-label={runsOn}
        aria-busy={busy}
        title={
          balancer?.checking
            ? t("The Load Balancer is choosing a computer")
            : balancer?.none
              ? balancer.problem
              : picked
                ? t("{{computer}}, picked by the Load Balancer", { computer: host.name })
                : host.name
        }
        className={`${menuButton} min-w-0`}
      >
        {busy ? (
          <LoaderCircle aria-hidden className="animate-spin" />
        ) : balancer?.none ? (
          <Scale aria-hidden className="text-warning" />
        ) : (
          hostIcon(host)
        )}
        <span className="composer-host truncate">{chosen}</span>
        {picked && !busy && <Scale aria-hidden className="size-3.5! text-faint-foreground" />}
        {/* A pair of its own, set apart from the computer's. Its label hides in a narrow box. */}
        {workspace && (
          <span className="ml-2.5 flex shrink-0 items-center gap-1.5">
            {workspace.icon}
            <span className="composer-detail">{t(workspace.label)}</span>
          </span>
        )}
        <ChevronDown aria-hidden className="opacity-70" />
      </button>
      <Menu
        id={id}
        label={t("Runs on")}
        className="w-80 overflow-hidden p-0"
        focus={searchable ? "input" : '[aria-checked="true"]'}
        onClose={() => setQuery("")}
      >
        {searchable && (
          <label className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
            <input
              type="search"
              aria-label={t("Search computers")}
              placeholder={t("Search computers...")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shown[0]) onHostChange(shown[0].id);
              }}
              className="min-w-0 flex-1 bg-transparent text-body placeholder:text-faint-foreground focus-visible:outline-none"
            />
          </label>
        )}
        <div role="group" aria-label={t("Computer")} className="p-1">
          <p aria-hidden className={menuHeading}>
            {t("Computer")}
          </p>
          <div className="max-h-72 overflow-y-auto">
            {shown.map((h) => (
              <HostOption
                key={h.id}
                host={h}
                checked={h === host && !balancer?.checking && !balancer?.none}
                picked={picked && h === host}
                missing={missing?.hostIds.has(h.id) ? missing.repo : undefined}
                why={balancer?.on && !missing?.hostIds.has(h.id) ? balancer.why?.[h.id] : undefined}
                onClick={() => onHostChange(h.id)}
              />
            ))}
          </div>
          {balancer && !balancer.on && (
            <button
              type="button"
              role="menuitem"
              onClick={balancer.onChoose}
              className={`${menuItem} text-muted-foreground hover:text-foreground`}
            >
              <span className="grid h-5 place-items-center">
                <Scale aria-hidden />
              </span>
              {t("Let the Load Balancer choose")}
            </button>
          )}
          {(balancer?.checking || balancer?.problem) && (
            <p className="px-2 pt-0.5 pb-1.5 text-meta text-faint-foreground">
              {balancer.checking ? t("Choosing a computer…") : balancer.problem}
              {balancer.onSettings && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={balancer.onSettings}
                    className="rounded-sm text-accent hover:underline"
                  >
                    {t("Choose computers")}
                  </button>
                </>
              )}
            </p>
          )}
          {shown.length === 0 && (
            <p className="px-2 py-1.5 text-body text-faint-foreground">{t("No matches")}</p>
          )}
          {hosts.length === 1 && (
            <p className="px-2 pt-0.5 pb-1.5 text-meta text-faint-foreground">
              {t("Computers you add under Hosts show up here.")}
            </p>
          )}
        </div>
        {workspace && (
          <div role="group" aria-label={t("Workspace")} className="border-t border-border p-1">
            <p aria-hidden className={menuHeading}>
              {t("Workspace")}
            </p>
            {workspaces.map((w) => (
              <MenuOption
                key={w.value}
                option={{ value: w.value, label: t(w.label), icon: w.icon }}
                checked={w === workspace}
                disabled={w.value === "checkout" && !!checkoutUnavailable}
                onClick={() => onWorkspaceChange?.(w.value)}
              />
            ))}
            {checkoutUnavailable && (
              <p className="px-2 pt-0.5 pb-1.5 text-meta text-faint-foreground">
                {t("Local checkout {{reason}}.", { reason: checkoutUnavailable })}
              </p>
            )}
          </div>
        )}
      </Menu>
    </>
  );
}
