import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import { setLanguage } from ".";

i18next.use(initReactI18next);
await setLanguage("en");
