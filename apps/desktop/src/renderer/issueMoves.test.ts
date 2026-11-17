import { expect, test } from "vite-plus/test";

import type { Issue, IssueStateCategory } from "../protocol/generated/protocol";
import {
  boardEntries,
  canMove,
  failMove,
  listEntries,
  refreshMoves,
  settleMove,
  startMove,
  type Moves,
} from "./issueMoves";
import type { IssueEntry } from "./issues";

const url = "https://linear.app/acme/issue/ENG-12";
const at = (name: string, category: IssueStateCategory): Issue => ({
  connectionId: "lin",
  provider: "linear",
  id: "9c67",
  key: "ENG-12",
  title: "Show issues in Parallax",
  url,
  state: { id: name, name, category },
  container: { id: "t1", name: "Engineering" },
  updatedAt: "2026-11-17T12:00:00Z",
});
const todo: IssueEntry = { hostId: "mac", issue: at("Todo", "todo") };
const shown = (listed: IssueEntry[], moves: Moves) =>
  boardEntries(listed, moves).map((e) => e.issue.state.name);

test("two moves in sequence: the second waits for the first, then each settles in turn", () => {
  let moves = startMove({}, todo, "inProgress", "In progress");
  expect(shown([todo], moves)).toEqual(["In progress"]);
  expect(canMove(moves, url)).toBe(false);
  // A drop while the first is in flight changes nothing.
  expect(startMove(moves, moves[url]!.entry, "done", "Done")).toBe(moves);

  moves = settleMove(moves, url, at("In Progress", "inProgress"));
  expect(canMove(moves, url)).toBe(true);
  moves = startMove(moves, moves[url]!.entry, "done", "Done");
  moves = settleMove(moves, url, at("Done", "done"));
  // The computer no longer lists a finished issue, and its card stays.
  expect(shown([], moves)).toEqual(["Done"]);
  // A settle that arrives with nothing pending changes nothing.
  expect(settleMove(moves, url, at("In Progress", "inProgress"))).toBe(moves);
});

test("a move that fails puts back what the board showed before it", () => {
  const failed = failMove(startMove({}, todo, "backlog", "Backlog"), url);
  expect(failed).toEqual({});
  expect(shown([todo], failed)).toEqual(["Todo"]);

  // A card kept in Done, dragged out and refused, is in Done again.
  let moves = settleMove(startMove({}, todo, "done", "Done"), url, at("Done", "done"));
  moves = failMove(startMove(moves, moves[url]!.entry, "todo", "To do"), url);
  expect(shown([], moves)).toEqual(["Done"]);
  expect(canMove(moves, url)).toBe(true);
});

test("Refresh during a move keeps its target, and forgets it once a later Refresh comes", () => {
  let moves = refreshMoves(startMove({}, todo, "inProgress", "In progress"));
  expect(shown([todo], moves)).toEqual(["In progress"]);
  moves = settleMove(moves, url, at("In Progress", "inProgress"));
  expect(shown([todo], moves)).toEqual(["In Progress"]);
  expect(refreshMoves(moves)).toEqual({});
});

test("a read that lands late with the old state doesn't move the card back", () => {
  const moves = settleMove(
    startMove({}, todo, "inProgress", "In progress"),
    url,
    at("In Progress", "inProgress"),
  );
  // The replaced read still lists it as Todo. The newer one lists what the tracker holds.
  expect(shown([todo], moves)).toEqual(["In Progress"]);
  expect(shown([{ hostId: "mac", issue: at("In Progress", "inProgress") }], moves)).toEqual([
    "In Progress",
  ]);
});

test("the list shows a moved issue in its new state, and leaves out one moved to Done", () => {
  const started = settleMove(
    startMove({}, todo, "inProgress", "In progress"),
    url,
    at("In Progress", "inProgress"),
  );
  expect(listEntries([todo], started).map((e) => e.issue.state.name)).toEqual(["In Progress"]);
  const done = startMove({}, todo, "done", "Done");
  expect(listEntries([todo], done)).toEqual([]);
  expect(listEntries([todo], {})).toEqual([todo]);
});
