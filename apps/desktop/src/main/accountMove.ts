import type { AccountMove, HostResponse } from "../preload/bridge";
import type { RelayMoveResult } from "../protocol/generated/protocol";

/**
 * A computer still on the development account (PLX-1465): its relay id, its name, and its plxd's
 * `relay/move`, when this app reaches it.
 */
export type Movable = {
  hostId: string;
  name: string;
  move?: (params: { token: string; from: string }) => Promise<HostResponse<RelayMoveResult>>;
};

/**
 * Moves each of `computers` to the production account of `token` from the development account of
 * `from`, all at once, and calls `show` with where the move stands as each one finishes. `moved`
 * names the computers moved before. One this app can't reach waits, as does one whose plxd or relay
 * can't move it yet, such as a relay without the move or a plxd too old for it, for the next try.
 * Answers the relay ids it moved.
 */
export async function moveComputers(
  computers: Movable[],
  tokens: { token: string; from: string },
  moved: string[],
  show: (move: AccountMove) => void,
): Promise<string[]> {
  const done: string[] = [];
  const names = { moved: [...moved], waiting: [] as string[] };
  const moving = new Set(computers.filter((each) => each.move).map((each) => each.name));
  const report = () =>
    show({
      signedIn: true,
      moved: names.moved,
      moving: [...moving],
      waiting: names.waiting,
      done: false,
    });
  for (const each of computers) if (!each.move) names.waiting.push(each.name);
  report();
  await Promise.all(
    computers.map(async ({ hostId, name, move }) => {
      if (!move) return;
      const answer = await move(tokens).catch(() => undefined);
      moving.delete(name);
      if (answer && "result" in answer) {
        done.push(hostId);
        names.moved.push(name);
      } else names.waiting.push(name);
      report();
    }),
  );
  return done;
}
