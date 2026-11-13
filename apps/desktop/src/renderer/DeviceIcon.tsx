import { Laptop, Monitor, Server, type LucideProps } from "lucide-react";

import { msg } from "../i18n";
import type { DeviceIcon as DeviceIconName } from "../preload/bridge";

/** A mini PC, such as a Mac mini, drawn like lucide's icons: a low box with a light. */
function MiniPc(props: LucideProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
      className={`lucide ${props.className ?? ""}`}
    >
      <rect x="2" y="7" width="20" height="10" rx="3" />
      <path d="M6 13h.01" />
    </svg>
  );
}

const icons = { laptop: Laptop, desktop: Monitor, mini: MiniPc, server: Server };

/** What each icon is, for people, in English: show it with `t`. */
export const deviceIconNames: Record<DeviceIconName, string> = {
  laptop: msg("Laptop"),
  desktop: msg("PC"),
  mini: msg("Mini PC"),
  server: msg("Server"),
};

/** A Parallax Connect device's icon (0056). */
export function DeviceIcon({ icon, ...props }: { icon: DeviceIconName } & LucideProps) {
  const Icon = icons[icon];
  return <Icon aria-hidden {...props} />;
}
