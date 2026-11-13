import { t } from "i18next";

import { msg } from "../../i18n";
import { setAppearance, useAppearance, type Appearance } from "../appearance";
import { DiffLineView } from "../ChangesDiff";
import { parseDiff } from "../parseDiff";
import { Segmented } from "../ui";
import { PageTitle, Row, Section, Switch } from "./parts";

/** The text sizes offered here, as named steps of Appearance's sizes. */
const textSizes = [
  { value: "12", name: msg("Small") },
  { value: "13", name: msg("Default") },
  { value: "15", name: msg("Large") },
  { value: "17", name: msg("Larger") },
];

const palettes: { value: Appearance["diffColors"]; name: string; detail: string }[] = [
  { value: "redGreen", name: msg("Red & green"), detail: msg("The default.") },
  {
    value: "blueOrange",
    name: msg("Blue & orange"),
    detail: msg("For red-green color blindness."),
  },
  { value: "tealPink", name: msg("Teal & pink"), detail: msg("Apart under most color blindness.") },
  { value: "custom", name: msg("Custom"), detail: msg("Your own two colors.") },
];

/** What Diffs shows its colors on, drawn as a real diff is. */
const preview = parseDiff(
  [
    "diff --git a/total.ts b/total.ts",
    "@@ -1,3 +1,3 @@",
    " function total(items) {",
    "-  return items.reduce((sum, i) => sum + i.price, 0);",
    "+  return items.reduce((sum, i) => sum + i.price * i.qty, 0);",
    " }",
  ].join("\n"),
)[0]!.lines.filter((line) => line.op !== "@");

/** One of a diff's two colors, picked. */
function ColorPick({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-body text-muted-foreground">
      {label}
      <input
        type="color"
        aria-label={t("{{label}} color", { label })}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="size-6 cursor-pointer appearance-none rounded-full border border-border bg-transparent p-0 [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0"
      />
      <span className="font-mono text-meta uppercase">{value}</span>
    </label>
  );
}

/**
 * Settings > Accessibility: what makes the app easier to see and use. These stay on this computer,
 * and text size is Appearance's own, offered here too in named steps.
 */
export function AccessibilitySettings() {
  const appearance = useAppearance();
  const sized = textSizes.some((s) => s.value === String(appearance.uiSize));
  return (
    <>
      <PageTitle title={t("Accessibility")}>
        {t("Make Parallax easier to read and to use. These stay on this computer.")}
      </PageTitle>
      <Section title={t("Vision")}>
        <Row
          title={t("Contrast")}
          description={t("Stronger text and borders. System follows your OS.")}
        >
          <Segmented
            label={t("Contrast")}
            options={[
              { value: "system", name: t("System") },
              { value: "standard", name: t("Standard") },
              { value: "more", name: t("More") },
            ]}
            value={appearance.contrast}
            onChange={(contrast) => setAppearance({ contrast })}
          />
        </Row>
        <Row
          title={t("Interface text size")}
          description={
            sized
              ? t("How large the app's text is.")
              : t("Set to {{size}} px in Appearance. Pick a step to change it.", {
                  size: appearance.uiSize,
                })
          }
        >
          <Segmented
            label={t("Interface text size")}
            options={textSizes.map((s) => ({ ...s, name: t(s.name) }))}
            value={String(appearance.uiSize)}
            onChange={(size) => setAppearance({ uiSize: Number(size) })}
          />
        </Row>
        <Row
          title={t("Focus rings")}
          description={t(
            "A thicker outline around what has keyboard focus, so it's easy to follow.",
          )}
        >
          <Switch
            label={t("Focus rings")}
            checked={appearance.focusRings}
            onChange={(focusRings) => setAppearance({ focusRings })}
          />
        </Row>
        <Row title={t("Underline links")} description={t("Color isn't all that marks a link.")}>
          <Switch
            label={t("Underline links")}
            checked={appearance.underlineLinks}
            onChange={(underlineLinks) => setAppearance({ underlineLinks })}
          />
        </Row>
      </Section>
      <Section title={t("Motion")}>
        <Row
          title={t("Reduce motion")}
          description={t("Stops animations. Also on whenever your OS asks for less motion.")}
        >
          <Switch
            label={t("Reduce motion")}
            checked={appearance.motion === "reduce"}
            onChange={(on) => setAppearance({ motion: on ? "reduce" : "system" })}
          />
        </Row>
      </Section>
      <Section title={t("Diffs")}>
        <div
          data-setting="diff-colors"
          role="radiogroup"
          aria-label={t("Diff colors")}
          className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2 border-b border-border/40 p-3"
        >
          {palettes.map((p) => (
            <label
              key={p.value}
              className="flex cursor-pointer flex-col gap-0.5 rounded-lg border border-border px-3 py-2.5 hover:bg-hover has-checked:border-accent has-checked:ring-2 has-checked:ring-accent/40 has-focus-visible:outline-2 has-focus-visible:outline-ring"
            >
              <input
                type="radio"
                name="diff-colors"
                className="sr-only"
                checked={appearance.diffColors === p.value}
                onChange={() => setAppearance({ diffColors: p.value })}
              />
              <span className="text-body font-medium">{t(p.name)}</span>
              <span className="text-meta text-muted-foreground">{t(p.detail)}</span>
            </label>
          ))}
        </div>
        {appearance.diffColors === "custom" && (
          <div className="flex flex-wrap items-center gap-6 border-b border-border/40 px-4 py-3">
            <ColorPick
              label={t("Added", { context: "diff lines" })}
              value={appearance.diffCustom.added}
              onChange={(added) =>
                setAppearance({ diffCustom: { ...appearance.diffCustom, added } })
              }
            />
            <ColorPick
              label={t("Removed", { context: "diff lines" })}
              value={appearance.diffCustom.removed}
              onChange={(removed) =>
                setAppearance({ diffCustom: { ...appearance.diffCustom, removed } })
              }
            />
          </div>
        )}
        <Row
          title={t("Line tint")}
          description={t("How strongly a changed line's background shows its color.")}
        >
          <Segmented
            label={t("Line tint")}
            options={[
              { value: "subtle", name: t("Subtle") },
              { value: "standard", name: t("Standard") },
              { value: "strong", name: t("Strong") },
            ]}
            value={appearance.diffIntensity}
            onChange={(diffIntensity) => setAppearance({ diffIntensity })}
          />
        </Row>
        <div
          aria-label={t("Preview of a diff")}
          className="overflow-hidden rounded-b-xl bg-code py-2 font-mono text-meta leading-5"
        >
          {preview.map((line, i) => (
            <DiffLineView key={i} line={line} />
          ))}
        </div>
      </Section>
    </>
  );
}
