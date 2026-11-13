# 0105: The apps in the user's language

- Status: accepted; amends PLX-613's English-only UI (Chromium's own locales still ship only in en-US)
- Date: 2026-11-13
- Issue: PLX-1548

## Context

Every string in the desktop app and the phone app was hardcoded English. Ryan chose i18next with react-i18next in both apps and one set of shared JSON translation files, and asked for as many languages as can be translated reliably and accurately.

## Decision

- **One module, both apps.** `apps/desktop/src/i18n` holds the language list, `setLanguage`, and `locales/<language>.json`. The phone already shares `apps/desktop/src` through Metro (0065), so it loads the same files. The desktop main process uses them for its menus, dialogs, and notifications. The desktop loads only the shown language's file. The phone bundles them all, since Metro can't load a lazy chunk from outside its project.
- **The English text is the key.** Code calls `t("Open settings")`, with i18next's key and namespace separators off. A missing translation reads as English, and about 4,700 strings need no invented names. Plurals use `count` with `defaultValue_one` for the English singular, so languages with more forms get all of them. Text with markup uses `<Trans>`. A word whose meaning differs by place takes a `context`.
- **`t` runs at render time.** A table built at module load marks its text with `msg`, which takes a `context` as `t` does, and is shown through `t`. Changing the language reloads the desktop window, and remounts the phone app, so nothing keeps the old language.
- **The OS's language by default.** Settings > General > Language overrides it, kept in localStorage on the desktop, where each window tells main its language, and in `prefs.json` on the phone, which reads its own with expo-localization.
- **26 languages:** English, Czech, Danish, German, Greek, Spanish, Finnish, French, Hungarian, Indonesian, Italian, Japanese, Korean, Norwegian Bokmål, Dutch, Polish, Brazilian Portuguese, Romanian, Russian, Swedish, Thai, Turkish, Ukrainian, Vietnamese, and Simplified and Traditional Chinese. These are the left-to-right languages Claude translates reliably. Arabic and Hebrew wait for a layout that mirrors.
- **Every locale is complete.** `i18next-cli extract --ci` in CI keeps `en.json` equal to the strings the code uses. `src/i18n/locales.test.ts` fails when a language lacks a key, has a key English doesn't, drops or adds a `{{placeholder}}` or `<1>` tag, or lacks a plural form `Intl.PluralRules` lists for it. So a pull request that adds or changes UI text updates every locale file.
- **What stays English:** text sent to agents or plxd, values the code compares, logs, brand names, key names, and data. plxd's own messages stay English.

## Rejected

| Option | Why not |
| --- | --- |
| Named keys (`settings.language.title`) | 4,700 names to invent and keep in step, and a missing translation shows a key, not English. |
| Lingui | Ryan chose i18next. |
| A translation service (Crowdin, Weblate) | Nothing to review yet. The agent that adds a string translates it, and the test checks the result. A service can come with community translators. |
| English fallback for new strings, completed later | A half-translated screen. The test makes every pull request finish its own strings. |

## Consequences

- A pull request that adds UI text adds its translation to 25 files.
- Translations are Claude's, checked by structure, not by native speakers. Corrections are plain edits to the JSON.
- The web client's pairing page (`web.html`) and Chromium's own strings stay English.
