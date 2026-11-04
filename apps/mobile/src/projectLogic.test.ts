import { expect, test } from "vitest";

import type { ProjectEntry } from "../../desktop/src/renderer/projectList";
import { projectGroups } from "./projectLogic";

const entry = (name: string, hostId: string, threads: number, activeAt: string, online = true) =>
  ({
    host: { id: hostId, name: hostId },
    view: { capabilities: online ? { projectThreads: {} } : {} },
    id: `${hostId}-${name}`,
    name,
    threads,
    activeAt,
  }) as unknown as ProjectEntry;

test("same-named Projects count as one, opening on the default computer when it's online", () => {
  const entries = [
    entry("Essays", "laptop", 2, "2026-11-03"),
    entry("Tax", "laptop", 1, "2026-11-02"),
    entry("Essays", "desktop", 3, "2026-11-01"),
    entry("Tax", "desktop", 0, "2026-10-01", false),
  ];
  const [essays, tax] = projectGroups(entries, "desktop");
  expect(essays).toMatchObject({ name: "Essays", computers: 2, threads: 5, activeAt: "2026-11-03" });
  expect(essays!.home.host.id).toBe("desktop");
  expect(tax!.home.host.id).toBe("laptop");
});
