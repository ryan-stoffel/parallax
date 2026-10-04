// Opens a view from the URL's hash, since the app's views are plain state with no routes:
// it clicks through the UI as a person would, once each step's button is on screen.
//
//   #project=parallax                     a Project, by its sidebar name
//   #project=parallax&panel=Agents        and a side panel view, by its name
//   #project=parallax&agent=Scheduler     and a child's chat, by the start of its title
//   #thread=Rework the updater            a plain thread, by its title
//   #settings                             Settings; #usage, the Usage page

/** An element to click, `true` when there is nothing to do, or nothing while it isn't there yet. */
type Step = () => HTMLElement | true | null | undefined;

const byText = (root: ParentNode | null, selector: string, text: string) =>
  root &&
  [...root.querySelectorAll<HTMLElement>(selector)].find((el) =>
    el.textContent?.trim().toLowerCase().startsWith(text.toLowerCase()),
  );
const byLabel = (label: string) =>
  document.querySelector<HTMLElement>(`button[aria-label="${CSS.escape(label)}"]`);
const panel = () => document.querySelector<HTMLElement>('aside[aria-label="Side panel"]');

/** Clicks each step's element in turn, waiting up to 5 s for it to show up. */
async function run(steps: Step[]) {
  for (const step of steps) {
    const deadline = Date.now() + 5000;
    let el = step();
    while (!el && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      el = step();
    }
    if (!el) return console.warn("preview: couldn't follow the hash at", String(step));
    if (el === true) continue;
    el.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

function openPanelView(name: string): Step[] {
  return [
    () => (panel()?.checkVisibility() ? true : byLabel("Show side panel")),
    () =>
      byText(panel(), 'ul[aria-label="Open views"] button', name) ??
      byText(panel(), 'nav[aria-labelledby="side-panel-views"] button', name) ??
      panel()?.querySelector<HTMLElement>("#side-panel-open-view"),
    () =>
      byText(panel(), 'nav[aria-labelledby="side-panel-views"] button', name) ??
      byText(panel(), 'ul[aria-label="Open views"] button[aria-current]', name),
  ];
}

export function openFromHash() {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (!hash) return;
  const params = new URLSearchParams(hash);
  const steps: Step[] = [];
  if (params.has("settings")) steps.push(() => byLabel("Settings"));
  if (params.has("usage")) steps.push(() => byLabel("Usage"));
  const project = params.get("project");
  if (project)
    steps.push(() =>
      byText(
        document.querySelector('ul[aria-label="Projects"]'),
        "button, a, [role=button]",
        project,
      ),
    );
  const thread = params.get("thread");
  if (thread)
    steps.push(() =>
      [...document.querySelectorAll<HTMLElement>('ul[aria-label="Threads"] *')].find(
        (el) => el.childElementCount === 0 && el.textContent?.trim() === thread,
      ),
    );
  const agent = params.get("agent");
  if (agent) steps.push(...openPanelView("Agents"), () => byText(panel(), "button", agent));
  const view = params.get("panel");
  if (view) steps.push(...openPanelView(view));
  void run(steps);
}
