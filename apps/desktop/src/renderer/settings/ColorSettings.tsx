import { Braces, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";

import { IconButton, Segmented } from "../ui";
import {
  colorTokens,
  customColors,
  parseJsonc,
  schemeTokens,
  type Mode,
  type Tokens,
} from "../vscodeThemes";
import { field, primaryButton, quietButton, Row, Section } from "./parts";

type Theme = { id: string; name: string; mode: Mode; tokens?: Tokens };

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
  const base = useMemo(
    () => ({ ...schemeTokens(mode, Object.keys(colorTokens)), ...theme.tokens }),
    [mode, theme],
  );

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

  const count = Object.keys(changed).length;
  return (
    <Section title="Colors">
      <Row
        title="Customize"
        description={`${theme.name}, the ${mode} theme. ${count ? `${count} changed. ` : ""}Each theme keeps its own changes.`}
      >
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
      </Row>
      {json === undefined ? (
        <div className="grid grid-cols-2 border-b border-border">
          {Object.entries(colorTokens).map(([token, name], i) => {
            const value = changed[token] ?? base[token];
            return (
              <label
                key={token}
                className={`flex h-11 cursor-pointer items-center gap-3 border-border px-4 hover:bg-hover ${i % 2 ? "" : "border-r"} ${i < Object.keys(colorTokens).length - 2 ? "border-b" : ""}`}
              >
                <span className="min-w-0 flex-1 truncate text-body">{name}</span>
                {changed[token] && (
                  <IconButton
                    label={`Reset ${name}`}
                    onClick={(e) => {
                      e.preventDefault();
                      setColor(token);
                    }}
                  >
                    <RotateCcw />
                  </IconButton>
                )}
                <span className="font-mono text-meta text-muted-foreground uppercase">
                  {value?.startsWith("#") ? value : toHex(value)}
                </span>
                <input
                  type="color"
                  aria-label={name}
                  value={toHex(value)}
                  onChange={(e) => setColor(token, e.target.value)}
                  className="size-5 shrink-0 cursor-pointer appearance-none rounded-full border border-border bg-transparent p-0 [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0"
                />
              </label>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
          <p className="text-body text-muted-foreground">
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
            <ul role="alert" className="text-body text-danger">
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
      <div className="flex items-center justify-between px-4 py-2">
        <button
          type="button"
          className={`${quietButton} flex items-center gap-1.5`}
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
          <Braces aria-hidden className="size-3.5" />
          {json === undefined ? "Edit as JSON" : "Close JSON"}
        </button>
        <button
          type="button"
          disabled={count === 0}
          className={`${quietButton} disabled:opacity-40`}
          onClick={() => save({})}
        >
          Reset all
        </button>
      </div>
    </Section>
  );
}
