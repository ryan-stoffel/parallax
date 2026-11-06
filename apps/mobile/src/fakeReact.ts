// Just enough of React to run a hook's effects in a test, since the phone's tests have no renderer.
// A test mocks "react" with `hooks`, and calls `begin` before each call of the hook.

const slots: unknown[] = [];
let at = 0;

const unchanged = (before: unknown[] | undefined, deps: unknown[]) =>
  !!before && deps.every((dep, i) => Object.is(dep, before[i]));

export const begin = () => void (at = 0);

export const hooks = {
  useState: (first?: unknown) => {
    const i = at++;
    if (!(i in slots)) slots[i] = first;
    return [slots[i], (next: unknown) => void (slots[i] = next)];
  },
  useEffect: (run: () => void, deps: unknown[]) => {
    const i = at++;
    if (unchanged(slots[i] as unknown[] | undefined, deps)) return;
    slots[i] = deps;
    run();
  },
  useCallback: <T>(fn: T, deps: unknown[]): T => {
    const i = at++;
    const kept = slots[i] as { fn: T; deps: unknown[] } | undefined;
    if (kept && unchanged(kept.deps, deps)) return kept.fn;
    slots[i] = { fn, deps };
    return fn;
  },
};
