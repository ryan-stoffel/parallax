// The language the phone app shows (0105): the one Settings > General picked, else the phone's own
// when Parallax has it, else English. The strings are the desktop's (apps/desktop/src/i18n).
import { getLocales } from "expo-localization";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import { matchLanguage, setLanguage, type Language } from "../../desktop/src/i18n";
import { getPrefs, setPrefs } from "./prefs";

i18next.use(initReactI18next);

/** The language the app shows now. */
export const phoneLanguage = (): Language =>
  getPrefs().language ?? matchLanguage(getLocales().map((locale) => locale.languageTag));

/** Loads the app's language. The app waits for it before its first frame. */
export const startLanguage = () => setLanguage(phoneLanguage());

/** Saves the choice, undefined for the phone's, and switches to it. App remounts in the new one. */
export async function chooseLanguage(language: Language | undefined): Promise<void> {
  setPrefs({ language });
  await startLanguage();
}
