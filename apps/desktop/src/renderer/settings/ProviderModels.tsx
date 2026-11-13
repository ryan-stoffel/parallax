import { t } from "i18next";
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
    m.contexts[0] && t("{{size}} context", { size: tokens(m.contexts[0]) }),
    m.fast && t("Fast"),
    m.custom && t("Custom"),
  ];
  return parts.filter(Boolean).join(" · ");
}

const groupHeading = "border-border px-4 pt-3 pb-1.5 text-meta font-medium text-faint-foreground";

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
            label={
              starred
                ? t("Unfavorite {{name}}", { name: m.name })
                : t("Favorite {{name}}", { name: m.name })
            }
            aria-pressed={starred}
            onClick={() => toggleFavorite(hostId, m.provider, m.id)}
          >
            <Star aria-hidden className={starred ? "fill-current text-amber-500" : undefined} />
          </IconButton>
          <div className="min-w-0">
            <span className="block truncate text-body">{m.name}</span>
            <span className="block truncate font-mono text-meta text-faint-foreground">
              {m.id}
              {hint(m) && <span className="ml-2 font-sans">{hint(m)}</span>}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {m.custom && (
            <IconButton
              label={t("Remove {{name}}", { name: m.name })}
              onClick={() => void onSave(info.instance.models.filter((c) => c.id !== m.id))}
            >
              <X aria-hidden />
            </IconButton>
          )}
          <IconButton
            label={t("Move {{name}} up", { name: m.name })}
            disabled={i === 0}
            onClick={() => move(group, i, -1)}
          >
            <ChevronUp aria-hidden />
          </IconButton>
          <IconButton
            label={t("Move {{name}} down", { name: m.name })}
            disabled={i === group.length - 1}
            onClick={() => move(group, i, 1)}
          >
            <ChevronDown aria-hidden />
          </IconButton>
          <span className="ml-1.5 flex">
            <Switch
              label={t("Show {{name}}", { name: m.name })}
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
    <Section title={t("Models")}>
      <p className={`${settingRow} text-body text-muted-foreground`}>
        {t(
          "Favorites, visibility, and ordering are saved on this device. Custom models are saved on the host.",
        )}
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
            {allHidden ? t("Enable all") : t("Disable all")}
          </button>
          <span className="text-body text-muted-foreground">
            {t("{{count}} models", { count: list.length, defaultValue_one: "{{count}} model" })}
            {" · "}
            {t("{{count}} favorites", {
              count: favorites.length,
              defaultValue_one: "{{count}} favorite",
            })}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={`${quietButton} flex items-center gap-1 [&_svg]:size-3.5`}
        >
          <Plus aria-hidden />
          {t("Add custom model")}
        </button>
      </div>
      {adding && (
        <form
          aria-label={t("Add custom model")}
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
            <label className="text-body text-muted-foreground">
              {t("Model id")}
              <input
                name="id"
                required
                pattern="\S+"
                title={t("A model id has no spaces.")}
                placeholder="gpt-oss:120b"
                spellCheck={false}
                autoComplete="off"
                className={`${field} font-mono`}
              />
            </label>
            <label className="text-body text-muted-foreground">
              {t("Display name")}
              <input name="name" placeholder="GPT-OSS 120B" autoComplete="off" className={field} />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setAdding(false)} className={quietButton}>
              {t("Cancel")}
            </button>
            <button type="submit" className={primaryButton}>
              {t("Add model")}
            </button>
          </div>
        </form>
      )}
      {favorites.length > 0 && (
        <>
          <h3 className={groupHeading}>{t("Favorites")}</h3>
          {favorites.map(row(favorites))}
        </>
      )}
      {list.length > 0 ? (
        <>
          <h3 className={groupHeading}>{t("All", { context: "every model" })}</h3>
          {list.map(row(list))}
        </>
      ) : (
        <p className={`${settingRow} text-body text-muted-foreground`}>
          {t("plxd found no models for {{name}}. Add one above.", { name: info.instance.name })}
        </p>
      )}
    </Section>
  );
}
