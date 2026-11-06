import { Braces, Plus, RotateCcw, Search, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import {
  applyBindingsJson,
  bindingOf,
  bindingsJson,
  commandCategories,
  commandOf,
  commands,
  editingKeys,
  formatKeybinding,
  isDefault,
  keybindingOf,
  keysOf,
  modifiers,
  resetBinding,
  resetBindings,
  setBinding,
  setWhen,
  useKeybindings,
  whenOf,
  whenOptions,
  type Command,
  type When,
} from "../keybindings";
import { IconButton, Picker, rowShortcut, searchField, shortcut } from "../ui";
import { field, outlineButton, PageTitle, primaryButton, quietButton, Section } from "./parts";
import { anchorOf } from "./search";

const nameOf = (command: Command) => commands.find((c) => c.id === command)!.name;

/** One key, as a keycap. */
const cap =
  "inline-grid h-7 min-w-7 place-items-center rounded-md bg-hover px-1.5 font-sans text-meta text-foreground";

/** A binding's keys, each its own cap. */
function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((key, i) => (
        <kbd key={i} className={cap}>
          {key}
        </kbd>
      ))}
    </span>
  );
}

/**
 * What a press means for `command`, or why it can't have it: a lone modifier or Tab is nothing yet,
 * `taken` names the command that owns it.
 */
function readPress(
  e: KeyboardEvent<HTMLElement>,
  command: Command | undefined,
): { key: string } | { refused: string } | { taken: Command; key: string } | undefined {
  if (modifiers.includes(e.key)) return undefined;
  const key = keybindingOf(e);
  if (!key)
    return {
      refused: `Hold ${window.parallax.platform === "darwin" ? "⌘ or ⌃" : "Ctrl"} with a key.`,
    };
  const shown = formatKeybinding(key);
  if (rowShortcut(e) !== undefined) return { refused: `${shown} opens a sidebar row.` };
  if (editingKeys.includes(e.code)) return { refused: `${shown} is an editing shortcut.` };
  const taken = commandOf(key);
  if (taken && taken !== command) return { taken, key };
  return { key };
}

/**
 * The button that shows a binding, and records a new one once clicked: the next press is it,
 * Escape keeps the old one, and Backspace or Delete leaves `onClear` to take it off. `onPress` gets
 * each press while recording.
 */
function Recorder({
  label,
  value,
  onPress,
  onClear,
  onCancel,
  wide,
}: {
  label: string;
  value?: string;
  onPress: (e: KeyboardEvent<HTMLElement>) => boolean;
  onClear?: () => void;
  onCancel?: () => void;
  wide?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const stop = () => {
    setRecording(false);
    onCancel?.();
  };
  return (
    <button
      type="button"
      aria-label={recording ? `Press the keys for ${label}` : `Change the keys for ${label}`}
      onClick={() => setRecording(!recording)}
      onBlur={() => recording && stop()}
      onKeyDown={(e) => {
        if (!recording) return;
        // Leaves Tab to move on, which ends recording.
        if (e.key === "Tab") return;
        e.preventDefault();
        // Not the app's shortcut while it's being pressed here, nor Settings' Escape.
        e.stopPropagation();
        if (e.key === "Escape") return stop();
        if (onClear && (e.key === "Backspace" || e.key === "Delete")) {
          setRecording(false);
          return onClear();
        }
        if (onPress(e)) setRecording(false);
      }}
      className={`flex h-9 items-center rounded-lg border px-1 ${wide ? "w-full" : "justify-end"} ${recording ? "border-accent ring-2 ring-accent/40" : "border-transparent hover:border-border"} ${!value && !recording ? "text-faint-foreground" : ""}`}
    >
      {recording ? (
        <span className="px-2 text-body text-muted-foreground">Press keys…</span>
      ) : value ? (
        <Keys keys={keysOf(value)} />
      ) : (
        <span className="px-2 font-mono text-body">Unassigned</span>
      )}
    </button>
  );
}

/** A command's When, as a borderless menu in code type. */
function WhenPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: When;
  onChange: (when: When) => void;
}) {
  return (
    <span className="flex items-center gap-2 text-meta">
      <span className="text-faint-foreground">When</span>
      <Picker
        label={label}
        value={value}
        onChange={(next) => onChange(next as When)}
        options={whenOptions.map((w) => ({
          value: w.value,
          label: w.label,
          description: w.detail,
        }))}
        panelClassName="w-80"
        className="-ml-1 font-mono text-meta text-muted-foreground"
      />
    </span>
  );
}

/** What a press refused or a key's owner says, under a row or the Add card. */
function Problem({ children }: { children: ReactNode }) {
  return (
    <span role="alert" className="flex flex-wrap items-center gap-2 text-meta text-danger">
      {children}
    </span>
  );
}

