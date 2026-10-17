// Seeds the sidebar's pins (src/renderer/pins.ts) before the renderer reads them: a School folder
// with a Math folder inside it, a client's folder, a side-projects folder, and a kept code thread,
// with the favorites in a chosen order. main.ts imports this after install.ts, before the
// renderer. A newer seed replaces an older one, so a change here shows on the next load.
import { ids } from "./fixtures";

const seed = "5";
const key = (id: string) => `local/${id}`;
if (localStorage.getItem("parallax:pinSeed") !== seed) {
  localStorage.setItem("parallax:pinSeed", seed);
  for (const k of [
    "parallax:pinOpen",
    "parallax:pinFavorites",
    "parallax:pinStartIn",
    "parallax:topCollapsed",
    "parallax:todayFolded",
  ])
    localStorage.removeItem(k);
  localStorage.setItem(
    "parallax:pinLayout",
    JSON.stringify({
      order: [
        key(ids.projectParallax),
        key(ids.projectDocs),
        "folder:school",
        "folder:acme",
        "folder:side",
        key(ids.updater),
      ],
      folders: {
        school: {
          name: "School",
          color: "sky",
          items: ["folder:math", key(ids.physics), key(ids.essay)],
        },
        math: { name: "Math", color: "violet", items: [key(ids.homework)] },
        acme: { name: "Acme", color: "red", items: [key(ids.cart)] },
        side: { name: "Side projects", color: "orange", items: [key(ids.pricing), key(ids.names)] },
      },
    }),
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
  localStorage.setItem(
    "parallax:favoriteOrder",
    JSON.stringify([
      key(ids.projectParallax),
      key(ids.projectDocs),
      key(ids.projectMobile),
      key(ids.projectInfra),
      key(ids.projectLanding),
    ]),
  );
}
