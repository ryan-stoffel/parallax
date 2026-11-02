import { Check, ChevronDown, Network, Search, SearchX, Star, Zap } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode, type ToggleEvent } from "react";

import type { AgentEffort } from "../protocol/generated/protocol";
import { effortLevels, isNew } from "./catalog";
import { tokens } from "./EffortMenu";
import {
  prefsKey,
  toggleFavorite,
  useModelPrefs,
  type Catalog,
  type Instance,
  type Model,
  type Provider,
} from "./models";
import { ensureHubs, useHubs } from "./hubs";
import { PlanLabel } from "./PlanLabel";
import { kindOf, listedProviders, loadProviders, logoOf } from "./providers";
import { menuButton, menuPanel, moveFocus, Picker, Segmented } from "./ui";

/** What the composer's picker sets beside the model. Each that's absent isn't offered. */
export interface RunOptions {
  effort?: AgentEffort;
  onEffort: (effort: AgentEffort) => void;
  /** The context windows the model offers, in tokens. */
  contexts: number[];
  context?: number;
  onContext: (tokens: number) => void;
  fast?: boolean;
  onFast: (fast: boolean) => void;
  /** The access picker. */
  access?: ReactNode;
}

// Where the text's baseline and capitals fall in a 16px icon beside it, once the icon is nudged up
// to center on them (`onCapitals`). The bars stand on the one and rise to the other.
const baseline = 12.75;
const capHeight = 9.5;
/** Centers its icons on the text's capitals, which sit half a pixel above the line's center. */
const onCapitals = "[&>*]:-translate-y-[0.5px]";

/** A reasoning level as a bar chart: one rising bar per level, lit up to `value`. */
function ReasoningBars({ value }: { value: AgentEffort }) {
  const level = effortLevels.findIndex((l) => l.value === value);
  return (
    <svg aria-hidden viewBox="0 0 16 16" fill="currentColor" className="reasoning-bars">
      {effortLevels.map((l, i) => {
        const height = capHeight * ((i + 1.25) / (effortLevels.length + 0.25));
        return (
          <rect
            key={l.value}
            x={1 + i * 3}
            y={baseline - height}
            width={2}
            height={height}
            rx={0.5}
            opacity={i <= level ? 1 : 0.25}
          />
        );
      })}
    </svg>
  );
}

/** Who an instance signs in as: its own account, or a hub's enabled accounts of its kind. */
interface Account {
  email?: string;
  plan?: string;
}

/** An instance's own account, if it has an email or a plan to show. */
function ownAccount(i: Instance): Account[] {
  const email = [i.account, i.name].find((text) => text?.includes("@"));
  return email || i.plan ? [{ ...(email && { email }), ...(i.plan && { plan: i.plan }) }] : [];
}

/** An instance as a choice among its group's: a hub's by its kind, an email before its @. */
const choiceName = (i: Instance) => (i.hub ? kindOf(i.kind).name : i.name.split("@")[0]!);

/** `i`'s name among `all`: short, unless another's short name is the same. */
const uniqueChoiceName = (i: Instance, all: (Instance | undefined)[]) =>
  all.filter((other) => other && choiceName(other) === choiceName(i)).length > 1
    ? i.name
    : choiceName(i);

// The same model can run on two instances, so a model is known by both.
const keyOf = (m: Model) => `${m.provider}/${m.id}`;

/**
 * The rail's group for an instance: its kind, so a provider's accounts share one button, except
 * an ACP agent, which is its own.
 */
const groupOf = (i: Pick<Instance, "id" | "kind" | "hub">) =>
  i.hub ? `hub/${i.hub}` : i.kind === "acp" ? i.id : i.kind;

// A rail button's pressed look, a raised tile, is in index.css's `.model-menu-rail`.
const railButton =
  "grid size-8 place-items-center rounded-md text-muted-foreground transition-colors duration-150 enabled:hover:bg-hover aria-pressed:text-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4";

