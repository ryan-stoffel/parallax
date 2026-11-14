import type { Language } from "./languages";

type Messages = Record<string, string>;

/**
 * Each language's strings, loaded only when shown, so a window carries one language, not all. The
 * phone bundles them all instead (loaders.native.ts), since Metro can't load a lazy chunk from
 * outside its project.
 */
export const loaders: Record<Exclude<Language, "en">, () => Promise<{ default: Messages }>> = {
  cs: () => import("./locales/cs.json"),
  da: () => import("./locales/da.json"),
  de: () => import("./locales/de.json"),
  el: () => import("./locales/el.json"),
  es: () => import("./locales/es.json"),
  fi: () => import("./locales/fi.json"),
  fr: () => import("./locales/fr.json"),
  hu: () => import("./locales/hu.json"),
  id: () => import("./locales/id.json"),
  it: () => import("./locales/it.json"),
  ja: () => import("./locales/ja.json"),
  ko: () => import("./locales/ko.json"),
  nb: () => import("./locales/nb.json"),
  nl: () => import("./locales/nl.json"),
  pl: () => import("./locales/pl.json"),
  "pt-BR": () => import("./locales/pt-BR.json"),
  ro: () => import("./locales/ro.json"),
  ru: () => import("./locales/ru.json"),
  sv: () => import("./locales/sv.json"),
  th: () => import("./locales/th.json"),
  tr: () => import("./locales/tr.json"),
  uk: () => import("./locales/uk.json"),
  vi: () => import("./locales/vi.json"),
  "zh-Hans": () => import("./locales/zh-Hans.json"),
  "zh-Hant": () => import("./locales/zh-Hant.json"),
};
