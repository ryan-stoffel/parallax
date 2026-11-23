// Guest links this phone makes (0108). `guest/create` answers a link's secret once, in its
// `fragment`. It's held here in memory, by link id, until the user copies or shares the link, and
// nowhere else: not in a screen's state, the saved setup, preferences, the keychain, or a log.

import type { GuestCreateResult, GuestLink } from "../../desktop/src/protocol/generated/protocol";
import { guestLink } from "../../desktop/src/preload/hostedClient";

/** A computer's `request`, as `Fleet`'s hosts have it. */
type Request = (
  method: string,
  params: unknown,
) => Promise<{ result: unknown } | { error: { message: string } }>;

/** The secrets of the links made here and not copied or shared yet, by link id. */
const secrets = new Map<string, string>();

/**
 * Makes a guest link to thread `threadId`, which ends the thread's last one, and keeps its secret
 * here. Answers the link without its secret, or why not, for people.
 */
export async function createGuestLink(
  request: Request,
  threadId: string,
  canSuggest: boolean,
): Promise<GuestLink | string> {
  const answer = await request("guest/create", { threadId, ...(canSuggest && { canSuggest }) });
  if ("error" in answer) return answer.error.message;
  const { link, fragment } = answer.result as GuestCreateResult;
  secrets.set(link.id, fragment);
  return link;
}

/** Whether link `id`'s secret is still held, so it can be copied or shared. */
export const hasGuestLink = (id: string) => secrets.has(id);

/**
 * Link `id` as its URL, with its secret, for the clipboard or the share sheet only, or undefined
 * once it's gone. The caller calls `forgetGuestLink` as soon as the URL is handed over.
 */
export function guestLinkUrl(id: string): string | undefined {
  const fragment = secrets.get(id);
  return fragment === undefined ? undefined : guestLink(fragment);
}

/** Forgets link `id`'s secret: it was copied or shared, its sheet closed, or it ended. */
export const forgetGuestLink = (id: string) => void secrets.delete(id);