/** A command: its name and When on the left, its keys on the right, and Reset and Clear on hover. */
function CommandRow({ command }: { command: Command }) {
  const [refused, setRefused] = useState<string>();
  const [conflict, setConflict] = useState<{ taken: Command; key: string }>();
  const name = nameOf(command);
  const binding = bindingOf(command);
  const clear = () => {
    setRefused(undefined);
    setConflict(undefined);
  };

  return (
    <div
      data-setting={anchorOf(name)}
      className="group flex items-center justify-between gap-4 border-border/40 px-4 py-2.5 not-last:border-b"
    >
      <div className="min-w-0">
        <span className="block text-body font-medium">{name}</span>
        <WhenPicker
          label={`When ${name} applies`}
          value={whenOf(command)}
          onChange={(when) => setWhen(command, when)}
        />
        {refused && <Problem>{refused}</Problem>}
        {conflict && (
          <Problem>
            {formatKeybinding(conflict.key)} already runs {nameOf(conflict.taken)}.
            <button
              type="button"
              className="font-medium underline"
              onClick={() => {
                setBinding(conflict.taken, null);
                setBinding(command, conflict.key);
                clear();
              }}
            >
              Replace it
            </button>
            <button type="button" className="underline" onClick={clear}>
              Keep it
            </button>
          </Problem>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!isDefault(command) && (
          <IconButton
            reveal
            label={`Reset ${name}`}
            onClick={() => {
              resetBinding(command);
              clear();
            }}
          >
            <RotateCcw aria-hidden />
          </IconButton>
        )}
        {binding && (
          <IconButton
            reveal
            label={`Remove the keys for ${name}`}
            onClick={() => {
              setBinding(command, null);
              clear();
            }}
          >
            <X aria-hidden />
          </IconButton>
        )}
        <Recorder
          label={name}
          value={binding}
          onClear={() => setBinding(command, null)}
          onCancel={() => setRefused(undefined)}
          onPress={(e) => {
            const press = readPress(e, command);
            if (!press) return false;
            clear();
            if ("refused" in press) {
              setRefused(press.refused);
              return false;
            }
            if ("taken" in press) {
              setConflict(press);
              return true;
            }
            setBinding(command, press.key);
            return true;
          }}
        />
      </div>
    </div>
  );
}

/**
 * Add keybinding's card: a command, its When, and its keys, which Save gives it, in place of any it
 * had. A key another command owns moves here on Save, as the card says.
 */
function NewBinding({ onClose }: { onClose: () => void }) {
  const [command, setCommand] = useState<Command>();
  const [when, setChosenWhen] = useState<When>("always");
  const [key, setKey] = useState<string>();
  const [refused, setRefused] = useState<string>();
  const owner = key ? commandOf(key) : undefined;
  const taken = owner && owner !== command ? owner : undefined;
  const had = command && bindingOf(command);

  return (
    <div
      role="group"
      aria-label="New keybinding"
      className="mb-10 rounded-xl border border-border/40 bg-(--pane-card) px-4 py-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <span className="block text-body font-medium">New keybinding</span>
          <WhenPicker label="When it applies" value={when} onChange={setChosenWhen} />
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <Picker
            field
            label="Command"
            placeholder="Command"
            value={command ?? ""}
            onChange={(next) => setCommand(next as Command)}
            options={[...commands]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((c) => ({ value: c.id, label: c.name }))}
            search="Search commands"
            align="start"
            className="w-72"
            panelClassName="w-80"
          />
          <span className="w-44 shrink-0 rounded-lg border border-border bg-background">
            <Recorder
              wide
              label="the new keybinding"
              value={key}
              onPress={(e) => {
                const press = readPress(e, command);
                if (!press) return false;
                if ("refused" in press) {
                  setRefused(press.refused);
                  return false;
                }
                setRefused(undefined);
                setKey(press.key);
                return true;
              }}
            />
          </span>
          <button
            type="button"
            className={primaryButton}
            disabled={!command || !key}
            onClick={() => {
              if (taken) setBinding(taken, null);
              setBinding(command!, key!);
              setWhen(command!, when);
              onClose();
            }}
          >
            Save
          </button>
          <IconButton label="Cancel the new keybinding" onClick={onClose}>
            <X aria-hidden />
          </IconButton>
        </div>
      </div>
      {(refused || taken || had) && (
        <p className="mt-2 text-right text-meta text-muted-foreground">
          {refused ? (
            <span role="alert" className="text-danger">
              {refused}
            </span>
          ) : taken ? (
            `Moves ${formatKeybinding(key!)} from ${nameOf(taken)}.`
          ) : (
            `Replaces ${formatKeybinding(had!)}. A command has one shortcut.`
          )}
        </p>
      )}
    </div>
  );
}

/** Every binding as JSON to edit, applied whole or not at all. */
function JsonEditor({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState(bindingsJson);
  const [errors, setErrors] = useState<string[]>([]);
  return (
    <div className="mb-10 flex flex-col gap-2 rounded-xl border border-border/40 bg-(--pane-card) px-4 py-3.5">
      <p className="text-meta text-muted-foreground">
        Each command by id, with <code className="font-mono">key</code> as{" "}
        <code className="font-mono">Mod+KeyK</code>, or <code className="font-mono">null</code> for
        none, and <code className="font-mono">when</code> as one of{" "}
        <code className="font-mono">{whenOptions.map((w) => w.value).join(", ")}</code>.
      </p>
      <textarea
        aria-label="Keybindings as JSON"
        spellCheck={false}
        rows={14}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className={`${field} font-mono`}
      />
      {errors.length > 0 && (
        <ul role="alert" className="text-meta text-danger">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <span className="flex justify-end gap-2">
        <button type="button" className={quietButton} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={primaryButton}
          onClick={() => {
            const problems = applyBindingsJson(text);
            setErrors(problems);
            if (problems.length === 0) onClose();
          }}
        >
          Apply
        </button>
      </span>
    </div>
  );
}

/** A shortcut that can't be changed: its name and what it does, and its keys. */
function BuiltIn({
  title,
  description,
  keys,
}: {
  title: string;
  description?: string;
  keys: string[];
}) {
  return (
    <div
      data-setting={anchorOf(title)}
      className="flex items-center justify-between gap-4 border-border/40 px-4 py-2.5 not-last:border-b"
    >
      <div className="min-w-0">
        <span className="block text-body font-medium">{title}</span>
        {description && (
          <span className="block text-meta text-muted-foreground">{description}</span>
        )}
      </div>
      <span className="pr-1">
        <Keys keys={keys} />
      </span>
    </div>
  );
}

/**
 * Settings > Keybindings: a search, Add keybinding, and the JSON editor over every app command by
 * category. Each command has one shortcut at most and a When: clicking its keys records new ones.
 * Repository actions keep their own, set on each action.
 */
export function KeybindSettings() {
  useKeybindings();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [json, setJson] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  const mac = window.parallax.platform === "darwin";
  useEffect(() => {
    if (query) box.current?.focus();
  }, [query]);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found = commands.filter((c) => {
    const binding = bindingOf(c.id);
    const text =
      `${c.name} ${c.category} ${whenOf(c.id)} ${binding ? `${formatKeybinding(binding)} ${binding}` : "unassigned"}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const builtIn = (mod: (keys: string) => string) => [
    {
      title: "Open a sidebar row",
      description: "The first nine threads in the sidebar.",
      keys: [mod("1"), "–", mod("9")],
    },
    {
      title: "Send a message",
      description: "While an agent runs, Enter queues the message for its next turn.",
      keys: ["Enter"],
    },
    {
      title: "Steer an agent now",
      description: "In an active thread, send into the current turn.",
      keys: [mod("Enter")],
    },
    { title: "Start a new thread and stay here", keys: [mod("Enter")] },
    { title: "New line in a message", keys: [mac ? "⇧ Enter" : "Shift+Enter"] },
  ];

  return (
    <>
      <PageTitle
        title="Keybindings"
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
        Shortcuts for the whole app. Each command has one. Click its keys to change them, then
        Backspace to remove them. Repository actions keep their own.
      </PageTitle>
      <div className="mb-10 flex items-center gap-2 rounded-xl border border-border/40 bg-(--pane-card) p-3">
        <label className={`${searchField} flex min-w-0 flex-1 items-center gap-2`}>
          <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
          <input
            ref={box}
            type="search"
            aria-label="Search keybindings"
            placeholder="Search keybindings"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape" || !query) return;
              // Clearing it leaves Settings open; Escape again closes it.
              e.preventDefault();
              setQuery("");
            }}
            className="min-w-0 flex-1 bg-transparent text-body placeholder:text-faint-foreground focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
        </label>
        <button
          type="button"
          className={`${outlineButton} h-9 px-3`}
          onClick={() => {
            setAdding(true);
            setJson(false);
          }}
        >
          <Plus aria-hidden />
          Add keybinding
        </button>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border">
          <IconButton
            label="Edit keybindings as JSON"
            onClick={() => {
              setJson(!json);
              setAdding(false);
            }}
          >
            <Braces aria-hidden />
          </IconButton>
        </span>
      </div>
      {adding && <NewBinding onClose={() => setAdding(false)} />}
      {json && <JsonEditor onClose={() => setJson(false)} />}
      {commandCategories.map((category) => {
        const rows = found.filter((c) => c.category === category);
        return (
          rows.length > 0 && (
            <Section key={category} title={category}>
              {rows.map((c) => (
                <CommandRow key={c.id} command={c.id} />
              ))}
            </Section>
          )
        );
      })}
      {found.length === 0 && (
        <p className="mb-10 py-6 text-center text-body text-faint-foreground">
          No keybindings match “{query.trim()}”
        </p>
      )}
      {!query && (
        <Section title="Built in">
          {builtIn(shortcut).map((b) => (
            <BuiltIn key={b.title} {...b} />
          ))}
        </Section>
      )}
    </>
  );
}
