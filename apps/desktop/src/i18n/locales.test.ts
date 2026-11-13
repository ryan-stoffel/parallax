import { expect, test } from "vite-plus/test";

import { languages, matchLanguage, messages } from ".";

const pluralSuffix = /_(zero|one|two|few|many|other)$/;

// `{{name}}` placeholders, sorted, and `<1>` / `</1>` / `<2/>` tags, sorted.
const placeholders = (text: string) =>
  [...new Set([...text.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]!))].sort();
const tags = (text: string) =>
  [...text.matchAll(/<\/?\d+\s*\/?>/g)].map((m) => m[0].replace(/\s/g, "")).sort();

/** English's keys, plural ones by their base, with the English text each translation must match. */
async function english() {
  const en = await messages("en");
  const plain = new Map<string, string>();
  const plural = new Map<string, string>();
  for (const [key, text] of Object.entries(en)) {
    const base = key.replace(pluralSuffix, "");
    if (base === key) plain.set(key, text);
    else if (key.endsWith("_other")) plural.set(base, text);
  }
  return { en, plain, plural };
}

test("English has its own text for every key, and both plural forms", async () => {
  const { en, plural } = await english();
  for (const [key, text] of Object.entries(en)) expect(text, key).not.toBe("");
  for (const base of plural.keys()) expect(en[`${base}_one`], base).toBeDefined();
});

test.each(languages.filter((language) => language.code !== "en"))(
  "$name has every string, with English's placeholders and tags",
  async ({ code }) => {
    const { plain, plural } = await english();
    const translated = await messages(code);
    const expected = new Map(plain);
    // The plural forms the language has, such as Russian's one, few, many, and other.
    const forms = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
    for (const [base, text] of plural)
      for (const form of forms) expected.set(`${base}_${form}`, text);

    const missing = [...expected.keys()].filter((key) => !translated[key]);
    const extra = Object.keys(translated).filter((key) => !expected.has(key));
    expect(missing, "missing").toEqual([]);
    expect(extra, "not in English").toEqual([]);
    for (const [key, source] of expected) {
      const text = translated[key]!;
      // A plural form may spell its number out, as "one file" does.
      const drop = (names: string[]) =>
        pluralSuffix.test(key) ? names.filter((name) => name !== "count") : names;
      expect(drop(placeholders(text)), key).toEqual(drop(placeholders(source)));
      expect(tags(text), key).toEqual(tags(source));
    }
  },
);

test("an OS language picks the app's nearest one", () => {
  expect(matchLanguage(["de-AT"])).toBe("de");
  expect(matchLanguage(["zh-TW"])).toBe("zh-Hant");
  expect(matchLanguage(["zh-Hant-HK"])).toBe("zh-Hant");
  expect(matchLanguage(["zh-CN"])).toBe("zh-Hans");
  expect(matchLanguage(["pt-PT"])).toBe("pt-BR");
  expect(matchLanguage(["no-NO"])).toBe("nb");
  expect(matchLanguage(["ar-EG", "fr-CA"])).toBe("fr");
  expect(matchLanguage(["ar-EG"])).toBe("en");
  expect(matchLanguage([undefined])).toBe("en");
});
