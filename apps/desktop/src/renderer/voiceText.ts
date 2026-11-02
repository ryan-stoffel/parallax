import { behaviorPrefs } from "./prefs";

/** Keep dictated words separate from an existing draft, without parsing Markdown. */
export function voiceText(text: string, before: string, after: string): string {
  const prefix = before && !/\s$/.test(before) && /^[\p{L}\p{N}]/u.test(text) ? " " : "";
  const suffix = /^[\p{L}\p{N}]/u.test(after) && !/\s$/.test(text) ? " " : "";
  return prefix + text + suffix;
}

/** A transcript as it goes in: tidied by the host's small model, when that's on and it answers. */
export async function cleanDictation(
  text: string,
  hostId: string | undefined,
  where: { backend?: string | undefined; repo?: string | undefined; runId?: string | undefined },
): Promise<string> {
  if (!hostId || !behaviorPrefs.get().cleanDictation) return text;
  const { backend, repo, runId } = where;
  const response = await window.parallax.request(hostId, "voice/clean", {
    text,
    ...(backend && { backend }),
    ...(runId ? { runId } : repo ? { repo } : {}),
  });
  return "result" in response ? response.result.text : text;
}
