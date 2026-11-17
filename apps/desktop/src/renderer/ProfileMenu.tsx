import { t } from "i18next";
import {
  ChartNoAxesColumn,
  CircleUser,
  GitPullRequest,
  LogIn,
  LogOut,
  Settings,
  UserCog,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { useId, useRef, useState } from "react";

import { AccountDialog, SecuredByClerk } from "./Account";
import { useShortcutLabel } from "./keybindings";
import { ParallaxMark } from "./logos";
import { Avatar, useProfile } from "./profile";
import type { SettingsSection } from "./App";
import type { HostThreads } from "./Sidebar";
import { icons } from "./icons";
import type { NavRow } from "./sidebarPrefs";
import { IconButton, Menu, menuItem, useModHeld } from "./ui";

/**
 * The sidebar footer's Profile button (0067): the account's picture or initials beside its name
 * (or its email when it has none), which opens a menu above it. Settings' shortcut shows in the
 * menu only while Mod is held. The menu always offers Settings, and in the Inbox sidebar Pull
 * requests, Issues, and Usage first. Signed in, it shows the account with Manage account, which
 * opens the Account dialog, and Sign out. Signed out, it offers Sign in and Create an account,
 * which open Clerk's pages in the browser.
 */
export function ProfileButton({
  listed,
  onOpenSettings,
  onOpenPage,
}: {
  listed: HostThreads[];
  onOpenSettings: (section: SettingsSection) => void;
  /** Inbox's Pull requests, Issues, and Usage rows, which Traditional lists in its head. */
  onOpenPage?: (page: NavRow) => void;
}) {
  const id = useId();
  const settingsKeys = useShortcutLabel("settings");
  const modHeld = useModHeld();
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
    setNote(t("Finish signing in in your browser."));
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
      {profile ? (
        <button
          type="button"
          popoverTarget={id}
          aria-haspopup="menu"
          className="flex h-7 min-w-0 items-center gap-2 rounded-md pr-2 pl-[3px] text-body font-medium text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
        >
          <Avatar profile={profile} size={22} />
          <span className="truncate">{profile.name || profile.email}</span>
        </button>
      ) : (
        <IconButton label={t("Profile")} popoverTarget={id} aria-haspopup="menu">
          <CircleUser />
        </IconButton>
      )}
      <Menu ref={menu} id={id} label={t("Account")} className="w-64 p-1">
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
                <p className="truncate text-body font-medium">
                  {profile ? profile.name || profile.email : t("Sign in to Parallax")}
                </p>
                {(profile?.name || !profile) && (
                  <p role="status" className="truncate text-meta text-muted-foreground">
                    {profile ? profile.email : (note ?? t("With GitHub, Google, Apple, or email."))}
                  </p>
                )}
              </div>
            </div>
            <div role="separator" className="my-1 h-px bg-border" />
          </>
        )}
        {onOpenPage && (
          <>
            {item(
              GitPullRequest,
              t("Pull requests"),
              closing(() => onOpenPage("pullRequests")),
            )}
            {item(
              icons.issue,
              t("Issues"),
              closing(() => onOpenPage("issues")),
            )}
            {item(
              ChartNoAxesColumn,
              t("Usage"),
              closing(() => onOpenPage("usage")),
            )}
          </>
        )}
        <button
          type="button"
          role="menuitem"
          onClick={closing(() => onOpenSettings("general"))}
          className={menuItem}
        >
          <Settings aria-hidden className="text-muted-foreground" />
          {t("Settings")}
          {modHeld && settingsKeys && (
            <span className="ml-auto text-meta text-faint-foreground">{settingsKeys}</span>
          )}
        </button>
        {profile !== undefined && (
          <>
            {profile ? (
              <>
                {item(
                  UserCog,
                  t("Manage account"),
                  closing(() => setManaging(true)),
                )}
                {item(
                  LogOut,
                  t("Sign out"),
                  closing(() => void window.parallax.signOut()),
                )}
              </>
            ) : (
              <>
                {item(LogIn, t("Sign in"), () => void signIn(false))}
                {item(UserPlus, t("Create an account"), () => void signIn(true))}
              </>
            )}
          </>
        )}
        <div role="separator" className="my-1 h-px bg-border" />
        <div className="flex items-center justify-between px-2 py-1">
          <span className="flex items-center gap-1.5 font-brand text-meta font-semibold text-faint-foreground">
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
