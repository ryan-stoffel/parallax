// Forking a thread (0050), from its latest turn, as a sheet: keep its model, or pick another of the
// computer's, which may be another provider's. Choosing one forks it, and opens the fork.
import { t } from "i18next";
import {  } from "react-native";

import type { AgentRun } from "../../desktop/src/protocol/generated/protocol";
import { forkError } from "../../desktop/src/renderer/errors";
import { forkChoiceOf } from "../../desktop/src/renderer/threads";
import { isRunning } from "../../desktop/src/renderer/transcript";
import { Choices, type Choice } from "./Choices";
import { showAlert } from "./dialogStore";
import type { Computer } from "./fleet";
import { useOffers } from "./offers";

const KEEP = "keep";

export function ForkSheet({
  computer,
  run,
  open,
  onClose,
  onForked,
}: {
  computer: Computer;
  run: AgentRun;
  open: boolean;
  onClose: () => void;
  onForked: (runId: string) => void;
}) {
  const offers = useOffers(computer);
  const models = offers.flatMap((offer) => offer.models.map((model) => ({ offer, model })));
  const isKept = (provider: string, id: string) => provider === run.backend && id === (run.model ?? "");
  const kept = models.find(({ model }) => isKept(model.provider, model.id))?.model.name ?? run.model;
  // Two providers can offer a model of the same name, so a value and a line tell them apart.
  const others = models.filter(({ model }) => !isKept(model.provider, model.id));
  const options: Choice<string>[] = [
    { value: KEEP, label: kept ? t("Keep {{model}}", { model: kept }) : t("Keep the current model") },
    ...others.map(({ offer, model }, i) => ({
      value: `${model.provider}/${model.id}`,
      label: model.name,
      description: offer.name,
      ...(i === 0 && { section: t("Or pick another model") }),
    })),
  ];
  const fork = async (value: string) => {
    const other = others.find(({ model }) => `${model.provider}/${model.id}` === value);
    const forked = await computer.view.fork(run.id, undefined, other ? forkChoiceOf(other.model, run) : {});
    if (typeof forked === "string") onForked(forked);
    else showAlert(t("Couldn't fork the thread"), forkError(forked, isRunning(run.status)));
  };
  return (
    <Choices
      title={t("Fork into a new thread")}
      open={open}
      options={options}
      onChoose={(value) => void fork(value)}
      onClose={onClose}
    />
  );
}
