import { Plus, X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import {
  bindingsOf,
  commandOf,
  commands,
  editingKeys,
  formatKeybinding,
  isDefault,
  keybindingOf,
  modifiers,
  resetBindings,
  setBindings,
  useKeybindings,
  type Command,
} from "../keybindings";
import { rowShortcut, shortcut } from "../ui";
import { PageTitle, quietButton, Row, Section, settingRow } from "./parts";

const kbd =
  "inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 font-sans text-[12px] text-foreground";

/**
 * Settings > Keybinds: every app command with its shortcuts, each removable, plus Add shortcut,
 * which records the next press, and Reset where a command's differ from its defaults.
 */
export function KeybindSettings() {
  useKeybindings();
  const mac = window.parallax.platform === "darwin";
  return (
    <>
      <PageTitle title="Keybinds">
        Shortcuts for the whole app. Repository actions keep their own, set on each action.
      </PageTitle>
      <Section
        title="Shortcuts"
        action={
          <button
            type="button"
            className={quietButton}
            disabled={commands.every((c) => isDefault(c.id))}
            onClick={resetBindings}
          >
            Reset all
          </button>
        }
      >
        {commands.map((c) => (
          <CommandRow key={c.id} command={c.id} name={c.name} />
        ))}
      </Section>
      <Section title="Built in">
        <Row title="Open a sidebar row" description="The first nine threads in the sidebar.">
          <kbd className={kbd}>
            {shortcut("1")} – {shortcut("9")}
          </kbd>
        </Row>
        <Row title="Send a message">
          <kbd className={kbd}>Enter</kbd>
        </Row>
        <Row title="Start a new thread and stay here">
          <kbd className={kbd}>{shortcut("Enter")}</kbd>
        </Row>
        <Row title="New line in a message">
          <kbd className={kbd}>{mac ? "⇧ Enter" : "Shift+Enter"}</kbd>
        </Row>
      </Section>
    </>
  );
}

/** One command: its shortcuts as removable keys, Add shortcut, and Reset when changed. */
function CommandRow({ command, name }: { command: Command; name: string }) {
  const [recording, setRecording] = useState(false);
  const [refused, setRefused] = useState<string>();
  const bindings = bindingsOf(command);

  const record = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Tab") return;
    e.preventDefault();
    // Not the app's shortcut while it's being pressed here.
    e.stopPropagation();
    if (e.key === "Escape") return stop();
    if (modifiers.includes(e.key)) return;
    const next = keybindingOf(e);
    if (!next)
      return setRefused(
        `Hold ${window.parallax.platform === "darwin" ? "⌘ or ⌃" : "Ctrl"} with a key.`,
      );
    const shown = formatKeybinding(next);
    const taken = commandOf(next);
    if (taken === command) return stop();
    if (taken)
      return setRefused(`${shown} already runs ${commands.find((c) => c.id === taken)!.name}.`);
    if (rowShortcut(e) !== undefined) return setRefused(`${shown} opens a sidebar row.`);
    if (editingKeys.includes(e.code)) return setRefused(`${shown} is an editing shortcut.`);
    setBindings(command, [...bindings, next]);
    stop();
  };
  const stop = () => {
    setRecording(false);
    setRefused(undefined);
  };

  return (
    <div className={`${settingRow} flex-wrap`}>
      <div className="min-w-0">
        <span className="block text-[13px] font-medium">{name}</span>
        {refused && (
          <span role="alert" className="block text-[12.5px] text-danger">
            {refused}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {bindings.length === 0 && !recording && (
          <span className="text-[12.5px] text-faint-foreground">None</span>
        )}
        {bindings.map((b) => (
          <kbd key={b} className={kbd}>
            {formatKeybinding(b)}
            <button
              type="button"
              aria-label={`Remove ${formatKeybinding(b)} from ${name}`}
              onClick={() =>
                setBindings(
                  command,
                  bindings.filter((x) => x !== b),
                )
              }
              className="-mr-0.5 rounded text-faint-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3"
            >
              <X aria-hidden />
            </button>
          </kbd>
        ))}
        {recording ? (
          <input
            autoFocus
            readOnly
            aria-label={`New shortcut for ${name}`}
            placeholder="Press a shortcut"
            onKeyDown={record}
            onBlur={stop}
            className="w-36 rounded-md border border-accent bg-background px-2 py-0.5 text-[12px] placeholder:text-muted-foreground"
          />
        ) : (
          <button
            type="button"
            aria-label={`Add a shortcut to ${name}`}
            onClick={() => setRecording(true)}
            className={`${quietButton} flex items-center gap-1 [&_svg]:size-3.5`}
          >
            <Plus aria-hidden />
            Add
          </button>
        )}
        {!isDefault(command) && (
          <button
            type="button"
            className={quietButton}
            onClick={() => {
              setBindings(command, undefined);
              stop();
            }}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
