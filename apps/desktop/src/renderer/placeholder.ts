// Static data for the app frame until RYA-12 connects to wispd. The shapes are
// the UI's, not the protocol's. Only App imports the data; the rest take props.

export interface Thread {
  id: string;
  title: string;
  /** How long ago it last changed, already formatted. */
  age: string;
}

/** The sidebar icons a Project can pick (Sidebar.tsx maps them to glyphs). */
export type ProjectIcon = "code" | "flame" | "search" | "bug" | "user";

/** A Project, as in Cursor's: one coordinator chat, so one sidebar row. */
export interface Project {
  id: string;
  name: string;
  icon: ProjectIcon;
  age: string;
}

/** A repository entry and its plain threads (0017). `scratch` is "No Repo". */
export interface Repository {
  id: string;
  name: string;
  scratch?: boolean;
  threads: Thread[];
}

export interface Host {
  id: string;
  name: string;
  local: boolean;
  projects: Project[];
  repositories: Repository[];
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
    repositories: [
      {
        id: "wisp",
        name: "wisp",
        threads: [
          { id: "t1", title: "Fix sidebar focus order", age: "12m" },
          { id: "t2", title: "Tighten the theme tokens", age: "3h" },
          { id: "t3", title: "Draft the release notes", age: "2d" },
        ],
      },
      {
        id: "dotfiles",
        name: "dotfiles",
        threads: [{ id: "t4", title: "Clean up the zsh prompt", age: "4d" }],
      },
      {
        id: "scratch",
        name: "No Repo",
        scratch: true,
        threads: [{ id: "t5", title: "Explain this regex", age: "1d" }],
      },
    ],
  },
  {
    id: "mini",
    name: "mac-mini",
    local: false,
    projects: [{ id: "p-homelab", name: "homelab", icon: "code", age: "6h" }],
    repositories: [
      {
        id: "homelab",
        name: "homelab",
        threads: [{ id: "t6", title: "Rotate the backup keys", age: "1w" }],
      },
      { id: "scratch-mini", name: "No Repo", scratch: true, threads: [] },
    ],
  },
];

/** What the composer's pickers offer. */
export interface ComposerOptions {
  models: { provider: string; models: string[] }[];
  efforts: string[];
  permissions: string[];
  branches: string[];
}

export const composerOptions: ComposerOptions = {
  models: [
    { provider: "Claude", models: ["Opus 5.5", "Sonnet 5", "Haiku 5"] },
    { provider: "Codex", models: ["GPT-5.5", "GPT-5.5 mini"] },
  ],
  efforts: ["Low effort", "Medium effort", "High effort"],
  permissions: ["Ask before edits", "Auto-accept edits", "Full access"],
  branches: ["main", "develop"],
};
