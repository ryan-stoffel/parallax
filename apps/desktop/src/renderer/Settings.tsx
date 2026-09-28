import { Monitor, Moon, Plus, Sun } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { ThemePreference } from "../preload/bridge";
import type { SettingsSection } from "./App";
import { useHosts, type Host } from "./hosts";

const themeOptions: { value: ThemePreference; name: string; icon: ReactNode }[] = [
  { value: "system", name: "System", icon: <Monitor /> },
  { value: "light", name: "Wisp Light", icon: <Sun /> },
  { value: "dark", name: "Wisp Dark", icon: <Moon /> },
];

const providers = ["Claude", "Codex"];

interface SettingsProps {
  section: SettingsSection;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
}

/** The Settings page body. The sidebar's SettingsNav picks the section. */
export function Settings({ section, theme, onThemeChange }: SettingsProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 pt-6 pb-16">
        {section === "general" ? (
          <>
            <h1 className="mb-6 text-xl font-semibold">General</h1>
            <Section title="Appearance">
              <fieldset className="flex items-center justify-between gap-6 px-4 py-3.5">
                <legend className="float-left">
                  <span className="block text-[13px] font-medium">Theme</span>
                  <span className="block text-[12.5px] text-muted-foreground">
                    Follows your system unless you pick one.
                  </span>
                </legend>
                <div className="flex gap-0.5 rounded-lg border border-border p-0.5">
                  {themeOptions.map((opt) => (
                    <label
                      key={opt.value}
                      className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] text-muted-foreground hover:text-foreground has-checked:bg-selected has-checked:text-foreground has-focus-visible:outline-2 has-focus-visible:outline-ring [&_svg]:size-3.5"
                    >
                      <input
                        type="radio"
                        name="theme"
                        value={opt.value}
                        checked={theme === opt.value}
                        onChange={() => onThemeChange(opt.value)}
                        className="sr-only"
                      />
                      {opt.icon}
                      {opt.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            </Section>
          </>
        ) : section === "hosts" ? (
          <HostsSettings />
        ) : (
          <>
            <h1 className="mb-1.5 text-xl font-semibold">Providers</h1>
            <p className="mb-6 text-[13px] text-muted-foreground">
              The AI subscriptions your agents run on.
            </p>
            <Section title="Subscriptions">
              {providers.map((name) => (
                <div
                  key={name}
                  className="flex items-center justify-between border-border px-4 py-3.5 not-last:border-b"
                >
                  <span className="text-[13px] font-medium">{name}</span>
                  <span className="text-[12.5px] text-muted-foreground">Not connected</span>
                </div>
              ))}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

const settingRow =
  "flex items-center justify-between gap-4 border-border px-4 py-3 not-last:border-b";
const quietButton =
  "rounded-md px-2.5 py-1 text-[12.5px] text-muted-foreground hover:bg-hover hover:text-foreground";

/** Settings > Hosts: this computer, then the SSH hosts, which can be added, edited, and removed. */
function HostsSettings() {
  const hosts = useHosts();
  // The host whose form is open: its id, "new", or none.
  const [editing, setEditing] = useState<string>();
  const [removeError, setRemoveError] = useState<string>();
  const remove = (id: string) =>
    window.wisp.removeHost(id).then(
      () => setRemoveError(undefined),
      (error: Error) => setRemoveError(error.message),
    );

  return (
    <>
      <h1 className="mb-1.5 text-xl font-semibold">Hosts</h1>
      <p className="mb-6 text-[13px] text-muted-foreground">
        Machines your agents run on. Add one you reach over SSH, such as a Mac mini with wispd
        installed.
      </p>
      {removeError && (
        <p role="alert" className="mb-3 text-[12.5px] text-danger">
          {removeError}
        </p>
      )}
      <Section title="Hosts">
        {hosts.map((h) =>
          editing === h.id ? (
            <HostForm key={h.id} host={h} onDone={() => setEditing(undefined)} />
          ) : (
            <div key={h.id} className={settingRow}>
              <div className="min-w-0">
                <span className="block truncate text-[13px] font-medium">{h.name}</span>
                <span className="block truncate text-[12.5px] text-muted-foreground">
                  {h.destination ?? "This computer"}
                </span>
              </div>
              {h.destination && (
                <div className="flex shrink-0 gap-1">
                  <button type="button" className={quietButton} onClick={() => setEditing(h.id)}>
                    Edit
                  </button>
                  <button type="button" className={quietButton} onClick={() => void remove(h.id)}>
                    Remove
                  </button>
                </div>
              )}
            </div>
          ),
        )}
        {editing === "new" ? (
          <HostForm onDone={() => setEditing(undefined)} />
        ) : (
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="flex w-full items-center gap-2 rounded-b-xl px-4 py-3 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4"
          >
            <Plus aria-hidden />
            Add host
          </button>
        )}
      </Section>
    </>
  );
}

const field =
  "mt-1 block w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] placeholder:text-faint-foreground";

/** Adds a host, or edits `host`. `onDone` runs once it's saved or cancelled. */
function HostForm({ host, onDone }: { host?: Host; onDone: () => void }) {
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const save = async (form: HTMLFormElement) => {
    // Text inputs' values are strings.
    const data = new FormData(form);
    setSaving(true);
    const input = {
      name: data.get("name") as string,
      destination: data.get("destination") as string,
    };
    const failed = await window.wisp.saveHost(input, host?.id);
    setSaving(false);
    if (failed) setError(failed);
    else onDone();
  };

  return (
    <form
      aria-label={host ? `Edit ${host.name}` : "Add host"}
      onSubmit={(e) => {
        e.preventDefault();
        void save(e.currentTarget);
      }}
      className="flex flex-col gap-3 border-border px-4 py-3.5 not-last:border-b"
    >
      <label className="text-[12.5px] text-muted-foreground">
        Name
        <input name="name" defaultValue={host?.name} placeholder="Mac mini" className={field} />
      </label>
      <label className="text-[12.5px] text-muted-foreground">
        SSH destination
        <input
          name="destination"
          required
          defaultValue={host?.destination}
          placeholder="mac-mini, or me@192.168.1.20"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className={field}
        />
        <span className="mt-1 block text-faint-foreground">
          Anything ssh accepts. wisp uses your ssh config and keys.
        </span>
      </label>
      {error && (
        <p role="alert" className="text-[12.5px] text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className={quietButton}>
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-primary px-3 py-1 text-[12.5px] font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50"
        >
          {host ? "Save" : "Add host"}
        </button>
      </div>
    </form>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mb-8">
      <h2 className="mb-2 text-[12.5px] font-medium text-muted-foreground">{title}</h2>
      <div className="rounded-xl border border-border bg-surface">{children}</div>
    </section>
  );
}
