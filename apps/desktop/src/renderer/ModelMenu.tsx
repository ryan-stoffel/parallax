import { Check, ChevronDown, Layers, Search, Star, UserRound } from "lucide-react";
import { useEffect, useId, useRef, useState, type ToggleEvent } from "react";

import {
  prefsKey,
  toggleFavorite,
  useModelPrefs,
  type Catalog,
  type Instance,
  type Model,
  type Provider,
} from "./models";
import { kindOf, logoOf } from "./providers";
import { menuButton, menuPanel, moveFocus } from "./ui";

// The same model can run on two instances, so a model is known by both.
const keyOf = (m: Model) => `${m.provider}/${m.id}`;

/**
 * The rail's group for an instance: its kind, so a provider's accounts and pools share one
 * button, except an ACP agent, which is its own.
 */
const groupOf = (i: Pick<Instance, "id" | "kind">) => (i.kind === "acp" ? i.id : i.kind);

const railButton =
  "grid size-8 place-items-center rounded-md text-muted-foreground enabled:hover:bg-hover aria-pressed:bg-selected aria-pressed:text-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4";

/**
 * The model picker: a button showing the chosen model that opens a searchable list of the
 * `catalog`'s models, with a rail to filter by favorites or provider. A provider with more than
 * one account or an account pool (PLX-1033) has one rail button, and a bar of its pools and
 * accounts in a selector over its models picks which one runs the thread. A native popover, so Escape and
 * clicking away close it, and it flips above the button when there's no room below. The models of
 * instances in `unavailable` aren't listed, and the rail and the bar show those instances
 * disabled, saying why on hover. Favorites are kept on this device, per host.
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
  const group = (id: Provider) => {
    const found = instance(id);
    return found ? groupOf(found) : id;
  };
  // Each group's instances that offer models: its pools first, then its accounts.
  const listed = [...new Set(all.map((m) => m.provider))];
  const groups = new Map<string, Provider[]>();
  for (const p of listed) groups.set(group(p), [...(groups.get(group(p)) ?? []), p]);
  for (const [key, ids] of groups)
    groups.set(key, [
      ...ids.filter((p) => instance(p)?.members),
      ...ids.filter((p) => !instance(p)?.members),
    ]);
  // The instance a group opens on: the chosen model's, else its first pool or account that can
  // be picked.
  const opening = (key: string) => {
    const ids = groups.get(key) ?? [];
    return ids.includes(chosen.provider)
      ? chosen.provider
      : (ids.find((p) => !unavailable[p]) ?? ids[0]!);
  };
  // A group, or null for Favorites, and the instance its models are listed for.
  const [tab, setTab] = useState<string | null>(group(chosen.provider));
  const [account, setAccount] = useState<Provider>(chosen.provider);
  const [query, setQuery] = useState("");
  const [choosingAccount, setChoosingAccount] = useState(false);
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const accountChooser = useRef<HTMLButtonElement>(null);
  const accountMenu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!choosingAccount) return;
    const items = accountMenu.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"]:not(:disabled)',
    );
    (
      [...(items ?? [])].find((item) => item.getAttribute("aria-checked") === "true") ?? items?.[0]
    )?.focus();
  }, [choosingAccount]);
  const closeAccounts = () => {
    setChoosingAccount(false);
    accountChooser.current?.focus();
  };

  const q = query.trim().toLowerCase();
  const shown = models.filter((m) =>
    q ? m.name.toLowerCase().includes(q) : tab === null ? starred(m) : m.provider === account,
  );
  const Logo = logo(chosen.provider);
  const accounts = tab === null || q ? [] : (groups.get(tab) ?? []);
  // The chosen model's account, named on the button when its provider has more than one.
  const chosenAccount =
    (groups.get(group(chosen.provider))?.length ?? 0) > 1 ? nameOf(chosen.provider) : undefined;

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
        {chosenAccount && (
          <span className="max-w-32 truncate text-faint-foreground">{chosenAccount}</span>
        )}
        <ChevronDown aria-hidden className="opacity-70" />
      </button>
      <div
        ref={menu}
        id={id}
        popover="auto"
        onToggle={(e: ToggleEvent<HTMLDivElement>) => {
          if (e.newState === "open") search.current?.focus();
          else {
            setQuery("");
            setChoosingAccount(false);
          }
        }}
        onKeyDown={moveFocus}
        className={`${menuPanel()} h-96 w-[28rem] overflow-hidden p-0 [&:popover-open]:flex`}
      >
        <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border py-2">
          <button
            type="button"
            aria-label="Favorites"
            aria-pressed={!q && tab === null}
            onClick={() => {
              setTab(null);
              setChoosingAccount(false);
            }}
            className={railButton}
          >
            <Star />
          </button>
          <span aria-hidden className="my-1 h-px w-6 bg-border" />
          {[...groups].map(([key, ids]) => {
            const first = ids[0]!;
            const ProviderLogo = logo(first);
            // A group can't be picked only when none of its instances can.
            const why = ids.every((p) => unavailable[p]) ? unavailable[first] : undefined;
            const kind = instance(first)?.kind;
            const label = ids.length > 1 && kind ? kindOf(kind).name : nameOf(first);
            return (
              // A disabled button gets no pointer events, so its wrapper shows the tooltip.
              <span key={key} className="group relative flex">
                <button
                  type="button"
                  aria-label={label}
                  aria-pressed={!q && tab === key}
                  disabled={!!why}
                  aria-describedby={why ? `${id}-${key}` : undefined}
                  onClick={() => {
                    setTab(key);
                    setAccount(opening(key));
                    setChoosingAccount(false);
                  }}
                  className={railButton}
                >
                  <ProviderLogo />
                </button>
                {why && (
                  <span
                    id={`${id}-${key}`}
                    role="tooltip"
                    className="pointer-events-none invisible absolute top-1/2 left-full z-10 ml-2 w-56 -translate-y-1/2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-meta text-foreground shadow-composer group-hover:visible"
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
              className="min-w-0 flex-1 bg-transparent text-body placeholder:text-faint-foreground focus-visible:outline-none"
            />
          </label>
          {accounts.length > 1 && (
            <div className="relative border-b border-border px-1.5 py-1.5">
              <button
                type="button"
                ref={accountChooser}
                aria-label="Choose account"
                aria-haspopup="menu"
                aria-expanded={choosingAccount}
                onClick={() => setChoosingAccount(!choosingAccount)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  e.preventDefault();
                  e.stopPropagation();
                  setChoosingAccount(true);
                }}
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left hover:bg-hover"
              >
                <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
                  {instance(account)?.members ? (
                    <Layers className="size-4" />
                  ) : (
                    <UserRound className="size-4" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-body font-medium">
                    <span className="truncate">{nameOf(account)}</span>
                    {instance(account)?.members && (
                      <span className="text-meta text-faint-foreground">Auto</span>
                    )}
                  </span>
                  <span className="block truncate text-meta text-faint-foreground">
                    {instance(account)?.members
                      ? `Best available account · ${instance(account)!.members!.length} accounts`
                      : instance(account)?.account && instance(account)?.account !== nameOf(account)
                        ? instance(account)?.account
                        : "Use this account"}
                  </span>
                </span>
                <ChevronDown
                  aria-hidden
                  className={`size-3.5 shrink-0 text-muted-foreground ${choosingAccount ? "rotate-180" : ""}`}
                />
              </button>
              {choosingAccount && (
                <div
                  ref={accountMenu}
                  role="menu"
                  aria-label="Account"
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Escape") {
                      e.preventDefault();
                      closeAccounts();
                    } else moveFocus(e);
                  }}
                  className="absolute top-full right-2 left-2 z-10 max-h-48 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-composer"
                >
                  {accounts.map((p, index) => {
                    const pool = instance(p)?.members;
                    return (
                      <button
                        key={p}
                        type="button"
                        aria-label={nameOf(p)}
                        role="menuitemradio"
                        aria-checked={account === p}
                        disabled={!!unavailable[p]}
                        title={unavailable[p]}
                        onClick={() => {
                          setAccount(p);
                          closeAccounts();
                        }}
                        className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left enabled:hover:bg-hover aria-checked:bg-selected disabled:opacity-40 ${!pool && index > 0 && instance(accounts[index - 1]!)?.members ? "mt-1 border-t border-border pt-3" : ""}`}
                      >
                        {pool ? (
                          <Layers aria-hidden className="size-4 shrink-0 text-accent" />
                        ) : (
                          <UserRound
                            aria-hidden
                            className="size-4 shrink-0 text-muted-foreground"
                          />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2 text-body font-medium">
                            <span className="truncate">{nameOf(p)}</span>
                            {pool && <span className="text-meta text-faint-foreground">Auto</span>}
                          </span>
                          <span className="block text-meta text-faint-foreground">
                            {pool
                              ? `Most usage left · ${pool.length} accounts`
                              : instance(p)?.account && instance(p)?.account !== nameOf(p)
                                ? instance(p)?.account
                                : "Use this account only"}
                          </span>
                        </span>
                        <Check
                          aria-hidden
                          className={`size-3.5 shrink-0 text-accent ${account === p ? "" : "invisible"}`}
                        />
                      </button>
                    );
                  })}
                </div>
              )}
              {instance(account)?.members && (
                <p className="px-2.5 pt-1 pb-0.5 text-meta text-faint-foreground">
                  New threads use the account with the most usage left, then stay on it.
                </p>
              )}
            </div>
          )}
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
                      <span className="flex items-center gap-2 text-body">
                        {m.name}
                        {m.isNew && (
                          <span className="rounded-sm border border-accent px-1 text-caption font-semibold text-accent">
                            NEW
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-meta text-faint-foreground">
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
                    className="mr-1.5 grid size-7 place-items-center rounded-sm text-faint-foreground hover:text-foreground aria-pressed:text-amber-500 [&_svg]:size-4 aria-pressed:[&_svg]:fill-current"
                  >
                    <Star />
                  </button>
                </li>
              );
            })}
            {shown.length === 0 && (
              <li className="px-2.5 py-3 text-body text-faint-foreground">
                {q ? "No matching models" : "No favorites yet"}
              </li>
            )}
          </ul>
        </div>
      </div>
    </>
  );
}
