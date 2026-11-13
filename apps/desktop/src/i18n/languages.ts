/**
 * The languages the desktop and phone apps show (0105), each with its name in itself. English is
 * the source: its strings are the keys. Right-to-left languages wait for a layout that mirrors.
 */
export const languages = [
  { code: "en", name: "English" },
  { code: "cs", name: "Čeština" },
  { code: "da", name: "Dansk" },
  { code: "de", name: "Deutsch" },
  { code: "el", name: "Ελληνικά" },
  { code: "es", name: "Español" },
  { code: "fi", name: "Suomi" },
  { code: "fr", name: "Français" },
  { code: "hu", name: "Magyar" },
  { code: "id", name: "Bahasa Indonesia" },
  { code: "it", name: "Italiano" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "nb", name: "Norsk bokmål" },
  { code: "nl", name: "Nederlands" },
  { code: "pl", name: "Polski" },
  { code: "pt-BR", name: "Português (Brasil)" },
  { code: "ro", name: "Română" },
  { code: "ru", name: "Русский" },
  { code: "sv", name: "Svenska" },
  { code: "th", name: "ไทย" },
  { code: "tr", name: "Türkçe" },
  { code: "uk", name: "Українська" },
  { code: "vi", name: "Tiếng Việt" },
  { code: "zh-Hans", name: "简体中文" },
  { code: "zh-Hant", name: "繁體中文" },
] as const;

export type Language = (typeof languages)[number]["code"];

const codes = new Set<string>(languages.map((language) => language.code));

export const isLanguage = (value: unknown): value is Language =>
  typeof value === "string" && codes.has(value);

/**
 * The first of the OS's preferred language tags, such as "de-AT" or "zh-Hant-TW", that the apps
 * have, else English. Chinese picks its script from the tag, or from the region when it has none.
 */
export function matchLanguage(tags: readonly (string | undefined)[]): Language {
  for (const tag of tags) {
    if (!tag) continue;
    const [base = "", ...rest] = tag.replace(/_/g, "-").split("-");
    const lower = base.toLowerCase();
    if (lower === "zh") {
      const parts = rest.map((part) => part.toLowerCase());
      const traditional =
        parts.includes("hant") ||
        (!parts.includes("hans") && parts.some((part) => ["tw", "hk", "mo"].includes(part)));
      return traditional ? "zh-Hant" : "zh-Hans";
    }
    // Norwegian: bokmål for "no" and "nb", and for nynorsk, which shares most of its words.
    if (lower === "no" || lower === "nn") return "nb";
    if (lower === "pt") return "pt-BR";
    if (isLanguage(lower)) return lower;
  }
  return "en";
}
