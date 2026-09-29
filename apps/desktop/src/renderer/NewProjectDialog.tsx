import { Folder, X } from "lucide-react";
import type { Ref } from "react";

import type { Repo } from "../protocol/generated/protocol";
import { ModelMenu } from "./ModelMenu";
import { IconButton, Picker } from "./ui";

/**
 * The Create Project dialog, a native modal <dialog> (focus trap and Escape
 * come free). Open it with `ref.current.showModal()`. A shell: creating a
 * Project is RYA-46, so the button stays disabled until then.
 */
export function NewProjectDialog({
  ref,
  repositories,
}: {
  ref: Ref<HTMLDialogElement>;
  repositories: Repo[];
}) {
  const row = "flex items-center justify-between gap-4 px-5 py-3";
  const workspaces = repositories.filter((r) => !r.scratch);
  return (
    <dialog
      ref={ref}
      aria-labelledby="new-project-title"
      className="m-auto w-[26rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
    >
      <form method="dialog">
        <div className="flex items-start gap-3 px-5 pt-4 pb-3">
          <div className="flex-1">
            <h2 id="new-project-title" className="text-[15px] font-semibold">
              Create Project
            </h2>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              A focused chat where agents coordinate work.
            </p>
          </div>
          <IconButton label="Close" type="submit" value="cancel">
            <X />
          </IconButton>
        </div>
        <div className={`${row} border-b border-border`}>
          <span aria-hidden className="text-[13px]">
            Workspace
          </span>
          <Picker
            label="Workspace"
            align="end"
            options={workspaces.map((r) => ({ value: r.id, label: r.name, icon: <Folder /> }))}
          />
        </div>
        <div className={row}>
          <span aria-hidden className="text-[13px]">
            Model
          </span>
          <ModelMenu />
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          <p className="text-[12px] text-muted-foreground">
            Creating Projects isn't available yet.
          </p>
          {/* Placeholder until RYA-46 wires project/create. */}
          <button
            type="submit"
            disabled
            className="shrink-0 whitespace-nowrap rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50"
          >
            Create Project
          </button>
        </div>
      </form>
    </dialog>
  );
}
