import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import { isLanguage, matchLanguage, setLanguage, type Language } from "../i18n";
import { locale } from "./locale";
import { stored } from "./stored";

const KEY = "parallax.language";

/** The language Settings > General picked (0105), or "system" to follow the OS's. */
export const languageChoice = stored<Language | "system">(KEY, "system", (raw, fallback) =>
  raw === "system" || isLanguage(raw) ? raw : fallback,
);

/** The language the app shows: the user's choice, else the OS's when the app has it, else English. */
export const appLanguage = (): Language => {
  const choice = languageChoice.get();
  return choice === "system" ? matchLanguage([locale()]) : choice;
};

/**
 * Loads the app's language before the first render, and tells main so its menus and dialogs
 * match. The page's `lang` picks the right glyphs for Chinese and Japanese text.
 */
export async function startLanguage(): Promise<void> {
  const language = appLanguage();
  i18next.use(initReactI18next);
  await setLanguage(language);
  document.documentElement.lang = language;
  window.parallax.setLanguage(language);
  // Another window changed it: reload, so every string, React's or not, is in the new language.
  window.addEventListener("storage", (event) => {
    if (event.key === KEY) location.reload();
  });
}

/** Saves the choice and reloads the window into it. */
export function chooseLanguage(choice: Language | "system"): void {
  languageChoice.set(choice);
  location.reload();
}
