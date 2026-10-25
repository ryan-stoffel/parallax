import type { Session } from "electron";

import type { GoogleAccount } from "../preload/bridge";
import { broadcast } from "./windows";

// The Google account signed in to the browser's session, for its profile button (PLX-981). Chrome's
// own account chooser reads the session's accounts from ListAccounts, which answers with the
// session's Google cookies; it's read again whenever those change, as on signing in or out.

const listAccounts =
  "https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard";

/**
 * The first signed-in account in ListAccounts' answer, or undefined for none. Each account is an
 * array: its name at 2, email at 3, picture at 4, 0 at 9 once its session is no longer valid, and
 * 1 at 14 once it's signed out but remembered (Chromium's ParseListAccountsData in
 * gaia_auth_util.cc).
 */
export function parseListAccounts(text: string): GoogleAccount | undefined {
  try {
    const [, accounts] = JSON.parse(text) as [unknown, unknown[][]];
    const account = accounts.find((a) => a[9] !== 0 && a[14] !== 1 && typeof a[3] === "string");
    if (!account) return undefined;
    return {
      name: typeof account[2] === "string" && account[2] ? account[2] : (account[3] as string),
      email: account[3] as string,
      ...(typeof account[4] === "string" && { picture: account[4] }),
    };
  } catch {
    return undefined;
  }
}

let current: GoogleAccount | undefined;

/** The account last read, or undefined while signed out. */
export const googleAccount = () => current;

/**
 * Reads the account now and whenever the session's Google sign-in cookies change, telling every
 * window. `inline` turns its picture's url into a data URL, as the app's CSP takes no web images.
 */
export function watchGoogleAccounts(
  session: Session,
  inline: (url: string) => Promise<string | undefined>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    let next: GoogleAccount | undefined;
    try {
      // As Chromium asks: a GET gets an error page.
      const answer = await session.fetch(listAccounts, {
        method: "POST",
        body: " ",
        headers: { Origin: "https://www.google.com" },
        credentials: "include",
      });
      next = answer.ok ? parseListAccounts(await answer.text()) : undefined;
    } catch {
      // Offline: as signed out, until the next change.
    }
    if (next) {
      const { picture: url, ...rest } = next;
      // A larger picture than the 48 px Google lists, for the profile menu's.
      const picture = url && (await inline(url.replace(/=s\d+(-c)?$/, "=s128-c")));
      next = { ...rest, ...(picture && { picture }) };
    }
    current = next;
    broadcast("parallax:googleAccount", current);
  };
  void read();
  session.cookies.on("changed", (_event, cookie) => {
    if (!cookie.domain?.endsWith("google.com") || !/^(SID|__Secure-[13]PSID)$/.test(cookie.name))
      return;
    // Signing in sets several at once.
    clearTimeout(timer);
    timer = setTimeout(() => void read(), 500);
  });
}
