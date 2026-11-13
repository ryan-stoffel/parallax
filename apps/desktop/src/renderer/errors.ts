import { t } from "i18next";

import type { RpcError } from "../preload/bridge";

/**
 * A failed request, for people. Parallax error kinds the app knows get plain words, matched on
 * `data.kind` and never on the message (0007). Kinds whose message plxd writes to say what to do
 * (`notARepository`, `workerUnavailable`, `worktreeFailed`), unknown kinds, and other errors show
 * plxd's own message.
 */
export function describeError(error: RpcError): string {
  switch (error.data?.kind) {
    case "noDefaultAccount":
      return t("Choose an account to run threads on this host.");
    case "accountNotFound":
      return t("The account for this thread isn't on this host anymore.");
    case "keychainUnavailable":
      return t(
        "Parallax couldn't read the account's API key. Unlock your keychain, then try again.",
      );
    case "repoNotFound":
      return t("That repository isn't in Parallax anymore. Choose another one.");
    default:
      return error.message;
  }
}

/**
 * The short line shown beside Set up GitHub when `error` is plxd's `ghUnavailable`, `gh` missing
 * or signed out on the host (PLX-423). Undefined for any other error.
 */
export function githubProblem(error?: RpcError): string | undefined {
  if (error?.data?.kind !== "ghUnavailable") return undefined;
  // ponytail: reads plxd's wording; give the error's data a reason if that wording changes.
  return error.message.includes("isn't installed")
    ? t("GitHub isn't installed on this host.")
    : t("GitHub isn't signed in on this host.");
}

/** plxd's refusal of `thread/fork` (0050), for people. `running` is whether the thread runs now. */
export function forkError(error: RpcError, running: boolean): string {
  switch (error.data?.kind) {
    case "threadNotFound":
      return t("This thread isn't on this host anymore.");
    case "idConflict":
      return t("That fork's id was already taken. Try again.");
  }
  // invalidParams: a turn that hasn't ended, or one a fork copied from the thread it forked.
  if (error.code === -32602)
    return running
      ? t("This turn is still running. Fork it once it finishes.")
      : t("This turn was copied from another thread. Fork it from that thread.");
  return describeError(error);
}
