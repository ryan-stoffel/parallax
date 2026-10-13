import { CircleUser, LogIn, LogOut, Settings, UserPlus, X, type LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { Profile } from "../preload/bridge";
import { ParallaxMark } from "./logos";
import { Avatar, useProfile } from "./profile";
import { IconButton } from "./ui";

/** The Parallax mark and name, at the foot of the menu and the Account dialog. */
function Brand() {
  return (
    <span className="flex items-center justify-center gap-1.5 font-brand text-[12.5px] font-semibold text-muted-foreground">
      <ParallaxMark className="size-4" />
      Parallax
    </span>
  );
}

function MenuRow({
  Icon,
  label,
  onClick,
}: {
  Icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 border-t border-border px-4 py-2.5 text-left text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4"
    >
      <Icon aria-hidden />
      {label}
    </button>
  );
}

/**
 * The sidebar footer's Profile button (0067): the account's picture or initials, which opens a
 * menu above it. Signed in, the menu shows the account with Manage account, which opens the
 * Account dialog, and Sign out. Signed out, it offers Sign in and Create an account, which open
 * Clerk's pages in the browser.
 */
export function ProfileButton() {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const profile = useProfile();
  const [managing, setManaging] = useState(false);

  // Sign in's answer. Only the latest sign-in's shows: a replaced one answers "cancelled" late.
  const [note, setNote] = useState<string>();
  const latest = useRef(0);
  const signIn = async (create: boolean) => {
    const n = ++latest.current;
    setNote("Finish signing in in your browser.");
    const answer = await window.parallax.signIn(create);
    if (n === latest.current) setNote(answer);
  };
  const act = (run: () => void) => () => {
    menu.current?.hidePopover();
    run();
  };

  return (
    <>
      <IconButton
        label={profile ? profile.name || profile.email : "Profile"}
        popoverTarget={id}
        aria-haspopup="dialog"
      >
        {profile ? <Avatar profile={profile} size={22} /> : <CircleUser />}
      </IconButton>
      <div
        ref={menu}
        id={id}
        popover="auto"
        aria-label="Account"
        className="inset-auto m-0 mb-2 w-72 overflow-hidden rounded-xl border border-border bg-surface text-foreground shadow-composer [position-area:top_span-right] [position-try-fallbacks:flip-block]"
      >
        <div className="flex items-center gap-3 px-4 py-3.5">
          {profile ? (
            <Avatar profile={profile} size={36} />
          ) : (
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-selected text-muted-foreground [&_svg]:size-5">
              <CircleUser aria-hidden />
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate text-[13.5px] font-medium">
              {profile ? profile.name || profile.email : "Sign in to Parallax"}
            </p>
            {(profile?.name || profile === null) && (
              <p role="status" className="truncate text-[12.5px] text-muted-foreground">
                {profile ? profile.email : (note ?? "With GitHub, Google, Apple, or email.")}
              </p>
            )}
          </div>
        </div>
        {profile ? (
          <>
            <MenuRow
              Icon={Settings}
              label="Manage account"
              onClick={act(() => setManaging(true))}
            />
            <MenuRow
              Icon={LogOut}
              label="Sign out"
              onClick={act(() => void window.parallax.signOut())}
            />
          </>
        ) : (
          profile === null && (
            <>
              <MenuRow Icon={LogIn} label="Sign in" onClick={() => void signIn(false)} />
              <MenuRow
                Icon={UserPlus}
                label="Create an account"
                onClick={() => void signIn(true)}
              />
            </>
          )
        )}
        <div className="border-t border-border bg-background/40 py-2.5">
          <Brand />
        </div>
      </div>
      {managing && profile && (
        <AccountDialog profile={profile} onClose={() => setManaging(false)} />
      )}
    </>
  );
}

/** One of Profile details' rows: its name on the left, then what it holds. */
function DetailRow({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] items-center gap-4 border-t border-border py-4">
      <span className="text-[13px] font-medium">{name}</span>
      <div className="flex min-w-0 items-center gap-3">{children}</div>
    </div>
  );
}

/**
 * The Account dialog, a native modal <dialog> open while it's mounted: the account's picture and
 * name, which Update profile changes on Clerk's account page in the browser (0067), and its email.
 */
function AccountDialog({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => dialog.current?.showModal(), []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto h-[32rem] max-h-[85vh] w-[50rem] max-w-[90vw] overflow-hidden rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
    >
      <div className="grid h-full grid-cols-[14rem_1fr]">
        <aside className="flex flex-col border-r border-border bg-background/40 p-4">
          <h2 id={titleId} className="px-2 font-brand text-xl font-semibold">
            Account
          </h2>
          <p className="mt-0.5 px-2 text-[12.5px] text-muted-foreground">
            Manage your account info.
          </p>
          <nav className="mt-5">
            <span
              aria-current="page"
              className="flex items-center gap-2.5 rounded-md bg-selected px-2 py-1.5 text-[13px] text-foreground [&_svg]:size-4"
            >
              <CircleUser aria-hidden />
              Profile
            </span>
          </nav>
          <div className="mt-auto">
            <Brand />
          </div>
        </aside>
        <section className="min-w-0 px-7 pt-5">
          <div className="flex items-center justify-between pb-4">
            <h3 className="text-[15px] font-semibold">Profile details</h3>
            <IconButton label="Close" onClick={() => dialog.current?.close()}>
              <X aria-hidden />
            </IconButton>
          </div>
          <DetailRow name="Profile">
            <Avatar profile={profile} size={44} />
            <span className="min-w-0 flex-1 truncate text-[13.5px]">
              {profile.name || profile.email}
            </span>
            <button
              type="button"
              onClick={() => void window.parallax.editProfile()}
              className="shrink-0 text-[13px] font-medium text-accent hover:underline"
            >
              Update profile
            </button>
          </DetailRow>
          <DetailRow name="Email address">
            <span className="truncate text-[13px]">{profile.email}</span>
            <span className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[11.5px] text-muted-foreground">
              Primary
            </span>
          </DetailRow>
        </section>
      </div>
    </dialog>
  );
}
