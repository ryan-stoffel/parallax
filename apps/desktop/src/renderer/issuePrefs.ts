// What the Issues page keeps on this computer: its view, and its filters.
import { providers, type IssueFilters } from "./issues";
import { stored } from "./stored";

export type IssuesView = "list" | "board";

/** Whether the page shows its issues as rows or as a board. */
export const issuesView = stored<IssuesView>("parallax.issuesView", "list", (raw, fallback) =>
  raw === "list" || raw === "board" ? raw : fallback,
);

/** List to Board, or back, as the Issues: Switch List and Board command does. */
export const switchIssuesView = () =>
  issuesView.set(issuesView.get() === "list" ? "board" : "list");

/** The trackers and the project the page shows, in List and Board alike. */
export const issueFilters = stored<IssueFilters>(
  "parallax.issueFilters",
  { trackers: [], project: "" },
  (raw) => {
    const { trackers, project } = (raw ?? {}) as Record<string, unknown>;
    return {
      trackers: providers.filter((p) => Array.isArray(trackers) && trackers.includes(p)),
      project: typeof project === "string" ? project : "",
    };
  },
);
