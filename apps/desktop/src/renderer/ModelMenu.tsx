import { Check, ChevronDown, Search, Star } from "lucide-react";
import { useId, useRef, useState, type ToggleEvent } from "react";

import {
  prefsKey,
  toggleFavorite,
  useModelPrefs,
  type Catalog,
  type Model,
  type Provider,
} from "./models";
import { kindOf, logoOf } from "./providers";
import { menuButton, menuPanel, moveFocus } from "./ui";

// The same model can run on two instances, so a model is known by both.
const keyOf = (m: Model) => `${m.provider}/${m.id}`;

const railButton =
  "grid size-8 place-items-center rounded-md text-muted-foreground enabled:hover:bg-hover aria-pressed:bg-selected aria-pressed:text-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4";

/**
 * The model picker: a button showing the chosen model that opens a searchable list of the
 * `catalog`'s models, with a rail to filter by favorites or instance. A native popover, so Escape
 * and clicking away close it, and it flips above the button when there's no room below. The models
 * of instances in `unavailable` aren't listed, and the rail shows those instances disabled, saying
 * why on hover. Favorites are kept on this device, per host.
 */
export function ModelMenu({
  catalog,
  unavailable = {},
  value: chosen,
  onChange,
}: {
  catalog: Catalog;
  /** Instances whose models can't be picked here, by why. */
  unavailable?: Partial<Record<Provider, string>>;
  value: Model;
  onChange: (model: Model) => void;
}) {
  const all = catalog.models;
  const models = all.filter((m) => !unavailable[m.provider]);
  const prefs = useModelPrefs();
  const starred = (m: Model) =>
    !!prefs[prefsKey(catalog.hostId, m.provider)]?.favorites?.includes(m.id);
  const instance = (id: Provider) => catalog.instances.find((i) => i.id === id);
  const logo = (id: Provider) => {
    const found = instance(id);
    return found ? logoOf(found) : kindOf(id).Logo;
  };
  const nameOf = (id: Provider) => instance(id)?.name ?? id;
  // An instance's id, or null for Favorites.
  const [tab, setTab] = useState<Provider | null>(chosen.provider);
  const [query, setQuery] = useState("");
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const q = query.trim().toLowerCase();
  const shown = models.filter((m) =>
    q ? m.name.toLowerCase().includes(q) : tab === null ? starred(m) : m.provider === tab,
  );
  const Logo = logo(chosen.provider);

  const pick = (m: Model) => {
    onChange(m);
    menu.current?.hidePopover();
  };

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
            aria-pressed={!q && tab === null}
            onClick={() => setTab(null)}
            className={railButton}
          >
            <Star />
          </button>
          <span aria-hidden className="my-1 h-px w-6 bg-border" />
          {[...new Set(all.map((m) => m.provider))].map((p) => {
            const ProviderLogo = logo(p);
            const why = unavailable[p];
            return (
              // A disabled button gets no pointer events, so its wrapper shows the tooltip.
              <span key={p} className="group relative flex">
                <button
                  type="button"
                  aria-label={nameOf(p)}
                  aria-pressed={!q && tab === p}
                  disabled={!!why}
                  aria-describedby={why ? `${id}-${p}` : undefined}
                  onClick={() => setTab(p)}
                  className={railButton}
                >
                  <ProviderLogo />
                </button>
                {why && (
                  <span
                    id={`${id}-${p}`}
                    role="tooltip"
                    className="pointer-events-none invisible absolute top-1/2 left-full z-10 ml-2 w-56 -translate-y-1/2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] text-foreground shadow-composer group-hover:visible"
                  >
                    {why}
                  </span>
                )}
              </span>
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
              const ProviderLogo = logo(m.provider);
              const key = keyOf(m);
              const favorite = starred(m);
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
                          <span className="rounded border border-accent px-1 text-[10.5px] font-semibold text-accent">
                            NEW
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-faint-foreground">
                        <ProviderLogo className="size-3" />
                        {nameOf(m.provider)}
                      </span>
                    </span>
                    <Check
                      aria-hidden
                      className={`size-4 shrink-0 text-accent ${key === keyOf(chosen) ? "" : "invisible"}`}
                    />
                  </button>
                  <button
                    type="button"
                    aria-label={favorite ? `Unfavorite ${m.name}` : `Favorite ${m.name}`}
                    aria-pressed={favorite}
                    onClick={() => toggleFavorite(catalog.hostId, m.provider, m.id)}
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
