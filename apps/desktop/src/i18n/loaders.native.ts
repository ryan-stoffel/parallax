// The phone's loaders (Metro picks `.native.ts`): every language bundled, since Metro can't load a
// lazy chunk from outside its project, and the app's other code is far larger anyway.
import type { loaders as lazy } from "./loaders";
import cs from "./locales/cs.json";
import da from "./locales/da.json";
import de from "./locales/de.json";
import el from "./locales/el.json";
import es from "./locales/es.json";
import fi from "./locales/fi.json";
import fr from "./locales/fr.json";
import hu from "./locales/hu.json";
import id from "./locales/id.json";
import it from "./locales/it.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";
import nb from "./locales/nb.json";
import nl from "./locales/nl.json";
import pl from "./locales/pl.json";
import ptBR from "./locales/pt-BR.json";
import ro from "./locales/ro.json";
import ru from "./locales/ru.json";
import sv from "./locales/sv.json";
import th from "./locales/th.json";
import tr from "./locales/tr.json";
import uk from "./locales/uk.json";
import vi from "./locales/vi.json";
import zhHans from "./locales/zh-Hans.json";
import zhHant from "./locales/zh-Hant.json";

const now =
  <T>(messages: T) =>
  () =>
    Promise.resolve({ default: messages });

export const loaders: typeof lazy = {
  cs: now(cs),
  da: now(da),
  de: now(de),
  el: now(el),
  es: now(es),
  fi: now(fi),
  fr: now(fr),
  hu: now(hu),
  id: now(id),
  it: now(it),
  ja: now(ja),
  ko: now(ko),
  nb: now(nb),
  nl: now(nl),
  pl: now(pl),
  "pt-BR": now(ptBR),
  ro: now(ro),
  ru: now(ru),
  sv: now(sv),
  th: now(th),
  tr: now(tr),
  uk: now(uk),
  vi: now(vi),
  "zh-Hans": now(zhHans),
  "zh-Hant": now(zhHant),
};
