import { Atom, Package } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { codeSizes, installedFonts, setAppearance, uiSizes, useAppearance } from "../appearance";
import { Row, Section, Switch } from "./parts";

const control =
  "h-8 rounded-lg border border-border bg-background px-2.5 text-[13px] text-foreground";
const preview = "mx-4 mb-3.5 rounded-xl border border-border bg-background outline-none";

/**
 * Appearance's Typography: the interface and monospace fonts and sizes, each with a preview to
 * type in, and Word wrap. Advanced takes any installed font's name instead of the list.
 */
export function TypographySettings() {
  const appearance = useAppearance();
  const [advanced, setAdvanced] = useState(false);
  const fonts = installedFonts();
  return (
    <Section
      title="Typography"
      action={
        <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          Advanced
          <Switch label="Advanced" checked={advanced} onChange={setAdvanced} />
        </label>
      }
    >
      <div className="border-b border-border">
        <Row title="Interface font" description="Everything outside code blocks and the terminal.">
          <FontPicker
            label="Interface font"
            value={appearance.uiFont}
            fonts={fonts.ui}
            system="Default (Anthropic Serif)"
            advanced={advanced}
            onChange={(uiFont) => setAppearance({ uiFont })}
          />
          <SizePicker
            label="Interface font size"
            value={appearance.uiSize}
            sizes={uiSizes}
            onChange={(uiSize) => setAppearance({ uiSize })}
          />
        </Row>
        {/* Typing here only tries the font; nothing is kept. */}
        <div
          role="textbox"
          aria-label="Interface font preview"
          aria-multiline
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          className={`${preview} px-4 py-3 text-[14px] leading-relaxed`}
        >
          Use <Chip icon={<Package />}>Frontend Design</Chip> to fix the flaky test in{" "}
          <Chip icon={<span className="text-[9px] font-bold">TS</span>} tone="file">
            surface.test.ts
          </Chip>{" "}
          and align the header with{" "}
          <Chip icon={<Atom />} tone="file">
            SettingsPanels.tsx
          </Chip>{" "}
          before shipping.
        </div>
      </div>

      <div className="border-b border-border">
        <Row
          title="Monospace font"
          description="Code blocks, diffs, file previews, and the terminal."
        >
          <FontPicker
            label="Monospace font"
            value={appearance.codeFont}
            fonts={fonts.code}
            system="Default (JetBrains Mono Nerd Font)"
            advanced={advanced}
            onChange={(codeFont) => setAppearance({ codeFont })}
          />
          <SizePicker
            label="Monospace font size"
            value={appearance.codeSize}
            sizes={codeSizes}
            onChange={(codeSize) => setAppearance({ codeSize })}
          />
        </Row>
        <DiffPreview />
        <pre
          role="textbox"
          aria-label="Monospace font preview"
          aria-multiline
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          className={`${preview} code-lines bg-code px-4 py-3 font-mono text-[12px] leading-relaxed`}
        >
          <span className="text-project-yellow">VITE v7.1.1</span> ready in{" "}
          <b className="text-foreground">1.24s</b>
          {"\n\n"}
          <span className="text-project-green">→</span> Local:{"   "}
          <span className="text-project-teal underline">http://127.0.0.1:5173/</span>
          {"\n"}
          <span className="text-project-green">→</span> Network: {""}
          <span className="text-project-teal underline">http://192.168.1.24:5173/</span>
          {"\n\n"}
          <span className="text-added">✓ 85 passed</span>
          {"   "}
          <span className="text-warning">△ 2 warnings</span>
          {"   "}
          <span className="text-danger">✗ 0 failed</span>
          {"\n\n"}
          <span className="bg-project-yellow px-1 text-black">READY</span> watching for changes —
          press <b className="text-foreground">q</b> to quit
          {"\n"}
          <span className="text-project-green">→</span>{" "}
          <span className="text-project-teal">parallax</span>{" "}
          <span className="text-project-sky">git:(</span>
          <span className="text-project-red">main</span>
          <span className="text-project-sky">)</span> ✗{" "}
        </pre>
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

/** A mention in a message, as the composer draws one: an icon and a name, kept whole. */
function Chip({
  icon,
  tone = "skill",
  children,
}: {
  icon: ReactNode;
  tone?: "skill" | "file";
  children: ReactNode;
}) {
  return (
    <span
      contentEditable={false}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 align-baseline text-[0.93em] [&_svg]:size-3.5 ${
        tone === "file"
          ? "border-accent/30 bg-accent/10 text-foreground"
          : "border-project-violet/30 bg-project-violet/10 text-foreground"
      }`}
    >
      {icon}
      {children}
    </span>
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
      className={`${preview} code-scroll overflow-hidden bg-code font-mono text-[12px] leading-6`}
    >
      <div className="flex items-center gap-2 px-4 py-2 font-sans text-[13px]">
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

/**
 * A font: a list of the installed ones after the system's, or under Advanced, any name typed,
 * with the installed ones suggested.
 */
function FontPicker({
  label,
  value,
  fonts,
  system,
  advanced,
  onChange,
}: {
  label: string;
  value: string;
  fonts: string[];
  system: string;
  advanced: boolean;
  onChange: (font: string) => void;
}) {
  const list = useId();
  if (advanced)
    return (
      <>
        <input
          aria-label={label}
          list={list}
          value={value}
          placeholder={system}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          className={`${control} w-48 placeholder:text-faint-foreground`}
        />
        <datalist id={list}>
          {fonts.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </>
    );
  // A typed font that isn't in the list stays choosable.
  const options = value && !fonts.includes(value) ? [value, ...fonts] : fonts;
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${control} w-48`}
    >
      <option value="">{system}</option>
      {options.map((f) => (
        <option key={f} value={f}>
          {f}
        </option>
      ))}
    </select>
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
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className={`${control} w-24`}
    >
      {sizes.map((s) => (
        <option key={s} value={s}>
          {s} px
        </option>
      ))}
    </select>
  );
}
