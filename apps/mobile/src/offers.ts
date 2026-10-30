// The provider instances a computer offers a thread, as the desktop's model catalog lists them
// (models.ts): each one's models, effort, and access levels, from `providers/list`.
import { useEffect, useState } from "react";

import type { AgentPermission, ProvidersListResult } from "../../desktop/src/protocol/generated/protocol";
import { instanceModels, models as builtIn, type Model } from "../../desktop/src/renderer/catalog";
import type { Computer } from "./fleet";

/**
 * A provider instance a thread can run on, as the desktop's catalog has it (models.ts): its
 * models, whether it takes an effort, and its access levels.
 */
export interface Offer {
  id: string;
  name: string;
  /** Its kind, such as `claude`, which picks its mark (logos.tsx). */
  kind: string;
  models: Model[];
  efforts: boolean;
  permissions: AgentPermission[];
  /** Whether it can run an orchestrator. */
  orchestrator: boolean;
}

export const allAccess: AgentPermission[] = ["manual", "edit", "auto", "plan", "bypass"];

/** The provider instances on `computer` (`providers/list`), or on an older plxd, the built-in three. */
export function useOffers(computer: Computer | undefined): Offer[] {
  const [listed, setListed] = useState<ProvidersListResult>();
  const id = computer?.machine.id;
  const providers = computer?.connected && "providers" in (computer.view.capabilities ?? {});
  useEffect(() => {
    if (!id || !providers) return;
    void window.parallax.request(id, "providers/list", { refresh: false }).then((answer) => {
      if (!("error" in answer)) setListed(answer.result);
    });
  }, [id, providers]);
  if (listed)
    return listed.providers
      .filter((info) => info.instance.enabled)
      .map((info) => ({
        id: info.instance.id,
        name: info.instance.name,
        kind: info.instance.kind,
        models: instanceModels(info),
        efforts: info.efforts,
        permissions: info.permissions,
        orchestrator: info.orchestrator,
      }));
  return [
    { id: "claude", name: "Claude", efforts: true, permissions: allAccess, orchestrator: true },
    { id: "codex", name: "Codex", efforts: true, permissions: ["manual", "edit", "auto", "bypass"], orchestrator: false },
    { id: "cursor", name: "Cursor", efforts: false, permissions: ["edit", "plan", "auto", "bypass"], orchestrator: false },
  ].map((o) => ({ ...o, kind: o.id, models: builtIn.filter((m) => m.provider === o.id) }) as Offer);
}
