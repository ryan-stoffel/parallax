import { Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";

import type { ThemePreference } from "../preload/bridge";
import type { SettingsSection } from "./App";

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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mb-8">
      <h2 className="mb-2 text-[12.5px] font-medium text-muted-foreground">{title}</h2>
      <div className="rounded-xl border border-border bg-surface">{children}</div>
    </section>
  );
}
