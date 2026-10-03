import { ChevronDown, ChevronUp, Plus, Star, X } from "lucide-react";
import { useState } from "react";

import type { ProviderInfo, ProviderModel } from "../../protocol/generated/protocol";
import {
  arranged,
  instanceModels,
  prefsKey,
  toggled,
  toggleFavorite,
  updateModelPrefs,
  useModelPrefs,
  type Model,
} from "../models";
import { IconButton } from "../ui";
import { field, primaryButton, quietButton, Section, settingRow, Switch } from "./parts";

/** A context window's size, such as `200K` or `1M`. */
const tokens = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1000}K`);

/** What a model offers, in a few words: "1M context · Fast", or "Custom". */
function hint(m: Model): string {
  const parts = [
    m.contexts[0] && `${tokens(m.contexts[0])} context`,
    m.fast && "Fast",
    m.custom && "Custom",
  ];
  return parts.filter(Boolean).join(" · ");
}

const groupHeading = "border-border px-4 pt-3 pb-1.5 text-[12px] font-medium text-faint-foreground";

/**
 * An instance's models (`instanceModels`): favorites first, then all of them, each with a star, up
 * and down to reorder, and a switch to show it in the model picker, all kept on this device per
 * host. Custom models are the instance's own, saved on the host with `onSave`.
 */
export function ProviderModels({
  hostId,
  info,
  onSave,
}: {
  hostId: string;
  info: ProviderInfo;
  onSave: (models: ProviderModel[]) => Promise<void>;
}) {
  const key = prefsKey(hostId, info.instance.id);
  const p = useModelPrefs()[key];
  const list = arranged(instanceModels(info), p);
  const hidden = new Set(p?.hidden);
  const favorites = list.filter((m) => p?.favorites?.includes(m.id));
  const allHidden = list.every((m) => hidden.has(m.id));
  const [adding, setAdding] = useState(false);

  // Swaps a model with its neighbor in `group`, in the whole list's order.
  const move = (group: Model[], i: number, step: -1 | 1) => {
    const order = list.map((m) => m.id);
    const a = order.indexOf(group[i]!.id);
    const b = order.indexOf(group[i + step]!.id);
    [order[a], order[b]] = [order[b]!, order[a]!];
    updateModelPrefs(key, (prev) => ({ ...prev, order }));
  };

  const row = (group: Model[]) => (m: Model, i: number) => {
    const starred = favorites.includes(m);
    return (
      <div key={m.id} className={`${settingRow} py-2`}>
        <div className="flex min-w-0 items-center gap-2">
          <IconButton
            label={starred ? `Unfavorite ${m.name}` : `Favorite ${m.name}`}
            aria-pressed={starred}
            onClick={() => toggleFavorite(hostId, m.provider, m.id)}
          >
            <Star aria-hidden className={starred ? "fill-current text-amber-500" : undefined} />
          </IconButton>
          <div className="min-w-0">
            <span className="block truncate text-[13px]">{m.name}</span>
            <span className="block truncate font-mono text-[11.5px] text-faint-foreground">
              {m.id}
              {hint(m) && <span className="ml-2 font-sans">{hint(m)}</span>}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {m.custom && (
            <IconButton
              label={`Remove ${m.name}`}
              onClick={() => void onSave(info.instance.models.filter((c) => c.id !== m.id))}
            >
              <X aria-hidden />
            </IconButton>
          )}
          <IconButton
            label={`Move ${m.name} up`}
            disabled={i === 0}
            onClick={() => move(group, i, -1)}
          >
            <ChevronUp aria-hidden />
          </IconButton>
          <IconButton
            label={`Move ${m.name} down`}
            disabled={i === group.length - 1}
            onClick={() => move(group, i, 1)}
          >
            <ChevronDown aria-hidden />
          </IconButton>
          <span className="ml-1.5 flex">
            <Switch
              label={`Show ${m.name}`}
              checked={!hidden.has(m.id)}
              onChange={() =>
                updateModelPrefs(key, (prev) => ({ ...prev, hidden: toggled(prev.hidden, m.id) }))
              }
            />
          </span>
        </div>
      </div>
    );
  };

  return (
    <Section title="Models">
      <p className={`${settingRow} text-[12.5px] text-muted-foreground`}>
        Favorites, visibility, and ordering are saved on this device. Custom models are saved on the
        host.
      </p>
      <div className={`${settingRow} py-2`}>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={!list.length}
            className={quietButton}
            onClick={() =>
              updateModelPrefs(key, (prev) => ({
                ...prev,
                hidden: allHidden ? [] : list.map((m) => m.id),
              }))
            }
          >
            {allHidden ? "Enable all" : "Disable all"}
          </button>
          <span className="text-[12.5px] text-muted-foreground">
            {list.length} {list.length === 1 ? "model" : "models"} · {favorites.length}{" "}
            {favorites.length === 1 ? "favorite" : "favorites"}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={`${quietButton} flex items-center gap-1 [&_svg]:size-3.5`}
        >
          <Plus aria-hidden />
          Add custom model
        </button>
      </div>
      {adding && (
        <form
          aria-label="Add custom model"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const id = (data.get("id") as string).trim();
            const name = (data.get("name") as string).trim() || id;
            setAdding(false);
            void onSave([...info.instance.models.filter((c) => c.id !== id), { id, name }]);
          }}
          className="flex flex-col gap-3 border-border px-4 py-3.5 not-last:border-b"
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="text-[12.5px] text-muted-foreground">
              Model id
              <input
                name="id"
                required
                pattern="\S+"
                title="A model id has no spaces."
                placeholder="gpt-oss:120b"
                spellCheck={false}
                autoComplete="off"
                className={`${field} font-mono`}
              />
            </label>
            <label className="text-[12.5px] text-muted-foreground">
              Display name
              <input name="name" placeholder="GPT-OSS 120B" autoComplete="off" className={field} />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setAdding(false)} className={quietButton}>
              Cancel
            </button>
            <button type="submit" className={primaryButton}>
              Add model
            </button>
          </div>
        </form>
      )}
      {favorites.length > 0 && (
        <>
          <h3 className={groupHeading}>Favorites</h3>
          {favorites.map(row(favorites))}
        </>
      )}
      {list.length > 0 ? (
        <>
          <h3 className={groupHeading}>All</h3>
          {list.map(row(list))}
        </>
      ) : (
        <p className={`${settingRow} text-[12.5px] text-muted-foreground`}>
          plxd found no models for {info.instance.name}. Add one above.
        </p>
      )}
    </Section>
  );
}
