import { defineConfig } from "i18next-cli";

import { languages } from "./src/i18n/languages";

// `i18next-cli extract` writes the English strings the code uses to src/i18n/locales/en.json, and
// CI runs it with `--ci` so that file never falls behind (0105). The keys are the English text, so
// they hold `.` and `:` freely. The phone's strings, in apps/mobile, share these files.
export default defineConfig({
  locales: languages.map((language) => language.code),
  extract: {
    input: ["src/renderer/**/*.{ts,tsx}", "src/main/**/*.ts", "../mobile/src/**/*.{ts,tsx}"],
    ignore: ["**/*.test.{ts,tsx}"],
    output: "src/i18n/locales/{{language}}.json",
    // `msg` marks text for a table built at load, which `t` shows later (src/i18n/index.ts).
    functions: ["t", "*.t", "msg"],
    primaryLanguage: "en",
    defaultNS: false,
    keySeparator: false,
    nsSeparator: false,
    // Each translation is added by hand (0105), so a missing one stays missing, not "".
    omitMissingKeys: true,
    extractFromComments: false,
  },
});
