import { useEffect, useId, useRef } from "react";

import type { GoogleAccount } from "../preload/bridge";
import { memory } from "./stored";
import { AccountCircle, Logout, ManageAccounts, PersonAdd } from "./symbols";
import { IconButton, Menu, toolbarButton, toolbarMenuDivider, ToolbarMenuRow } from "./ui";

// The Google account signed in to the browser (googleAccount.ts in main), shared by every toolbar.
const account = memory<GoogleAccount | undefined>(undefined);
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  void window.parallax.googleAccount().then((a) => account.set(a));
  window.parallax.onGoogleAccount((a) => account.set(a));
}

// Google's own pages for each item, which open in a new tab.
const google = {
  signIn: "https://accounts.google.com/ServiceLogin?continue=https://myaccount.google.com/",
  manage: "https://myaccount.google.com/",
  add: "https://accounts.google.com/AddSession",
  signOut: "https://accounts.google.com/Logout",
};

/** A Google account's picture, or the first letter of its name without one. */
function Avatar({ of, className }: { of: GoogleAccount; className: string }) {
  return of.picture ? (
    <img src={of.picture} alt="" className={`rounded-full object-cover ${className}`} />
  ) : (
    <span
      aria-hidden
      className={`grid place-items-center rounded-full bg-accent font-medium text-accent-foreground ${className}`}
    >
      {of.name.charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * The toolbar's profile button, as Helium's (PLX-981): the signed-in Google account's picture, and
 * a menu with its picture, name, and email over managing it, adding another account, and signing
 * out, or signing in while there's none. Each opens Google's page for it with `onOpen`, in a new
 * tab; the button follows as the session signs in or out.
 */
export function ProfileButton({ onOpen }: { onOpen: (url: string) => void }) {
  const signedIn = account.use();
  useEffect(listen, []);
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const go = (url: string) => () => {
    menu.current?.hidePopover();
    onOpen(url);
  };
  return (
    <>
      <IconButton
        label={signedIn ? `Google account: ${signedIn.email}` : "Profile"}
        className={toolbarButton}
        popoverTarget={id}
        aria-haspopup="menu"
      >
        {signedIn ? <Avatar of={signedIn} className="size-6 text-[12px]" /> : <AccountCircle />}
      </IconButton>
      <Menu ref={menu} id={id} label="Profile" align="end" className="w-72 p-1.5">
        <div className="mb-1 flex flex-col items-center gap-1 rounded-lg bg-selected px-3 pt-5 pb-4 text-center">
          {signedIn ? (
            <Avatar of={signedIn} className="mb-1.5 size-14 text-[22px]" />
          ) : (
            <span className="mb-1.5 grid size-14 place-items-center rounded-full bg-background text-muted-foreground">
              <AccountCircle aria-hidden className="size-8" />
            </span>
          )}
          <p className="max-w-full truncate text-[14px] font-medium">
            {signedIn ? signedIn.name : "You"}
          </p>
          <p className="max-w-full truncate text-[12.5px] text-muted-foreground">
            {signedIn ? signedIn.email : "Not signed in to Google"}
          </p>
        </div>
        {signedIn ? (
          <>
            <ToolbarMenuRow
              icon={<ManageAccounts aria-hidden />}
              label="Manage your Google Account"
              onClick={go(google.manage)}
            />
            <hr className={toolbarMenuDivider} />
            <ToolbarMenuRow
              icon={<PersonAdd aria-hidden />}
              label="Add another account"
              onClick={go(google.add)}
            />
            <ToolbarMenuRow
              icon={<Logout aria-hidden />}
              label="Sign out of Google"
              onClick={go(google.signOut)}
            />
          </>
        ) : (
          <ToolbarMenuRow
            icon={<PersonAdd aria-hidden />}
            label="Sign in to Google"
            onClick={go(google.signIn)}
          />
        )}
      </Menu>
    </>
  );
}
