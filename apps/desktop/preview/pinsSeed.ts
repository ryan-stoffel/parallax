// Seeds the sidebar's pins (src/renderer/pins.ts) before the renderer reads them: the pinned
// threads in a chosen order, with icons. main.ts imports this after install.ts, before the
// renderer. A newer seed replaces an older one, so a change here shows on the next load.
import { ids } from "./fixtures";

const seed = "7";
const key = (id: string) => `local/${id}`;
if (localStorage.getItem("parallax:pinSeed") !== seed) {
  localStorage.setItem("parallax:pinSeed", seed);
  for (const k of [
    "parallax:pinOpen",
    "parallax:pinFavorites",
    "parallax:pinStartIn",
    "parallax:topCollapsed",
    "parallax:todayFolded",
    "parallax:favoriteOrder",
  ])
    localStorage.removeItem(k);
  localStorage.setItem(
    "parallax:pinLayout",
    JSON.stringify({
      order: [
        key(ids.homework),
        key(ids.physics),
        key(ids.essay),
        key(ids.cart),
        key(ids.pricing),
        key(ids.names),
        key(ids.updater),
      ],
    }),
  );
  // Pinned projects (0090): an orchestrator and a Project.
  localStorage.setItem(
    "parallax.pinnedProjects",
    JSON.stringify([
      key(ids.orchestratorParallax),
      key(ids.projectCoursework),
      key(ids.orchestratorDocs),
    ]),
  );
  localStorage.setItem(
    "parallax:pinIcons",
    JSON.stringify({
      [key(ids.homework)]: { name: "graduation-cap", color: "sky" },
      [key(ids.physics)]: { name: "atom", color: "teal" },
      [key(ids.essay)]: { name: "notebook-pen", color: "pink" },
      [key(ids.pricing)]: { name: "lightbulb", color: "yellow" },
      [key(ids.names)]: { name: "sparkles", color: "orange" },
    }),
  );
}
