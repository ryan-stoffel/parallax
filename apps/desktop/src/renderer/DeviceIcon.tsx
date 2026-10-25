import type { SVGProps } from "react";

import { Laptop, Monitor, Server, type IconProps } from "./icons";

import type { DeviceIcon as DeviceIconName } from "../preload/bridge";

/**
 * A mini PC, such as a Mac mini, drawn like Hugeicons' stroke-rounded icons (Hugeicons has none): a
 * low box with a light.
 */
function MiniPc(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-icon="mini-pc"
      {...props}
    >
      <rect x="2" y="7" width="20" height="10" rx="4" />
      <path d="M6 13h.01" />
    </svg>
  );
}

const icons = { laptop: Laptop, desktop: Monitor, mini: MiniPc, server: Server };

/** What each icon is, for people. */
export const deviceIconNames: Record<DeviceIconName, string> = {
  laptop: "Laptop",
  desktop: "PC",
  mini: "Mini PC",
  server: "Server",
};

/** A Parallax Connect device's icon (0056). */
export function DeviceIcon({ icon, ...props }: { icon: DeviceIconName } & IconProps) {
  const Icon = icons[icon];
  return <Icon aria-hidden {...props} />;
}
