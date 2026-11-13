import i18next, { t } from "i18next";
import { useRef, useState } from "react";

import { pageFit, ThemePicker } from "../Browser";
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
      <PageTitle title={t("Browser")}>
        {t("The browser tabs in the side panel. These apply to all of them.")}
      </PageTitle>

      <Section title={t("Appearance")}>
        {/* Its tiles take the row's width, under its title. */}
        <div data-setting="theme" className="border-b border-border">
          <div className="px-4 pt-3 pb-2">
            <span className="block text-body font-medium">{t("Theme")}</span>
            <span className="block text-meta text-muted-foreground">
              {t("The colors of the browser's tabs and toolbar")}
            </span>
          </div>
          <ThemePicker />
        </div>
        <Row
          title={t("Show bookmarks bar")}
          description={t("Under the toolbar, while there are bookmarks")}
        >
          <Switch
            label={t("Show bookmarks bar")}
            checked={showBookmarks}
            onChange={(on) => bookmarksBar.set(on)}
          />
        </Row>
        <Row
          title={t("Page size")}
          description={t("Desktop lays a page out as on a monitor, scaled to fit")}
        >
          <Picker
            label={t("Page size")}
            value={fit}
            onChange={(v) => pageFit.set(v as "panel" | "monitor")}
            options={[
              { value: "panel", label: t("Fill the space") },
              { value: "monitor", label: t("Desktop") },
            ]}
          />
        </Row>
      </Section>

      <Section title={t("Search engine")}>
        <Row title={t("Search engine")} description={t("What the address bar searches with")}>
          <Picker
            label={t("Search engine")}
            value={engine}
            onChange={(v) => searchEngine.set(v)}
            options={searchEngines.map((e) => ({ value: e.id, label: e.name }))}
          />
        </Row>
      </Section>

      <Section title={t("On startup")}>
        <Row
          title={t("Continue where you left off")}
          description={t(
            "Each side panel opens the browser tabs it had. Off, they don't come back.",
          )}
        >
          <Switch
            label={t("Continue where you left off")}
            checked={restore}
            onChange={(on) => restoreTabs.set(on)}
          />
        </Row>
      </Section>

      <Section title={t("Home button")}>
        <Row title={t("Show home button")} description={t("In the toolbar, beside Reload")}>
          <Switch
            label={t("Show home button")}
            checked={home.show}
            onChange={(show) => homeButton.set({ ...home, show })}
          />
        </Row>
        <Row title={t("Home page")} description={t("Empty opens a new tab")}>
          <input
            aria-label={t("Home page")}
            placeholder={t("New tab")}
            spellCheck={false}
            value={home.url}
            onChange={(e) => homeButton.set({ ...home, url: e.target.value })}
            className={rowField}
          />
        </Row>
      </Section>

      <Section title={t("Downloads")}>
        <Row title={t("Location")} description={downloadsTo.dir || t("Your Downloads folder")}>
          {downloadsTo.dir && (
            <button
              type="button"
              className={quietButton}
              onClick={() => setDownloadPrefs({ ...downloadsTo, dir: "" })}
            >
              {t("Reset")}
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
            {t("Change…")}
          </button>
        </Row>
        <Row
          title={t("Ask where to save each file before downloading")}
          description={t("Off, each file goes straight to the location")}
        >
          <Switch
            label={t("Ask where to save each file before downloading")}
            checked={downloadsTo.ask}
            onChange={(ask) => setDownloadPrefs({ ...downloadsTo, ask })}
          />
        </Row>
      </Section>

      <Section title={t("Privacy")}>
        <Row title={t("Browsing history")} description={t("Every page in History")}>
          <Switch
            label={t("Browsing history")}
            checked={clear.history}
            onChange={(history) => setClear({ ...clear, history })}
          />
        </Row>
        <Row
          title={t("Cookies and other site data")}
          description={t("Signs you out of most sites")}
        >
          <Switch
            label={t("Cookies and other site data")}
            checked={clear.siteData}
            onChange={(siteData) => setClear({ ...clear, siteData })}
          />
        </Row>
        <Row
          title={t("Cached images and files")}
          description={t("Pages load slower the next time")}
        >
          <Switch
            label={t("Cached images and files")}
            checked={clear.cache}
            onChange={(cache) => setClear({ ...clear, cache })}
          />
        </Row>
        <Row
          title={t("Clear browsing data")}
          description={t("All time, for every browser. Extensions keep theirs.")}
        >
          <button
            type="button"
            disabled={clearing || (!clear.history && !clear.siteData && !clear.cache)}
            onClick={() => confirm.current?.showModal()}
            className={`${quietButton} border border-border disabled:opacity-50`}
          >
            {clearing ? t("Clearing…") : t("Clear data")}
          </button>
        </Row>
      </Section>

      <Section
        title={t("Extensions")}
        action={
          <button
            type="button"
            className={quietButton}
            onClick={() =>
              void window.parallax.loadUnpackedExtension().then((answer) => {
                if (typeof answer === "string") extensionFailed(answer);
                void refresh();
              })
            }
          >
            {t("Load unpacked…")}
          </button>
        }
      >
        <Row title={t("Add from a link")} description={t("A Chrome Web Store page's address")}>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!link.trim() || adding) return;
              setAdding(true);
              void window.parallax
                .installExtension(link)
                .then((answer) => {
                  if (typeof answer === "string") extensionFailed(answer);
                  else setLink("");
                  void refresh();
                })
                .finally(() => setAdding(false));
            }}
          >
            <input
              aria-label={t("Chrome Web Store link")}
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
              {adding ? t("Adding…") : t("Add")}
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
              description={t("Version {{version}}", { version: extension.version })}
            >
              <button
                type="button"
                aria-label={t("Remove {{name}}", { name: extension.name })}
                onClick={() => void window.parallax.removeExtension(extension.id).then(refresh)}
                className={quietButton}
              >
                {t("Remove")}
              </button>
            </Row>
          ))
        ) : (
          <Row
            title={t("No extensions yet")}
            description={t(
              "Add one from the Chrome Web Store in the browser, such as a password manager.",
            )}
          />
        )}
      </Section>

      <ConfirmDialog
        ref={confirm}
        title={t("Clear browsing data?")}
        action={t("Clear data")}
        onConfirm={() => {
          confirm.current?.close();
          setClearing(true);
          if (clear.history) browserHistory.set([]);
          void window.parallax
            .clearBrowsingData({ siteData: clear.siteData, cache: clear.cache })
            .then(() =>
              notify({ key: "browsing-data", tone: "success", title: t("Browsing data cleared") }),
            )
            .finally(() => setClearing(false));
        }}
      >
        {t("{{items}} go for every browser in Parallax. Extensions keep their own.", {
          items: listed(
            [
              clear.history && t("browsing history"),
              clear.siteData && t("cookies and other site data"),
              clear.cache && t("cached images and files"),
            ].filter((x): x is string => !!x),
          ),
        })}
      </ConfirmDialog>
    </>
  );
}

const extensionFailed = (body: string) =>
  notify({ key: "extension", tone: "error", title: t("Couldn't add the extension"), body });

/** "a, b, and c" in the app's language, capitalized: what Clear browsing data clears, for its confirm. */
function listed(items: string[]): string {
  const text = new Intl.ListFormat(i18next.language, { type: "conjunction" }).format(items);
  return text.charAt(0).toUpperCase() + text.slice(1);
}
