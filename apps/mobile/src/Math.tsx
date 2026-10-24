// LaTeX in Markdown, typeset by MathJax to SVG on the phone, as the desktop's KaTeX typesets it:
// inline math on the text's baseline, display math centered and scrolling when wide, both in the
// text's color. TeX that doesn't typeset shows its source in mono.
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { ScrollView, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";

import { font } from "./theme";

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
// Every package but the two that draw errors in place, so bad TeX throws instead. Glyphs are
// paths in each SVG ("none"), since react-native-svg draws no shared <use> cache.
const page = mathjax.document("", {
  InputJax: new TeX({
    packages: AllPackages.filter((p) => p !== "noerrors" && p !== "noundefined"),
    formatError: (_: unknown, error: Error) => {
      throw error;
    },
  }),
  OutputJax: new SVG({ fontCache: "none" }),
});

/** Typeset math: its SVG, and its width, height, and depth below the baseline, in ems. */
interface Typeset {
  xml: string;
  width: number;
  height: number;
  depth: number;
}

// Each expression's SVG, or null when it doesn't typeset, so a transcript typesets each once.
const typeset = new Map<string, Typeset | null>();

/** `tex` as SVG, displayed or inline, or null when it isn't valid TeX. */
function typesetOf(tex: string, display: boolean): Typeset | null {
  const key = `${display ? "$$" : "$"}${tex}`;
  let done = typeset.get(key);
  if (done !== undefined) return done;
  try {
    const svg = adaptor.innerHTML(page.convert(tex, { display }));
    // The viewBox is in thousandths of an em, from the top of the math to its bottom.
    const [, top, width, height] = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/
      .exec(svg)!
      .slice(1)
      .map(Number);
    // Sized here, so the root's own sizes in ex and its CSS go.
    const end = svg.indexOf(">");
    done = svg.includes('data-mml-node="merror"')
      ? null
      : {
          xml: svg.slice(0, end).replace(/ (?:width|height|style)="[^"]*"/g, "") + svg.slice(end),
          width: width! / 1000,
          height: height! / 1000,
          depth: (height! + top!) / 1000,
        };
  } catch {
    done = null;
  }
  typeset.set(key, done);
  return done;
}

// Math a little over the text's size, as the desktop's `.katex`: TeX's x-height is smaller.
const scale = 1.12;

/** Inline math, in a `Text`, sitting on its baseline. */
export function InlineMath({ tex, raw, size, color }: { tex: string; raw: string; size: number; color: string }) {
  const math = typesetOf(tex, false);
  if (!math) return <Text style={{ fontFamily: font.mono, fontSize: size * 0.86 }}>{raw}</Text>;
  const em = size * scale;
  return (
    // An inline view's bottom sits on the line's baseline, so its depth is moved below it.
    <View style={{ transform: [{ translateY: math.depth * em }] }}>
      <SvgXml xml={math.xml} width={math.width * em} height={math.height * em} color={color} />
    </View>
  );
}

/** Display math, centered on its own line, scrolling sideways when it's wider than the message. */
export function DisplayMath({ tex, raw, size, color }: { tex: string; raw: string; size: number; color: string }) {
  const math = typesetOf(tex, true);
  if (!math)
    return (
      <Text selectable style={{ fontFamily: font.mono, fontSize: size * 0.86, color }}>
        {raw}
      </Text>
    );
  const em = size * scale;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingVertical: 4 }}
    >
      <SvgXml xml={math.xml} width={math.width * em} height={math.height * em} color={color} />
    </ScrollView>
  );
}
