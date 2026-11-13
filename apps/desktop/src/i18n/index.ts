import i18next from "i18next";

import type { Language } from "./languages";
import en from "./locales/en.json";
import { loaders } from "./loaders";

export { isLanguage, languages, matchLanguage, type Language } from "./languages";

type Messages = Record<string, string>;

/**
 * Marks English text for `i18next-cli extract` where `t` can't run yet, as in a table a module
 * builds at load. Show it with `t(text)` where it renders. A `context` tells apart a word that
 * means different things in different places, as `t` takes one: it returns the key with it.
 */
export function msg<T extends string>(text: T): T;
export function msg(text: string, options: { context: string }): string;
export function msg(text: string, options?: { context: string }): string {
  return options ? `${text}_${options.context}` : text;
}

/** The strings of `language`, for the locale test. */
export const messages = async (language: Language): Promise<Messages> =>
  language === "en" ? en : (await loaders[language]()).default;

/**
 * Shows `language` from now on: the first call sets up i18next, later ones switch. Keys are the
 * English text itself (0105), so `t("Open settings")` reads as English wherever a translation is
 * missing. Strings come from `t` at render time, never at module load, since a module's constants
 * would keep the language it loaded in.
 */
export async function setLanguage(language: Language): Promise<void> {
  const translation = await messages(language);
  if (!i18next.isInitialized) {
    await i18next.init({
      lng: language,
      fallbackLng: "en",
      resources: { en: { translation: en }, [language]: { translation } },
      keySeparator: false,
      nsSeparator: false,
      // React and the native views escape text themselves.
      interpolation: { escapeValue: false },
      // A key a translation leaves empty reads as English.
      returnEmptyString: false,
    });
    return;
  }
  if (!i18next.hasResourceBundle(language, "translation"))
    i18next.addResourceBundle(language, "translation", translation);
  await i18next.changeLanguage(language);
}
