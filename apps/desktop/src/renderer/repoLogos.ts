// A repo with no icon takes its repository's own favicon or logo before its initials (PLX-1272).
import { useEffect, useRef } from "react";

import type { ChosenIcon } from "../protocol/generated/protocol";
import type { Host } from "./hosts";
import { readRepoLogo } from "./images";
import { isRepository, repoIconOf, type ThreadsView } from "./threads";

// The glyph under the image, for an app that doesn't draw images (0038).
const glyph = "folder-git-2";

/**
 * Each repo to look for a logo in, by `<hostId>/<repoId>` as `tried` holds them: a repository with
 * no icon of its own or from a namesake, on a computer whose plxd finds logos and keeps images.
 */
export function reposWantingLogo(
  hosts: Host[],
  views: Readonly<Record<string, ThreadsView>>,
  shared: ReadonlyMap<string, ChosenIcon>,
  tried: ReadonlySet<string>,
) {
  return hosts.flatMap((host) => {
    const view = views[host.id];
    if (!view || !("repoLogo" in view.capabilities) || !view.iconImageBytes) return [];
    return view.state.repos
      .filter(
        (repo) =>
          isRepository(repo) && !repoIconOf(repo, shared) && !tried.has(`${host.id}/${repo.id}`),
      )
      .map((repo) => ({ hostId: host.id, repo: repo.id, maxBytes: view.iconImageBytes! }));
  });
}

/**
 * Looks in each repo wanting a logo, once a session, so one with none costs a `git ls-files` per
 * launch. Stored as the repo's icon, every client and namesake draws it with no further look.
 */
export function useRepoLogos(
  hosts: Host[],
  views: Readonly<Record<string, ThreadsView>>,
  shared: ReadonlyMap<string, ChosenIcon>,
) {
  const tried = useRef(new Set<string>());
  useEffect(() => {
    for (const { hostId, repo, maxBytes } of reposWantingLogo(
      hosts,
      views,
      shared,
      tried.current,
    )) {
      tried.current.add(`${hostId}/${repo}`);
      const update = views[hostId]!.updateRepo;
      void (async () => {
        const answer = await window.parallax.request(hostId, "repo/logo", { repo });
        const logo = "result" in answer ? answer.result.logo : undefined;
        const image = logo && (await readRepoLogo(logo, maxBytes));
        // plxd keeps an icon the user picked meanwhile.
        if (image) await update(repo, { icon: { name: glyph, image }, iconIfUnset: true });
      })();
    }
  }, [hosts, views, shared]);
}
