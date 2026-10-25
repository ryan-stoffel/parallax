import { useRef, useState } from "react";

import { browserLayout, pageFit, ThemePicker } from "../Browser";
import { bookmarksBar } from "../Bookmarks";
import {
  downloadPrefs,
  homeButton,
  restoreTabs,
  searchEngine,
  searchEngines,
  setDownloadPrefs,
} from "../browserSettings";
import { browserHistory } from "../browserHistory";
import { useExtensions } from "../Extensions";
import { notify } from "../notifications";
import { ConfirmDialog, Picker } from "../ui";
import { PageTitle, quietButton, Row, rowField, Section, Switch } from "./parts";

/**
 * Settings › Browser (PLX-974), as chrome://settings has them: how the browser looks, what it
 * searches with, how it starts, its home button, clearing its data, and its extensions.
 */
export function BrowserSettings() {
  const layout = browserLayout.use();
  const fit = pageFit.use();
  const showBookmarks = bookmarksBar.use();
  const engine = searchEngine.use();
  const restore = restoreTabs.use();
  const home = homeButton.use();
  const downloadsTo = downloadPrefs.use();
  const { list, refresh } = useExtensions();
  const confirm = useRef<HTMLDialogElement>(null);
  const [clear, setClear] = useState({ history: true, siteData: true, cache: true });
  const [clearing, setClearing] = useState(false);
  const [link, setLink] = useState("");
  const [adding, setAdding] = useState(false);

  return (
    <>
      <PageTitle title="Browser">
        The browser in the side panel and in the sidebar's globe. These apply to every one of them.
      </PageTitle>

      <Section title="Appearance">
        {/* Its tiles take the row's width, under its title. */}
        <div data-setting="theme" className="border-b border-border">
          <div className="px-4 pt-3 pb-2">
            <span className="block text-body font-medium">Theme</span>
            <span className="block text-meta text-muted-foreground">
              The colors of the browser's tabs and toolbar
            </span>
          </div>
          <ThemePicker />
        </div>
        <Row title="Layout" description="Compact puts the tabs and the address bar in one row">
          <Picker
            label="Layout"
            value={layout}
            onChange={(v) => browserLayout.set(v as "compact" | "classic")}
            options={[
              { value: "compact", label: "Compact" },
              { value: "classic", label: "Classic" },
            ]}
          />
        </Row>
        <Row title="Show bookmarks bar" description="Under the toolbar, while there are bookmarks">
          <Switch
            label="Show bookmarks bar"
            checked={showBookmarks}
            onChange={(on) => bookmarksBar.set(on)}
          />
        </Row>
        <Row title="Page size" description="Desktop lays a page out as on a monitor, scaled to fit">
          <Picker
            label="Page size"
            value={fit}
            onChange={(v) => pageFit.set(v as "panel" | "monitor")}
            options={[
              { value: "panel", label: "Fill the space" },
              { value: "monitor", label: "Desktop" },
            ]}
          />
        </Row>
      </Section>

      <Section title="Search engine">
        <Row title="Search engine" description="What the address bar searches with">
          <Picker
            label="Search engine"
            value={engine}
            onChange={(v) => searchEngine.set(v)}
            options={searchEngines.map((e) => ({ value: e.id, label: e.name }))}
          />
        </Row>
      </Section>

      <Section title="On startup">
        <Row
          title="Continue where you left off"
          description="Each browser opens the tabs it had. Off, it opens a new tab."
        >
          <Switch
            label="Continue where you left off"
            checked={restore}
            onChange={(on) => restoreTabs.set(on)}
          />
        </Row>
      </Section>

      <Section title="Home button">
        <Row title="Show home button" description="In the toolbar, beside Reload">
          <Switch
            label="Show home button"
            checked={home.show}
            onChange={(show) => homeButton.set({ ...home, show })}
          />
        </Row>
        <Row title="Home page" description="Empty opens a new tab">
          <input
            aria-label="Home page"
            placeholder="New tab"
            spellCheck={false}
            value={home.url}
            onChange={(e) => homeButton.set({ ...home, url: e.target.value })}
            className={rowField}
          />
        </Row>
      </Section>

      <Section title="Downloads">
        <Row title="Location" description={downloadsTo.dir || "Your Downloads folder"}>
          {downloadsTo.dir && (
            <button
              type="button"
              className={quietButton}
              onClick={() => setDownloadPrefs({ ...downloadsTo, dir: "" })}
            >
              Reset
            </button>
          )}
          <button
            type="button"
            className={`${quietButton} border border-border`}
            onClick={() =>
              void window.parallax.pickFolder().then((dir) => {
                if (dir) setDownloadPrefs({ ...downloadsTo, dir });
              })
            }
          >
            Change…
          </button>
        </Row>
        <Row
          title="Ask where to save each file before downloading"
          description="Off, each file goes straight to the location"
        >
          <Switch
            label="Ask where to save each file before downloading"
            checked={downloadsTo.ask}
            onChange={(ask) => setDownloadPrefs({ ...downloadsTo, ask })}
          />
        </Row>
      </Section>

      <Section title="Privacy">
        <Row title="Browsing history" description="Every page in History">
          <Switch
            label="Browsing history"
            checked={clear.history}
            onChange={(history) => setClear({ ...clear, history })}
          />
        </Row>
        <Row title="Cookies and other site data" description="Signs you out of most sites">
          <Switch
            label="Cookies and other site data"
            checked={clear.siteData}
            onChange={(siteData) => setClear({ ...clear, siteData })}
          />
        </Row>
        <Row title="Cached images and files" description="Pages load slower the next time">
          <Switch
            label="Cached images and files"
            checked={clear.cache}
            onChange={(cache) => setClear({ ...clear, cache })}
          />
        </Row>
        <Row
          title="Clear browsing data"
          description="All time, for every browser. Extensions keep theirs."
        >
          <button
            type="button"
            disabled={clearing || (!clear.history && !clear.siteData && !clear.cache)}
            onClick={() => confirm.current?.showModal()}
            className={`${quietButton} border border-border disabled:opacity-50`}
          >
            {clearing ? "Clearing…" : "Clear data"}
          </button>
        </Row>
      </Section>

      <Section
        title="Extensions"
        action={
          <button
            type="button"
            className={quietButton}
            onClick={() =>
              void window.parallax.loadUnpackedExtension().then((answer) => {
                if (typeof answer === "string")
                  notify({
                    key: "extension",
                    tone: "error",
                    title: "Couldn't add the extension",
                    body: answer,
                  });
                void refresh();
              })
            }
          >
            Load unpacked…
          </button>
        }
      >
        <Row title="Add from a link" description="A Chrome Web Store page's address">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!link.trim() || adding) return;
              setAdding(true);
              void window.parallax
                .installExtension(link)
                .then((answer) => {
                  if (typeof answer === "string")
                    notify({
                      key: "extension",
                      tone: "error",
                      title: "Couldn't add the extension",
                      body: answer,
                    });
                  else setLink("");
                  void refresh();
                })
                .finally(() => setAdding(false));
            }}
          >
            <input
              aria-label="Chrome Web Store link"
              placeholder="chromewebstore.google.com/detail/…"
              spellCheck={false}
              value={link}
              onChange={(e) => setLink(e.target.value)}
              className={rowField}
            />
            <button
              type="submit"
              disabled={adding || !link.trim()}
              className={`${quietButton} border border-border disabled:opacity-50`}
            >
              {adding ? "Adding…" : "Add"}
            </button>
          </form>
        </Row>
        {list?.length ? (
          list.map((extension) => (
            <Row
              key={extension.id}
              title={
                <span className="flex items-center gap-2">
                  {extension.icon && <img src={extension.icon} alt="" className="size-4" />}
                  {extension.name}
                </span>
              }
              description={`Version ${extension.version}`}
            >
              <button
                type="button"
                aria-label={`Remove ${extension.name}`}
                onClick={() => void window.parallax.removeExtension(extension.id).then(refresh)}
                className={quietButton}
              >
                Remove
              </button>
            </Row>
          ))
        ) : (
          <Row
            title="No extensions yet"
            description="Add one from the Chrome Web Store in the browser, such as a password manager."
          />
        )}
      </Section>

      <ConfirmDialog
        ref={confirm}
        title="Clear browsing data?"
        action="Clear data"
        onConfirm={() => {
          confirm.current?.close();
          setClearing(true);
          if (clear.history) browserHistory.set([]);
          void window.parallax
            .clearBrowsingData({ siteData: clear.siteData, cache: clear.cache })
            .then(() =>
              notify({ key: "browsing-data", tone: "success", title: "Browsing data cleared" }),
            )
            .finally(() => setClearing(false));
        }}
      >
        {listed(
          [
            clear.history && "browsing history",
            clear.siteData && "cookies and other site data",
            clear.cache && "cached images and files",
          ].filter((x): x is string => !!x),
        )}{" "}
        go for every browser in Parallax. Extensions keep their own.
      </ConfirmDialog>
    </>
  );
}

/** "a, b, and c", capitalized: what Clear browsing data clears, for its confirm. */
function listed(items: string[]): string {
  const text =
    items.length < 3
      ? items.join(" and ")
      : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
