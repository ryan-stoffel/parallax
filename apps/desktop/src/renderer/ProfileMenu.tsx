import { CircleUser, LogIn, LogOut, Settings, UserPlus, type LucideIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { AccountDialog, SecuredByClerk } from "./Account";
import type { Host } from "./hosts";
import { ParallaxMark } from "./logos";
import { Avatar, useProfile } from "./profile";
import type { ThreadsView } from "./threads";
import { IconButton, Menu, menuItem } from "./ui";

/**
 * The sidebar footer's Profile button (0067): the account's picture or initials, which opens a
 * menu above it. Signed in, the menu shows the account with Manage account, which opens the
 * Account dialog, and Sign out. Signed out, it offers Sign in and Create an account, which open
 * Clerk's pages in the browser.
 */
export function ProfileButton({ listed }: { listed: { host: Host; view: ThreadsView }[] }) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const profile = useProfile();
  const [managing, setManaging] = useState(false);
  // Signing out drops the dialog without its close event, so it doesn't come back on sign-in.
  if (managing && !profile) setManaging(false);

  // Sign in's answer. Only the latest sign-in's shows: a replaced one answers "cancelled" late.
  const [note, setNote] = useState<string>();
  const latest = useRef(0);
  const signIn = async (create: boolean) => {
    const n = ++latest.current;
    setNote("Finish signing in in your browser.");
    const answer = await window.parallax.signIn(create);
    if (n === latest.current) setNote(answer);
  };
  const item = (Icon: LucideIcon, label: string, onClick: () => void) => (
    <button type="button" role="menuitem" onClick={onClick} className={menuItem}>
      <Icon aria-hidden className="text-muted-foreground" />
      {label}
    </button>
  );
  const closing = (run: () => void) => () => {
    menu.current?.hidePopover();
    run();
  };

  return (
    <>
      <IconButton
        label={profile ? profile.name || profile.email : "Profile"}
        popoverTarget={id}
        aria-haspopup="menu"
      >
        {profile ? <Avatar profile={profile} size={22} /> : <CircleUser />}
      </IconButton>
      <Menu ref={menu} id={id} label="Account" className="w-64 p-1">
        {profile !== undefined && (
          <>
            <div className="flex items-center gap-2.5 px-2 py-2">
              {profile ? (
                <Avatar profile={profile} size={32} />
              ) : (
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-selected text-muted-foreground [&_svg]:size-4">
                  <CircleUser aria-hidden />
                </span>
              )}
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium">
                  {profile ? profile.name || profile.email : "Sign in to Parallax"}
                </p>
                {(profile?.name || !profile) && (
                  <p role="status" className="truncate text-[12px] text-muted-foreground">
                    {profile ? profile.email : (note ?? "With GitHub, Google, Apple, or email.")}
                  </p>
                )}
              </div>
            </div>
            <div role="separator" className="my-1 h-px bg-border" />
            {profile ? (
              <>
                {item(
                  Settings,
                  "Manage account",
                  closing(() => setManaging(true)),
                )}
                {item(
                  LogOut,
                  "Sign out",
                  closing(() => void window.parallax.signOut()),
                )}
              </>
            ) : (
              <>
                {item(LogIn, "Sign in", () => void signIn(false))}
                {item(UserPlus, "Create an account", () => void signIn(true))}
              </>
            )}
            <div role="separator" className="my-1 h-px bg-border" />
          </>
        )}
        <div className="flex items-center justify-between px-2 py-1">
          <span className="flex items-center gap-1.5 font-brand text-[12px] font-semibold text-faint-foreground">
            <ParallaxMark className="size-3.5" />
            Parallax
          </span>
          <SecuredByClerk />
        </div>
      </Menu>
      {managing && profile && (
        <AccountDialog profile={profile} listed={listed} onClose={() => setManaging(false)} />
      )}
    </>
  );
}
