import { useEffect, useState } from "react";

import type { Profile } from "../preload/bridge";

/** The signed-in Parallax account (0034), kept current. Null when signed out, undefined until known. */
export function useProfile(): Profile | null | undefined {
  const [profile, setProfile] = useState<Profile | null>();
  useEffect(() => window.parallax.onProfile(setProfile), []);
  return profile;
}

/** First and last initials, as "RS", from the name, or the email's first letter without one. */
export function initials({ name, email }: Pick<Profile, "name" | "email">): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words.at(-1)!] : [words[0] ?? email];
  return letters
    .map((w) => w.charAt(0))
    .join("")
    .toUpperCase();
}

/** The profile's picture, or its initials on a circle, `size` pixels across. */
export function Avatar({ profile, size }: { profile: Profile; size: number }) {
  const style = { width: size, height: size, fontSize: size * 0.42 };
  return profile.picture ? (
    <img
      src={profile.picture}
      alt=""
      style={style}
      className="shrink-0 rounded-full object-cover"
    />
  ) : (
    <span
      aria-hidden
      style={style}
      className="grid shrink-0 place-items-center rounded-full bg-selected font-medium text-foreground"
    >
      {initials(profile)}
    </span>
  );
}
