/** Keep dictated words separate from an existing draft, without parsing Markdown. */
export function voiceText(text: string, before: string, after: string): string {
  const prefix = before && !/\s$/.test(before) && /^[\p{L}\p{N}]/u.test(text) ? " " : "";
  const suffix = /^[\p{L}\p{N}]/u.test(after) && !/\s$/.test(text) ? " " : "";
  return prefix + text + suffix;
}
