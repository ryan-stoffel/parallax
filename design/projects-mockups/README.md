# Projects UI mockups

Interactive mockups for the Projects redesign (PLX-494). A standalone Vite, React and TypeScript app with mock data. It does not talk to plxd and nothing here ships in the desktop app.

```sh
cd design/projects-mockups
pnpm install
pnpm dev          # http://localhost:5180
pnpm build:single # dist/single.html, one file to open or share
```

Colors and fonts are copied from `apps/desktop/src/renderer/index.css`, so the mockups read as Parallax in both themes (toggle in the sidebar footer).

## What to try

- **Sidebar.** Projects show a count of what needs you and a pulse while threads run. Projects opens the index; From threads shows turning loose threads into a project.
- **Project tabs.** Home, Threads, Knowledge and Ship replace the side panel's "Open a view" list.
- **Home.** The coordinator's summary, decisions to answer (pick an option or answer in your own words), what it decided for you (Change reverts it), and what it learned. The right panel lists threads by what they need.
- **Composer.** New thread or Ask (Mod+. switches), one model and effort picker, permissions, and where the thread runs. Type `@` to mention a thread or file. Enter on New thread starts a thread right away; watch it appear in the panel.
- **Threads.** Where each thread is running, by host. Open one for its transcript, the task the coordinator gave it, and its assumptions.
- **Knowledge.** Brief, memory, notes, files and history in one place, replacing the separate Context and Memory panels. Try "we moved off Jest, use Vitest" in the box at the top.
- **Ship.** The project branch, what is ready to land, what landed, and the pull request draft.
- **Capacity.** The "running" chip in the header shows hosts and subscription headroom.
