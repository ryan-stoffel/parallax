import { Check, ChevronDown, Search, Star } from "lucide-react";
import {
  useId,
  useRef,
  useState,
  type ComponentType,
  type SVGProps,
  type ToggleEvent,
} from "react";

import { ClaudeLogo, CursorLogo, OpenAILogo } from "./logos";
import { models, type Model, type Provider } from "./models";
import { menuButton, menuPanel, moveFocus } from "./ui";

const providers: Record<Provider, ComponentType<SVGProps<SVGSVGElement>>> = {
  Claude: ClaudeLogo,
  Codex: OpenAILogo,
  Cursor: CursorLogo,
};

// The same model can run under two providers, so a model is known by both.
const keyOf = (m: Model) => `${m.provider}/${m.name}`;

const railButton =
  "grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-hover aria-pressed:bg-selected aria-pressed:text-foreground [&_svg]:size-4";

/**
 * The model picker: a button showing the chosen model that opens a searchable list, with a
 * rail to filter by favorites or provider. A native popover, so Escape and clicking away
 * close it, and it flips above the button when there's no room below.
 */
export function ModelMenu() {
  const [chosen, setChosen] = useState(models[0]!);
  const [favorites, setFavorites] = useState(() => new Set([keyOf(models[0]!)]));
  const [tab, setTab] = useState<"favorites" | Provider>("Claude");
  const [query, setQuery] = useState("");
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const q = query.trim().toLowerCase();
  const shown = models.filter((m) =>
    q
      ? m.name.toLowerCase().includes(q)
      : tab === "favorites"
        ? favorites.has(keyOf(m))
        : m.provider === tab,
  );
  const Logo = providers[chosen.provider];

  const pick = (m: Model) => {
    setChosen(m);
    menu.current?.hidePopover();
  };

  const toggleFavorite = (key: string) =>
    setFavorites((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        aria-haspopup="menu"
        aria-label={`Model: ${chosen.name}`}
        className={menuButton}
      >
        <Logo />
        {chosen.name.replace(/^Claude /, "")}
        <ChevronDown aria-hidden className="opacity-70" />
      </button>
      <div
        ref={menu}
        id={id}
        popover="auto"
        onToggle={(e: ToggleEvent<HTMLDivElement>) => {
          if (e.newState === "open") search.current?.focus();
          else setQuery("");
        }}
        onKeyDown={moveFocus}
        className={`${menuPanel()} h-80 w-[26rem] overflow-hidden p-0 [&:popover-open]:flex`}
      >
        <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border py-2">
          <button
            type="button"
            aria-label="Favorites"
            aria-pressed={!q && tab === "favorites"}
            onClick={() => setTab("favorites")}
            className={railButton}
          >
            <Star />
          </button>
          <span aria-hidden className="my-1 h-px w-6 bg-border" />
          {(Object.keys(providers) as Provider[]).map((p) => {
            const ProviderLogo = providers[p];
            return (
              <button
                key={p}
                type="button"
                aria-label={p}
                aria-pressed={!q && tab === p}
                onClick={() => setTab(p)}
                className={railButton}
              >
                <ProviderLogo />
              </button>
            );
          })}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <label className="flex items-center gap-2 border-b border-border px-3 py-2.5 focus-within:border-ring">
            <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
            <input
              ref={search}
              type="search"
              aria-label="Search models"
              placeholder="Search models…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shown[0]) pick(shown[0]);
              }}
              className="min-w-0 flex-1 bg-transparent text-[13.5px] placeholder:text-faint-foreground focus-visible:outline-none"
            />
          </label>
          <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {shown.map((m) => {
              const ProviderLogo = providers[m.provider];
              const key = keyOf(m);
              const starred = favorites.has(key);
              return (
                <li key={key} className="flex items-center rounded-md hover:bg-hover">
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={key === keyOf(chosen)}
                    onClick={() => pick(m)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-[13.5px]">
                        {m.name}
                        {m.isNew && (
                          <span className="rounded border border-ring px-1 text-[10.5px] font-semibold text-ring">
                            NEW
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-faint-foreground">
                        <ProviderLogo className="size-3" />
                        {m.provider}
                      </span>
                    </span>
                    <Check
                      aria-hidden
                      className={`size-4 shrink-0 text-ring ${key === keyOf(chosen) ? "" : "invisible"}`}
                    />
                  </button>
                  <button
                    type="button"
                    aria-label={starred ? `Unfavorite ${m.name}` : `Favorite ${m.name}`}
                    aria-pressed={starred}
                    onClick={() => toggleFavorite(key)}
                    className="mr-1.5 grid size-7 place-items-center rounded text-faint-foreground hover:text-foreground aria-pressed:text-amber-500 [&_svg]:size-4 aria-pressed:[&_svg]:fill-current"
                  >
                    <Star />
                  </button>
                </li>
              );
            })}
            {shown.length === 0 && (
              <li className="px-2.5 py-3 text-[12.5px] text-faint-foreground">
                {q ? "No matching models" : "No favorites yet"}
              </li>
            )}
          </ul>
        </div>
      </div>
    </>
  );
}