/**
 * The model picker: a button showing the chosen model that opens a searchable list of the
 * `catalog`'s models, with a rail to filter by favorites or provider. A provider with more than
 * one account, and a hub with its Claude Code and Codex, has one rail button and a segmented
 * control over its models that picks which runs the thread. Under it, who that signs in as, with
 * each account's plan. Its rows name only their models; Favorites and search, which mix providers,
 * also say whose each is. A native popover, so Escape and clicking away close it, and it flips
 * above the button when there's no room below. The models of instances in `unavailable` aren't
 * listed, and the rail and the control show those instances disabled, saying why on hover.
 * Opening it asks the host again, so it follows Settings > Providers. Favorites are kept on this
 * device, per host. With `options`, the composer's, the button also shows the reasoning level as
 * bars and a bolt in fast mode, and the panel adds a Reasoning column and a footer with the speed,
 * context window, and access. Choosing those leaves it open, and choosing a model closes it.
 */
export function ModelMenu({
  catalog,
  unavailable = {},
  value: chosen,
  onChange,
  options,
}: {
  catalog: Catalog;
  /** Instances whose models can't be picked here, by why. */
  unavailable?: Partial<Record<Provider, string>>;
  value: Model;
  onChange: (model: Model) => void;
  options?: RunOptions;
}) {
  const all = catalog.models.filter((m) =>
    catalog.instances.some((i) => i.id === m.provider && i.enabled),
  );
  const models = all.filter((m) => !unavailable[m.provider]);
  const prefs = useModelPrefs();
  const hubs = useHubs(catalog.hostId);
  const starred = (m: Model) =>
    !!prefs[prefsKey(catalog.hostId, m.provider)]?.favorites?.includes(m.id);
  const instance = (id: Provider) => catalog.instances.find((i) => i.id === id);
  const logo = (id: Provider) => {
    const found = instance(id);
    return found ? logoOf(found) : kindOf(id).Logo;
  };
  const nameOf = (id: Provider) => instance(id)?.name ?? id;
  const accountsOf = (id: Provider): Account[] => {
    const i = instance(id);
    if (!i) return [];
    if (!i.hub) return ownAccount(i);
    const accounts = hubs?.find((h) => h.id === i.hub)?.accounts ?? [];
    return accounts.filter((a) => !a.disabled && a.provider === i.kind && (a.email || a.plan));
  };
  const group = (id: Provider) => {
    const found = instance(id);
    return found ? groupOf(found) : id;
  };
  // Each group's instances that offer models.
  const listed = [...new Set(all.map((m) => m.provider))];
  const groups = new Map<string, Provider[]>();
  for (const p of listed) groups.set(group(p), [...(groups.get(group(p)) ?? []), p]);
  // The instance a group opens on: the chosen model's, else its first account that can be picked.
  const opening = (key: string) => {
    const ids = groups.get(key) ?? [];
    return ids.includes(chosen.provider) && !unavailable[chosen.provider]
      ? chosen.provider
      : (ids.find((p) => !unavailable[p]) ?? ids[0]!);
  };
  // A group, or null for Favorites, and the instance its models are listed for.
  const [selectedTab, setTab] = useState<string | null>(group(chosen.provider));
  const tab =
    selectedTab === null || groups.has(selectedTab)
      ? selectedTab
      : (groups.keys().next().value ?? null);
  const [selectedAccount, setAccount] = useState<Provider>(chosen.provider);
  const account =
    tab && groups.get(tab)?.includes(selectedAccount) && !unavailable[selectedAccount]
      ? selectedAccount
      : tab
        ? opening(tab)
        : chosen.provider;
  const [query, setQuery] = useState("");
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const hasHub = catalog.instances.some((i) => i.hub);
  // Before the first open, so a hub's accounts are there as it opens.
  useEffect(() => {
    if (hasHub) void ensureHubs(catalog.hostId);
  }, [catalog.hostId, hasHub]);

  const q = query.trim().toLowerCase();
  const shown = models.filter((m) =>
    q ? m.name.toLowerCase().includes(q) : tab === null ? starred(m) : m.provider === account,
  );
  const Logo = logo(chosen.provider);
  // Favorites and search results mix providers, so only their rows say whose each model is.
  const mixed = tab === null || !!q;
  const choices = mixed ? [] : (groups.get(tab) ?? []);
  const shownAccounts = mixed ? [] : accountsOf(account);

  const pick = (m: Model) => {
    onChange(m);
    menu.current?.hidePopover();
  };
  const shortName = chosen.name.replace(/^Claude /, "");
  const effortName = effortLevels.find((l) => l.value === options?.effort)?.name;
  const speed = options?.fast !== undefined;
  // One context window is no choice, so there's nothing to show.
  const hasContexts = options?.context !== undefined && options.contexts.length > 1;

  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        aria-haspopup="menu"
        aria-label={`Model: ${chosen.name}${effortName ? `, reasoning ${effortName}` : ""}${options?.fast ? ", fast" : ""}`}
        className={`${menuButton} min-w-0 [&>:not(.model-name)]:-translate-y-[0.5px]`}
      >
        <Logo />
        <span className="model-name min-w-0 truncate">{shortName}</span>
        {options?.effort && <ReasoningBars value={options.effort} />}
        {options?.fast && <Zap aria-hidden className="composer-pop fill-current" />}
        {!options && <ChevronDown aria-hidden className="opacity-70" />}
      </button>
      <div
        ref={menu}
        id={id}
        popover="auto"
        onToggle={(e: ToggleEvent<HTMLDivElement>) => {
          // A nested picker's, such as Access's: this panel stays as it is. A closing one still
          // holds focus while it fades out, and would drop it, so focus comes back here.
          if (e.target !== e.currentTarget) {
            const panel = e.currentTarget;
            const active = document.activeElement;
            if (
              e.newState === "closed" &&
              panel.matches(":popover-open") &&
              ((e.target as Element).contains(active) || !panel.contains(active))
            )
              search.current?.focus();
            return;
          }
          if (e.newState === "open") {
            setTab(group(chosen.provider));
            setAccount(chosen.provider);
            search.current?.focus();
            if (listedProviders(catalog.hostId)) void loadProviders(catalog.hostId);
            if (hasHub) void ensureHubs(catalog.hostId);
          } else setQuery("");
        }}
        onKeyDown={(e) => {
          // In the composer's form, Enter in a field would send the message.
          if (e.key === "Enter" && e.target instanceof HTMLInputElement) e.preventDefault();
          moveFocus(e);
        }}
        className={`${menuPanel(options ? "end" : "start")} model-menu pop-in h-[26rem] ${options ? "w-[42rem] max-w-[90vw]" : "w-[30rem]"} flex-col overflow-hidden p-0 [&:popover-open]:flex`}
      >
        <div className="flex min-h-0 flex-1">
          <div className="model-menu-rail flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border py-2">
            <button
              type="button"
              aria-label="Favorites"
              aria-pressed={!q && tab === null}
              onClick={() => setTab(null)}
              className={`${railButton} aria-pressed:[&_svg]:fill-current aria-pressed:[&_svg]:text-amber-500`}
            >
              <Star />
            </button>
            <span aria-hidden className="my-1 h-px w-5 bg-border" />
            {[...groups].map(([key, ids]) => {
              const first = ids[0]!;
              const ProviderLogo = instance(first)?.hub ? Network : logo(first);
              // A group can't be picked only when none of its instances can.
              const why = ids.every((p) => unavailable[p]) ? unavailable[first] : undefined;
              const kind = instance(first)?.kind;
              // One named by its email is named by its kind here, which fits a tooltip.
              const label =
                instance(first)?.hubName ??
                (kind && (ids.length > 1 || nameOf(first).includes("@"))
                  ? kindOf(kind).name
                  : nameOf(first));
              return (
                // A disabled button gets no pointer events, so its wrapper shows the tooltip.
                <span key={key} className="group relative flex">
                  <button
                    type="button"
                    aria-label={label}
                    title={label}
                    aria-pressed={!q && tab === key}
                    disabled={!!why}
                    aria-describedby={why ? `${id}-${key}` : undefined}
                    onClick={() => {
                      setTab(key);
                      setAccount(opening(key));
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
            {/* It's focused as the menu opens, so focus doesn't change its rule. */}
            <label className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-4">
              <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
              <input
                ref={search}
                type="search"
                aria-label="Search models"
                placeholder="Search models…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && q && shown[0]) pick(shown[0]);
                }}
                className="min-w-0 flex-1 bg-transparent text-body placeholder:text-faint-foreground focus-visible:outline-none"
              />
            </label>
            {!mixed && (choices.length > 1 || shownAccounts.length > 0) && (
              <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-4 py-2.5">
                {choices.length > 1 && (
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                    <span className="min-w-0 truncate text-meta font-medium text-foreground">
                      {instance(account)?.hubName ?? kindOf(instance(account)?.kind ?? "").name}
                    </span>
                    <Segmented
                      label={instance(account)?.hub ? "Provider" : "Account"}
                      value={account}
                      onChange={setAccount}
                      wrap
                      options={choices.map((p) => {
                        const ChoiceLogo = logo(p);
                        const found = instance(p);
                        return {
                          value: p,
                          name: (
                            <>
                              <ChoiceLogo aria-hidden />
                              <span className="max-w-28 truncate">
                                {found ? uniqueChoiceName(found, choices.map(instance)) : p}
                              </span>
                            </>
                          ),
                          disabled: !!unavailable[p],
                          title: unavailable[p] ?? found?.name ?? p,
                        };
                      })}
                    />
                  </div>
                )}
                {shownAccounts.length > 0 && (
                  <ul className="flex max-h-[4.75rem] flex-col gap-1 overflow-y-auto text-meta text-muted-foreground">
                    {shownAccounts.map((a, i) => (
                      <li key={`${a.email}/${i}`} className="flex min-h-5 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">
                          {a.email ?? kindOf(instance(account)?.kind ?? "").name}
                        </span>
                        {a.plan && <PlanLabel kind={instance(account)!.kind} plan={a.plan} />}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <ul className="min-h-0 flex-1 scroll-py-1.5 overflow-y-auto p-1.5">
              {shown.map((m) => {
                const ProviderLogo = logo(m.provider);
                const key = keyOf(m);
                const favorite = starred(m);
                const current = key === keyOf(chosen);
                return (
                  // Keyboard focus rings the whole row, star included, in the app's focus ring.
                  <li
                    key={key}
                    className={`group/row flex h-8 items-center rounded-md transition-colors duration-100 hover:bg-hover ${current ? "bg-selected" : ""} has-[[role=menuitemradio]:focus-visible]:outline-2 has-[[role=menuitemradio]:focus-visible]:-outline-offset-2 has-[[role=menuitemradio]:focus-visible]:outline-ring`}
                  >
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={current}
                      onClick={() => pick(m)}
                      className="flex h-full min-w-0 flex-1 items-center gap-2 pr-1 pl-2.5 text-left focus-visible:outline-none"
                    >
                      <span
                        className={`flex min-w-0 flex-1 items-center gap-2 text-body ${current ? "font-medium" : ""}`}
                      >
                        <span title={m.id || undefined} className="truncate">
                          {m.name}
                        </span>
                        {isNew(m) && (
                          <span
                            title="Newly released or first discovered in the past week"
                            className="shrink-0 rounded-full bg-accent/12 px-1.5 text-caption leading-4 font-medium text-accent"
                          >
                            New
                          </span>
                        )}
                        {mixed && (
                          <span className="ml-auto flex min-w-0 items-center gap-1.5 text-meta font-normal text-faint-foreground">
                            <ProviderLogo className="size-3 shrink-0" />
                            <span className="truncate">{nameOf(m.provider)}</span>
                          </span>
                        )}
                      </span>
                      <Check
                        aria-hidden
                        className={`size-3.5 shrink-0 text-accent ${current ? "" : "invisible"}`}
                      />
                    </button>
                    {/* Shown while its row is hovered or focused, or once it's a favorite. */}
                    <button
                      type="button"
                      aria-label={favorite ? `Unfavorite ${m.name}` : `Favorite ${m.name}`}
                      aria-pressed={favorite}
                      onClick={() => toggleFavorite(catalog.hostId, m.provider, m.id)}
                      className="mr-1 grid size-6 shrink-0 place-items-center rounded-sm text-faint-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100 hover:text-foreground aria-pressed:text-amber-500 aria-pressed:opacity-100 [&_svg]:size-3.5 aria-pressed:[&_svg]:fill-current"
                    >
                      <Star />
                    </button>
                  </li>
                );
              })}
              {shown.length === 0 && (
                <li className="flex h-full flex-col items-center justify-center gap-1 px-6 pb-4 text-center">
                  <span className="mb-2 grid size-11 place-items-center rounded-full bg-hover text-faint-foreground ring-1 ring-border ring-inset [&_svg]:size-6">
                    {q ? <SearchX aria-hidden /> : <Star aria-hidden />}
                  </span>
                  <span className="text-body font-medium">
                    {q
                      ? "No matching models"
                      : tab === null
                        ? "No favorites yet"
                        : "No models available"}
                  </span>
                  <span className="text-meta text-faint-foreground">
                    {q
                      ? "Try another name."
                      : tab === null
                        ? "Star a model to keep it here."
                        : "Check your providers in Settings."}
                  </span>
                </li>
              )}
            </ul>
          </div>
          {options?.effort && (
            <div className="model-menu-reasoning flex w-48 shrink-0 flex-col border-l border-border">
              <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-4 text-body text-muted-foreground">
                Reasoning
                <span className="model-menu-for truncate text-meta text-faint-foreground">
                  {shortName}
                </span>
              </div>
              <ul aria-label="Reasoning" className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {effortLevels.map((l) => {
                  const current = l.value === options.effort;
                  return (
                    <li key={l.value}>
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={current}
                        title={l.blurb}
                        onClick={() => options.onEffort(l.value)}
                        className={`flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-body hover:bg-hover [&_svg]:size-4 [&_svg]:shrink-0 ${onCapitals} ${current ? "bg-selected font-medium" : ""}`}
                      >
                        <ReasoningBars value={l.value} />
                        <span className="min-w-0 flex-1 truncate">{l.name}</span>
                        {current && <Check aria-hidden className="text-accent" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
        {(speed || hasContexts || options?.access) && (
          <div className="flex h-11 shrink-0 items-center gap-2 border-t border-border px-2">
            {speed && (
              <Segmented
                label="Speed"
                value={options.fast ? "fast" : "standard"}
                onChange={(next) => options.onFast(next === "fast")}
                options={[
                  { value: "standard", name: "Standard" },
                  {
                    value: "fast",
                    name: (
                      <>
                        <Zap aria-hidden className="fill-current" />
                        Fast
                      </>
                    ),
                  },
                ]}
              />
            )}
            {hasContexts && (
              <Picker
                label="Context window"
                value={String(options.context)}
                onChange={(v) => options.onContext(Number(v))}
                options={options.contexts.map((n) => ({ value: String(n), label: tokens(n) }))}
                panelClassName="min-w-28"
              />
            )}
            {options?.access && <div className="ml-auto">{options.access}</div>}
          </div>
        )}
      </div>
    </>
  );
}
