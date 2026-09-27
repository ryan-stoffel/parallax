/** Whether a link the renderer tried to open may go to the system browser: only https. */
export function isOpenableExternally(url: string): boolean {
  return URL.parse(url)?.protocol === "https:";
}
