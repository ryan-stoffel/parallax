import { Atom, Package } from "../icons";
import { useEffect, useState, type ReactNode } from "react";

import {
  bundledFonts,
  codeSizes,
  loadSystemFonts,
  setAppearance,
  uiSizes,
  useAppearance,
  type SystemFonts,
} from "../appearance";
import { Chip } from "../Mention";
import { Picker, type PickerOption } from "../ui";
import { Row, Section, Switch } from "./parts";

const preview = "mx-4 mb-3.5 rounded-lg border border-border bg-background outline-none";

/**
 * Appearance's Text: the interface and code fonts and sizes, a preview of each, and Word wrap.
 * Either font can be any installed one, one Parallax ships, or any name typed in its search.
 */
export function TypographySettings() {
  const appearance = useAppearance();
  const [fonts, setFonts] = useState<SystemFonts>({ mono: [], other: [], complete: false });
  useEffect(() => void loadSystemFonts().then(setFonts), []);
  // The system's list may need a user gesture: a press on a font menu tries again.
  const retry = () => fonts.complete || void loadSystemFonts().then(setFonts);
  return (
    <Section title="Text">
      <Row title="Interface font" description="Menus, chat, and everything outside code.">
        <span onPointerDown={retry} className="flex gap-2">
          <FontPicker
            label="Interface font"
            value={appearance.uiFont}
            defaultName="Inter"
            defaultFamily="var(--font-sans)"
            bundled={bundledFonts.ui}
            groups={[["Installed", [...fonts.other, ...fonts.mono]]]}
            onChange={(uiFont) => setAppearance({ uiFont })}
          />
          <SizePicker
            label="Interface font size"
            value={appearance.uiSize}
            sizes={uiSizes}
            onChange={(uiSize) => setAppearance({ uiSize })}
          />
        </span>
      </Row>
      <Row title="Code font" description="Code blocks, diffs, file previews, and the terminal.">
        <span onPointerDown={retry} className="flex gap-2">
          <FontPicker
            label="Monospace font"
            value={appearance.codeFont}
            defaultName="JetBrains Mono"
            defaultFamily='"JetBrains Mono Nerd Font"'
            bundled={bundledFonts.code}
            groups={[
              ["Installed monospace", fonts.mono],
              ["Other installed fonts", fonts.other],
            ]}
            onChange={(codeFont) => setAppearance({ codeFont })}
          />
          <SizePicker
            label="Monospace font size"
            value={appearance.codeSize}
            sizes={codeSizes}
            onChange={(codeSize) => setAppearance({ codeSize })}
          />
        </span>
      </Row>
      <div className="border-b border-border pt-3.5">
        {/* Typing here only tries the font; nothing is kept. */}
        <div
          role="textbox"
          aria-label="Interface font preview"
          aria-multiline
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          className={`${preview} px-4 py-3 text-reading leading-relaxed`}
        >
          Use <Chip icon={<Package />}>Frontend Design</Chip> to fix the flaky test in{" "}
          <Chip icon={<span className="text-micro font-semibold">TS</span>} tone="file">
            surface.test.ts
          </Chip>{" "}
          and align the header with{" "}
          <Chip icon={<Atom />} tone="file">
            SettingsPanels.tsx
          </Chip>{" "}
          before shipping.
        </div>
        <DiffPreview />
      </div>
      <Row
        title="Word wrap"
        description="Wrap long lines in code blocks, diffs, and file previews by default."
      >
        <Switch
          label="Word wrap"
          checked={appearance.wordWrap}
          onChange={(wordWrap) => setAppearance({ wordWrap })}
        />
      </Row>
    </Section>
  );
}

const kw = "text-project-pink";
const fn = "text-project-violet";
const ty = "text-project-teal";
const str = "text-project-green";

