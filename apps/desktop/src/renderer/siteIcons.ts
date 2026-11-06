// Sites' favicons, which main fetches since the app's CSP takes no image from the web: an agent's
// browser tab's (Browser.tsx) and a transcript link's (AgentChat.tsx).
import { memory } from "./stored";

/** `url`'s origin, which its site's favicon is kept by, or "" for none. */
export const siteOf = (url: string) => {
  const origin = URL.parse(url)?.origin;
  return origin && origin !== "null" ? origin : "";
};

/**
 * The site whose favicon a transcript's link to `url` shows: `https://` and the last two labels
 * of its host, or "" for a link that isn't https or goes to an IP address. Never the whole host,
 * since a subdomain an agent writes can carry what it read, and the favicon's request would send it.
 */
export function linkSite(url: string) {
  const parsed = URL.parse(url);
  const host = parsed?.protocol === "https:" ? parsed.hostname : "";
  return /\.[a-z]{2,}$/i.test(host) ? `https://${host.split(".").slice(-2).join(".")}` : "";
}

// The sites' favicons fetched, by origin, each asked for once.
// ponytail: kept for the app's life and never retried; expire entries if dev servers on one port
// changing icons matters.
export const siteIcons = memory<Readonly<Record<string, string>>>({});
const askedSites = new Set<string>();
export function askSiteIcon(site: string) {
  if (!site || askedSites.has(site)) return;
  askedSites.add(site);
  void window.parallax.siteIcon(site).then((icon) => {
    if (icon) siteIcons.set({ ...siteIcons.get(), [site]: icon });
  });
}
