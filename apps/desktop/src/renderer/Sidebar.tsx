import {
  ArrowLeft,
  Bug,
  Code,
  Flame,
  Folder,
  House,
  Laptop,
  PanelLeft,
  Plus,
  Search,
  Server,
  Settings,
  SquarePen,
  User,
  type LucideIcon,
} from "lucide-react";
import { useRef, type ReactNode } from "react";

import type { Selection, SettingsSection } from "./App";
import { ConnectionStatus } from "./ConnectionStatus";
import { NewProjectDialog } from "./NewProjectDialog";
import type { ComposerOptions, Host, ProjectIcon } from "./placeholder";
import { IconButton, Picker, TopBar } from "./ui";

const row =
  "flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left text-[13px] hover:bg-hover";
const current = "bg-selected text-foreground";
const heading = "text-[11.5px] font-medium text-faint-foreground";

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  onNewThread: () => void;
  children: ReactNode;
}

/** The left column. Its top row holds the macOS traffic lights. */
export function Sidebar({ open, onClose, onNewThread, children }: SidebarProps) {
  return (
    <nav
      id="sidebar"
      aria-label="Sidebar"
      hidden={!open}
      className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar"
    >
      <TopBar className="traffic-light-inset justify-end gap-0.5 px-2">
        <IconButton
          label="Hide sidebar"
          keys="B"
          aria-expanded
          aria-controls="sidebar"
          onClick={onClose}
        >
          <PanelLeft />
        </IconButton>
        <IconButton label="New thread" keys="N" onClick={onNewThread}>
          <SquarePen />
        </IconButton>
      </TopBar>
      {children}
    </nav>
  );
}

interface ThreadListProps {
  hosts: Host[];
  host: Host;
  onHostChange: (hostId: string) => void;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onOpenSettings: () => void;
  models: ComposerOptions["models"];
}

// Glyph and color per ProjectIcon. -500 shades read on both themes.
const projectIcons: Record<ProjectIcon, { Icon: LucideIcon; color: string }> = {
  code: { Icon: Code, color: "text-violet-500" },
  flame: { Icon: Flame, color: "text-orange-500" },
  search: { Icon: Search, color: "text-sky-500" },
  bug: { Icon: Bug, color: "text-amber-600" },
  user: { Icon: User, color: "text-rose-500" },
};

/** Hosts, their Projects (one row each), and repositories with their threads. */
export function ThreadList({
  hosts,
  host,
  onHostChange,
  selection,
  onSelect,
  onOpenSettings,
  models,
}: ThreadListProps) {
  const newProject = useRef<HTMLDialogElement>(null);

  const threadButton = (
    label: string,
    age: string,
    selected: boolean,
    onClick: () => void,
    icon?: ReactNode,
  ) => (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      onClick={onClick}
      className={`${row} ${icon ? "" : "pl-7.5"} ${selected ? current : "text-foreground/80"}`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-[11.5px] text-faint-foreground">{age}</span>
    </button>
  );

  return (
    <>
      <div className="px-2">
        <Picker
          label="Host"
          icon={host.local ? <Laptop /> : <Server />}
          value={host.id}
          onChange={(e) => onHostChange(e.target.value)}
        >
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </Picker>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <section aria-labelledby="projects-heading" className="mt-4">
          <div className="flex items-center justify-between pr-0.5 pl-2">
            <h2 id="projects-heading" className={heading}>
              Projects
            </h2>
            <IconButton label="New project" onClick={() => newProject.current?.showModal()}>
              <Plus />
            </IconButton>
          </div>
          <ul>
            {host.projects.map((p) => {
              const { Icon, color } = projectIcons[p.icon];
              return (
                <li key={p.id}>
                  {threadButton(
                    p.name,
                    p.age,
                    selection.kind === "project" && selection.projectId === p.id,
                    () => onSelect({ kind: "project", projectId: p.id }),
                    <Icon aria-hidden className={`size-4 shrink-0 ${color}`} />,
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-labelledby="repositories-heading" className="mt-4">
          <h2 id="repositories-heading" className={`${heading} px-2 pb-1`}>
            Repositories
          </h2>
          {host.repositories.map((repo) => (
            <div key={repo.id} className="mb-1">
              <div className="flex items-center gap-2 px-2 py-[5px] text-[13px] text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0">
                {repo.scratch ? <House aria-hidden /> : <Folder aria-hidden />}
                <span className="truncate">{repo.name}</span>
              </div>
              <ul>
                {repo.threads.map((t) => (
                  <li key={t.id}>
                    {threadButton(
                      t.title,
                      t.age,
                      selection.kind === "thread" && selection.threadId === t.id,
                      () => onSelect({ kind: "thread", repoId: repo.id, threadId: t.id }),
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      </div>
      <NewProjectDialog ref={newProject} repositories={host.repositories} models={models} />
      <div className="border-t border-border p-2">
        {/* Only this Mac's wispd is connected so far (RYA-12); SSH hosts come with RYA-26. */}
        {host.local && <ConnectionStatus hostId="local" />}
        <button type="button" onClick={onOpenSettings} className={`${row} text-muted-foreground`}>
          <Settings className="size-4" />
          Settings
        </button>
      </div>
    </>
  );
}

const sections: { id: SettingsSection; name: string }[] = [
  { id: "general", name: "General" },
  { id: "providers", name: "Providers" },
];

/** The sidebar while Settings is open. */
export function SettingsNav({
  section,
  onSection,
  onBack,
}: {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-px px-2">
      <button type="button" onClick={onBack} className={`${row} mb-3 text-muted-foreground`}>
        <ArrowLeft className="size-4" />
        Back to app
      </button>
      {sections.map((s) => (
        <button
          key={s.id}
          type="button"
          aria-current={s.id === section ? "page" : undefined}
          onClick={() => onSection(s.id)}
          className={`${row} ${s.id === section ? current : "text-foreground/80"}`}
        >
          {s.name}
        </button>
      ))}
    </div>
  );
}