/** A one-line change to a file, in the monospace font, wrapped as Word wrap says. */
function DiffPreview() {
  const line = (n: number, op: " " | "-" | "+", code: ReactNode) => (
    <div className={`flex ${op === "-" ? "bg-danger/15" : op === "+" ? "bg-added/15" : ""}`}>
      <span
        aria-hidden
        className={`w-1 shrink-0 ${op === "-" ? "bg-danger" : op === "+" ? "bg-added" : ""}`}
      />
      <span aria-hidden className="w-9 shrink-0 pr-3 text-right text-faint-foreground select-none">
        {n}
      </span>
      <span className="code-lines min-w-0 whitespace-pre-wrap">{code}</span>
    </div>
  );
  return (
    <div
      aria-label="Diff preview"
      role="group"
      className={`${preview} code-scroll overflow-hidden bg-code font-mono text-meta leading-6`}
    >
      <div className="flex items-center gap-2 px-4 py-2 font-sans text-body">
        <span
          aria-hidden
          className="grid size-4 place-items-center rounded-full border-2 border-accent"
        >
          <span className="size-1.5 rounded-full bg-accent" />
        </span>
        src/formatUser.ts
        <span className="ml-auto text-danger">−1</span>
        <span className="text-added">+1</span>
      </div>
      {line(
        1,
        " ",
        <>
          <span className={kw}>export function</span> <span className={fn}>formatUser</span>
          (user: <span className={ty}>User</span>) {"{"}
        </>,
      )}
      {line(
        2,
        "-",
        <>
          {"  "}
          <span className={kw}>return</span> user.name.<span className={fn}>toUpperCase</span>();
        </>,
      )}
      {line(
        2,
        "+",
        <>
          {"  "}
          <span className={kw}>return</span>{" "}
          <span className={str}>{"`${user.name} <${user.email}>`"}</span>;{" "}
          <span className="text-faint-foreground">
            {"// 0O 1lI, and a long line to show wrapping"}
          </span>
        </>,
      )}
      {line(3, " ", "}")}
    </div>
  );
}

// A font's name in menus: fontsource's variable fonts end in " Variable".
const fontName = (family: string) => family.replace(/ Variable$/, "");
const fontOption = (family: string, group?: string): PickerOption => ({
  value: family,
  label: fontName(family),
  group,
  style: { fontFamily: `"${family}"` },
});

/**
 * A font menu, each name in its own face: the default, the fonts Parallax ships, then `groups` of
 * installed ones. Its search also takes any font's name, installed or not.
 */
function FontPicker({
  label,
  value,
  defaultName,
  defaultFamily,
  bundled,
  groups,
  onChange,
}: {
  label: string;
  value: string;
  defaultName: string;
  defaultFamily: string;
  bundled: string[];
  groups: [string, string[]][];
  onChange: (font: string) => void;
}) {
  const options: PickerOption[] = [
    { value: "", label: defaultName, hint: "Default", style: { fontFamily: defaultFamily } },
    ...bundled.map((f) => fontOption(f, "Included with Parallax")),
    ...groups.flatMap(([group, fonts]) =>
      fonts.filter((f) => !bundled.includes(f)).map((f) => fontOption(f, group)),
    ),
  ];
  return (
    <Picker
      field
      label={label}
      value={value}
      onChange={onChange}
      options={options}
      search="Search or type a font name"
      custom={(name) => ({ ...fontOption(name), hint: "Use this name" })}
      align="end"
      className="w-56"
      panelClassName="w-72"
    />
  );
}

function SizePicker({
  label,
  value,
  sizes,
  onChange,
}: {
  label: string;
  value: number;
  sizes: number[];
  onChange: (size: number) => void;
}) {
  return (
    <Picker
      field
      label={label}
      value={String(value)}
      onChange={(v) => onChange(Number(v))}
      options={sizes.map((s) => ({ value: String(s), label: `${s} px` }))}
      align="end"
      className="w-24"
      panelClassName="min-w-24"
    />
  );
}
