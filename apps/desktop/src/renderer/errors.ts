import type { RpcError } from "../preload/bridge";

/**
 * A failed request, for people. Wisp error kinds the app knows get plain words, matched on
 * `data.kind` and never on the message (0007). Kinds whose message wispd writes to say what to do
 * (`notARepository`, `workerUnavailable`, `worktreeFailed`), unknown kinds, and other errors show
 * wispd's own message.
 */
export function describeError(error: RpcError): string {
  switch (error.data?.kind) {
    case "noDefaultAccount":
      return "Choose an account to run threads on this host.";
    case "accountNotFound":
      return "The account for this thread isn't on this host anymore.";
    case "keychainUnavailable":
      return "wisp couldn't read the account's API key. Unlock your keychain, then try again.";
    case "repoNotFound":
      return "That repository isn't in wisp anymore. Choose another one.";
    default:
      return error.message;
  }
}
