import { ArrowUp, GitBranch, Laptop, Server } from "lucide-react";
import { useState } from "react";

import type { ComposerOptions } from "./placeholder";
import { Picker } from "./ui";

/**
 * The prompt box with its inline model, effort, and permission controls, and
 * the workspace and branch bar under it. A visual shell: sending arrives with
 * the wispd connection (RYA-12).
 */
export function Composer({
  hero,
  localHost,
  options,
}: {
  hero: boolean;
  localHost: boolean;
  options: ComposerOptions;
}) {
  const { models, efforts, permissions, branches } = options;
  const [model, setModel] = useState("Opus 5.5");
  const [effort, setEffort] = useState("High effort");
  const [permission, setPermission] = useState("Ask before edits");
  const [workspace, setWorkspace] = useState("local");
  const [branch, setBranch] = useState("main");

  return (
    <div className="w-full">
      <form
        onSubmit={(e) => e.preventDefault()}
        className="rounded-2xl border border-border bg-surface shadow-composer focus-within:border-ring/50"
      >
        <label htmlFor="composer-input" className="sr-only">
          Message
        </label>
        <textarea
          id="composer-input"
          rows={hero ? 3 : 2}
          placeholder="Ask for a change, or describe a task"
          className="block w-full resize-none bg-transparent px-4 pt-3.5 text-[14px] leading-relaxed placeholder:text-faint-foreground focus-visible:outline-none"
        />
        <div className="flex items-center gap-0.5 px-2 pt-1 pb-2">
          <Picker label="Model" value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((group) => (
              <optgroup key={group.provider} label={group.provider}>
                {group.models.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </optgroup>
            ))}
          </Picker>
          <Picker label="Effort" value={effort} onChange={(e) => setEffort(e.target.value)}>
            {efforts.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </Picker>
          <Picker
            label="Permissions"
            value={permission}
            onChange={(e) => setPermission(e.target.value)}
          >
            {permissions.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </Picker>
          <button
            type="submit"
            aria-label="Send"
            disabled
            className="ml-auto grid size-8 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-25"
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
      </form>
      <div className="flex items-center gap-0.5 px-2 pt-2">
        <Picker
          label="Workspace"
          icon={localHost ? <Laptop /> : <Server />}
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
        >
          <option value="local">Local checkout</option>
          <option value="worktree">New worktree</option>
        </Picker>
        <Picker
          label="Branch"
          icon={<GitBranch />}
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        >
          {branches.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </Picker>
      </div>
    </div>
  );
}
