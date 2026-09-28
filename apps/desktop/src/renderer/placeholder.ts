// Static data for what isn't wired to wispd yet: Projects (RYA-46) and other hosts (RYA-26).
// Repositories and threads are live (threads.ts). The shapes are the UI's, not the protocol's.
// Only App imports the data; the rest take props.

/** The sidebar icons a Project can pick (Sidebar.tsx maps them to glyphs). */
export type ProjectIcon = "code" | "flame" | "search" | "bug" | "user";

/** A Project, as in Cursor's: one coordinator chat, so one sidebar row. */
export interface Project {
  id: string;
  name: string;
  icon: ProjectIcon;
  age: string;
}

export interface Host {
  id: string;
  name: string;
  local: boolean;
  projects: Project[];
}

export const hosts: Host[] = [
  {
    id: "local",
    name: "This Mac",
    local: true,
    projects: [
      { id: "p-wisp", name: "wisp", icon: "code", age: "3h" },
      { id: "p-ember", name: "ember", icon: "flame", age: "3d" },
      { id: "p-photon", name: "photon", icon: "search", age: "5d" },
      { id: "p-formula", name: "formula-fly", icon: "bug", age: "6d" },
      { id: "p-site", name: "personal-site", icon: "user", age: "6d" },
    ],
  },
];

export interface ModelGroup {
  provider: string;
  models: string[];
}

/** The models Create Project offers. */
export const models: ModelGroup[] = [
  { provider: "Claude", models: ["Opus 5.5", "Sonnet 5", "Haiku 5"] },
  { provider: "Codex", models: ["GPT-5.5", "GPT-5.5 mini"] },
];
