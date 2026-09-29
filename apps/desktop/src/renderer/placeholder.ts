// Static data for what isn't wired to wispd yet: Projects (RYA-46). Hosts (hosts.ts),
// repositories, and threads (threads.ts) are live. The shapes are the UI's, not the protocol's.
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

/** This computer's Projects. Other hosts have none until RYA-46. */
export const projects: Project[] = [
  { id: "p-wisp", name: "wisp", icon: "code", age: "3h" },
  { id: "p-ember", name: "ember", icon: "flame", age: "3d" },
  { id: "p-photon", name: "photon", icon: "search", age: "5d" },
  { id: "p-formula", name: "formula-fly", icon: "bug", age: "6d" },
  { id: "p-site", name: "personal-site", icon: "user", age: "6d" },
];
