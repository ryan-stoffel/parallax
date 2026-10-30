// Repository and orchestrator icons, as the desktop's Sidebar.tsx draws them (0032, 0033, 0038): an
// uploaded image, else the chosen lucide glyph in its palette color, else for a repository its
// initials on a tile in a color picked from its name. A repository with no icon of its own wears
// its namesake's from another computer (`sharedRepoIcons`).
import * as Lucide from "lucide-react-native";
import { useMemo } from "react";
import { Image, Text, View } from "react-native";

import type { ChosenIcon, Repo } from "../../desktop/src/protocol/generated/protocol";
import { initials } from "../../desktop/src/renderer/attention";
import { isRepository, repoIconOf } from "../../desktop/src/renderer/threads";
import { useFleet } from "./fleet";
import type { Colors } from "./theme";
import { useColors } from "./ui";

const palette = ["red", "orange", "yellow", "green", "teal", "sky", "violet", "pink", "gray"] as const;

/** A palette key's color, such as `green`, or undefined for one this app doesn't know. */
const tone = (c: Colors, key?: string) =>
  key && (palette as readonly string[]).includes(key)
    ? c[`project${key[0]!.toUpperCase()}${key.slice(1)}` as keyof Colors]
    : undefined;

/** An orchestrator's icon: its image, or its glyph (kebab-case lucide name) in its color. */
export function OrchestratorGlyph({ icon, size = 18 }: { icon?: ChosenIcon; size?: number }) {
  const c = useColors();
  if (icon?.image)
    return (
      <Image
        source={{ uri: `data:${icon.image.mediaType};base64,${icon.image.data}` }}
        style={{ width: size, height: size, borderRadius: size * 0.22 }}
      />
    );
  const name = (icon?.name ?? "layers").replace(/(^|-)(\w)/g, (_, __, ch: string) => ch.toUpperCase());
  const Glyph = (Lucide as unknown as Record<string, Lucide.LucideIcon | undefined>)[name] ?? Lucide.Layers;
  return <Glyph size={size} color={tone(c, icon?.color) ?? c.accent} strokeWidth={2} />;
}

/** A repository's icon, its namesake's, or its initials on a tile. No repo is a dashed square. */
export function RepoIcon({
  repo,
  shared,
  size = 18,
}: {
  repo?: Repo;
  shared?: ReadonlyMap<string, ChosenIcon>;
  size?: number;
}) {
  const c = useColors();
  if (!repo || repo.scratch)
    return <Lucide.SquareDashed size={size} color={c.faintForeground} strokeWidth={2} />;
  const icon = repoIconOf(repo, shared ?? new Map());
  if (icon) return <OrchestratorGlyph icon={icon} size={size} />;
  let hash = 0;
  for (let i = 0; i < repo.name.length; i++) hash = (hash * 31 + repo.name.charCodeAt(i)) | 0;
  const color = tone(c, palette[Math.abs(hash) % palette.length]) as string;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.25,
        backgroundColor: `${color}26`,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color, fontSize: size * 0.5, fontWeight: "700" }}>{initials(repo.name)}</Text>
    </View>
  );
}

/** Every computer's repository icons by name, as the desktop's `sharedRepoIcons` gathers them. */
export function useSharedIcons() {
  const { computers } = useFleet();
  return useMemo(() => {
    const icons = new Map<string, ChosenIcon>();
    for (const m of computers)
      for (const repo of m.view.state.repos)
        if (isRepository(repo) && repo.icon && !icons.has(repo.name)) icons.set(repo.name, repo.icon);
    return icons;
  }, [computers]);
}
