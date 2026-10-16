import { RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";

import { IconButton, Segmented } from "../ui";
import { colorTokens, customColors, parseJsonc, type Mode, type Tokens } from "../vscodeThemes";
import { field, primaryButton, quietButton, Section } from "./parts";

type Theme = { id: string; name: string; mode: Mode; tokens?: Tokens };

/** Parallax's own colors for `mode`, as index.css's .scheme-light or .scheme-dark sets them. */
function schemeTokens(mode: Mode): Tokens {
  const probe = document.createElement("span");
  probe.className = `scheme-${mode}`;
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const tokens = Object.fromEntries(
    Object.keys(colorTokens).map((t) => [t, style.getPropertyValue(t).trim()]),
  );
  probe.remove();
  return tokens;
}

/** `color` as the #rrggbb a color picker takes, or black where it can't be one. */
function toHex(color: string | undefined) {
  if (color && /^#[0-9a-f]{6}$/i.test(color)) return color;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx || !color) return "#000000";
  ctx.fillStyle = "#000000";
  ctx.fillStyle = color;
  return ctx.fillStyle.startsWith("#") ? ctx.fillStyle : "#000000";
}

/**
 * Settings > Appearance > Colors: colors changed over the theme each mode shows, as VS Code's
 * `workbench.colorCustomizations`. A picker for each of `colorTokens`, or Edit as JSON, which also
 * takes VS Code's color keys. `colors` is by theme id, as Appearance keeps it.
 */
export function ColorSettings({
  themes,
  shown,
  colors,
  onChange,
}: {
  themes: Theme[];
  shown: Record<Mode, string>;
  colors: Record<string, Tokens>;
  onChange: (colors: Record<string, Tokens>) => void;
}) {
  const [mode, setMode] = useState<Mode>(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  // The JSON being edited, while Edit as JSON is open.
  const [json, setJson] = useState<string>();
  const [errors, setErrors] = useState<string[]>([]);
  const theme = themes.find((t) => t.id === shown[mode])!;
  const changed = colors[theme.id] ?? {};
  const base = useMemo(() => ({ ...schemeTokens(mode), ...theme.tokens }), [mode, theme]);

  const save = (tokens: Tokens) => {
    const { [theme.id]: _, ...rest } = colors;
    onChange(Object.keys(tokens).length ? { ...rest, [theme.id]: tokens } : rest);
  };
  const setColor = (token: string, value?: string) => {
    const { [token]: _, ...rest } = changed;
    save(value ? { ...rest, [token]: value } : rest);
  };
  const closeJson = () => {
    setJson(undefined);
    setErrors([]);
  };
  const applyJson = (text: string) => {
    try {
      const { tokens, errors } = customColors(parseJsonc(text));
      setErrors(errors);
      if (errors.length) return;
      save(tokens);
      setJson(undefined);
    } catch (error) {
      setErrors([(error as Error).message]);
    }
  };

  return (
    <Section
      title="Colors"
      action={
        <span className="flex items-center gap-2">
          {Object.keys(changed).length > 0 && (
            <button type="button" className={quietButton} onClick={() => save({})}>
              Reset all
            </button>
          )}
          <button
            type="button"
            className={quietButton}
            onClick={() =>
              json === undefined
                ? setJson(
                    JSON.stringify(
                      Object.fromEntries(
                        Object.entries(changed).map(([k, v]) => [k.replace(/^--/, ""), v]),
                      ),
                      null,
                      2,
                    ),
                  )
                : closeJson()
            }
          >
            {json === undefined ? "Edit as JSON" : "Close JSON"}
          </button>
          <Segmented
            label="Theme to change"
            options={[
              { value: "light", name: "Light" },
              { value: "dark", name: "Dark" },
            ]}
            value={mode}
            onChange={(m) => {
              setMode(m);
              closeJson();
            }}
          />
        </span>
      }
    >
      <p className="px-4 pt-3 text-[12.5px] text-muted-foreground">
        Changes to {theme.name}, the {mode} theme. Each theme keeps its own.
      </p>
      {json === undefined ? (
        <div className="grid grid-cols-2 gap-x-6 px-4 py-2">
          {Object.entries(colorTokens).map(([token, name]) => (
            <div key={token} className="flex h-9 items-center gap-2.5">
              <input
                type="color"
                aria-label={name}
                value={toHex(changed[token] ?? base[token])}
                onChange={(e) => setColor(token, e.target.value)}
                className="size-6 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-0 [&::-webkit-color-swatch]:rounded-[5px] [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0"
              />
              <span className="min-w-0 flex-1 truncate text-[13px]">{name}</span>
              {changed[token] && (
                <IconButton label={`Reset ${name}`} onClick={() => setColor(token)}>
                  <RotateCcw />
                </IconButton>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2 px-4 pt-1 pb-3">
          <p className="text-[12.5px] text-muted-foreground">
            Token names like <code>accent</code> or <code>sidebar</code>, or VS Code&apos;s color
            keys like <code>editor.background</code>, <code>sideBar.background</code>, and{" "}
            <code>focusBorder</code>. Any CSS color, including see-through ones like{" "}
            <code>#ffffff14</code>.
          </p>
          <textarea
            aria-label="Colors as JSON"
            spellCheck={false}
            rows={10}
            value={json}
            onChange={(e) => setJson(e.target.value)}
            className={`${field} font-mono`}
          />
          {errors.length > 0 && (
            <ul role="alert" className="text-[12.5px] text-danger">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <span className="flex justify-end gap-2">
            <button type="button" className={quietButton} onClick={closeJson}>
              Cancel
            </button>
            <button type="button" className={primaryButton} onClick={() => applyJson(json)}>
              Apply
            </button>
          </span>
        </div>
      )}
    </Section>
  );
}
