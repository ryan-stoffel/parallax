import { TriangleAlert } from "lucide-react";
import { useId } from "react";

import type { ProviderInstance } from "../protocol/generated/protocol";
import { menuPanel } from "./ui";

/** Kinds that sign in to a subscription account, where several accounts on one app risk them. */
const subscriptions = new Set(["claude", "codex", "cursor", "grokBuild", "antigravity"]);

/** Whether a host with `instances` already has an account of `kind`, so a new one is another. */
export const hasAccountOf = (kind: string, instances: Pick<ProviderInstance, "kind">[]) =>
  subscriptions.has(kind) && instances.some((i) => i.kind === kind);

/** The ids of `instances` that are another account of a kind listed before them (0088). */
export function extraAccounts(instances: Pick<ProviderInstance, "id" | "kind">[]): Set<string> {
  const seen = new Set<string>();
  const extra = new Set<string>();
  for (const { id, kind } of instances) {
    if (!subscriptions.has(kind)) continue;
    if (seen.has(kind)) extra.add(id);
    else seen.add(kind);
  }
  return extra;
}

const link = "text-accent hover:underline";

/**
 * Why several accounts of one provider aren't supported, and the hub to use instead (0088), with
 * links to CLIProxyAPI's docs and Theo's setup guide.
 */
export function SeveralAccountsNote() {
  return (
    <>
      <p>
        Several accounts of one provider in one app aren't supported. Switching between them puts
        the accounts at risk. For many accounts, use a CLIProxyAPI hub.
      </p>
      <p className="mt-2 flex gap-3">
        <a href="https://help.router-for.me/" target="_blank" rel="noreferrer" className={link}>
          CLIProxyAPI docs
        </a>
        <a
          href="https://gist.github.com/t3dotgg/59a521d2ee8d70aaf90e280c175072af"
          target="_blank"
          rel="noreferrer"
          className={link}
        >
          Theo's setup guide
        </a>
      </p>
    </>
  );
}

/** A warning mark for another account of a provider, whose popover is SeveralAccountsNote. */
export function SeveralAccountsMark() {
  const id = useId();
  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        aria-label="Several accounts"
        aria-haspopup="dialog"
        className="grid size-6 shrink-0 place-items-center rounded-md text-warning hover:bg-hover [&_svg]:size-3.5"
      >
        <TriangleAlert aria-hidden />
      </button>
      <div
        id={id}
        popover="auto"
        role="dialog"
        aria-label="Several accounts"
        className={`${menuPanel()} w-72 p-3 text-body`}
      >
        <SeveralAccountsNote />
      </div>
    </>
  );
}
