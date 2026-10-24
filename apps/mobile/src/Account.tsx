// The Parallax account (0067), signed in as the desktop app signs in: the app is an OAuth client
// of Clerk, with PKCE. Clerk's hosted page does the rest (GitHub, Google, Apple, email, sign-up,
// and consent) in a sheet that shares Safari's cookies, and sends it back to `REDIRECT`, which
// the sheet hands to the app (modules/pinned-tls). A loopback redirect, as the desktop's, would
// load a plain-HTTP page, which iOS 27 warns about. The refresh token and the last userinfo stay in the
// Keychain on this phone only; the access token, a JWT good for a day, stays in memory. The
// account's name, password, and deletion are on Clerk's account pages, since an OAuth token
// can't change the user.
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import * as SecureStore from "expo-secure-store";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Alert, Image, Linking, Pressable, StyleSheet, Text, View } from "react-native";

import { authorize } from "../modules/pinned-tls";
import { keychain } from "./host";
import { base64url } from "./pairing";
import { LockKeyhole, LogOut, UserRound } from "lucide-react-native";

import { initials } from "../../desktop/src/renderer/attention";

import { font } from "./theme";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button, Icon, Mark, Row, Section, SkyBanner, T, useColors } from "./ui";

// The Clerk instance and the desktop app's OAuth application there, both public (desktop:
// main/account.ts). The phone signs in as the same application.
const PUBLISHABLE_KEY = "pk_test_YWRqdXN0ZWQtbWFzdG9kb24tODcwNS5jbGVyay5hY2NvdW50cy5kZXYk";
const CLIENT_ID = "SXDueyOLOJ2v4Vmq";
const SCOPES = "profile email offline_access";
const KEY = "account";
/** Where Clerk sends the sign-in back: one of the OAuth application's redirect URIs. */
const REDIRECT = "parallax://oauth/callback";

/** The Frontend API a publishable key names: base64 of `<host>$` after `pk_test_` or `pk_live_`. */
const API = `https://${atob(PUBLISHABLE_KEY.replace(/^pk_(test|live)_/, "")).replace(/\$$/, "")}`;
/** Clerk's Account Portal beside it: `<slug>.accounts.dev`, or `accounts.<domain>`. */
const PORTAL = API.replace("://clerk.", "://accounts.").replace(/\.clerk\.accounts\.dev$/, ".accounts.dev");

/** What Clerk's userinfo says of the user, as much as the app shows. */
export interface User {
  email?: string;
  given_name?: string;
  family_name?: string;
  /** The profile picture's URL, from the sign-in provider. */
  picture?: string;
}

interface Session {
  refreshToken: string;
  user: User;
}

/** A failed call to Clerk. `revoked` when Clerk refused the refresh token itself. */
class ClerkError extends Error {
  constructor(
    message: string,
    readonly revoked = false,
  ) {
    super(message);
  }
}

async function token(params: Record<string, string>) {
  const res = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body["access_token"] !== "string") {
    const why = [body["error_description"], body["error"]].find((v) => typeof v === "string");
    throw new ClerkError(String(why ?? `Clerk answered ${res.status}.`), body["error"] === "invalid_grant");
  }
  const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : 3600;
  return {
    access: { token: body["access_token"], expiresAt: Date.now() + expiresIn * 1000 },
    refreshToken: typeof body["refresh_token"] === "string" ? body["refresh_token"] : undefined,
  };
}

async function userinfo(bearer: string): Promise<User> {
  const res = await fetch(`${API}/oauth/userinfo`, { headers: { Authorization: `Bearer ${bearer}` } });
  if (!res.ok) throw new ClerkError(`Clerk answered ${res.status}.`);
  const { email, given_name, family_name, picture } = (await res.json()) as User;
  return { email, given_name, family_name, picture };
}

interface AccountValue {
  /** Undefined while the Keychain is read, null signed out. */
  user: User | null | undefined;
  signIn: (create: boolean) => Promise<string | undefined>;
  signOut: () => Promise<void>;
  /** A current access token, for Parallax Relay, or undefined signed out. */
  accessToken: () => Promise<string | undefined>;
}

const AccountContext = createContext<AccountValue | null>(null);
export const useAccount = () => useContext(AccountContext)!;

export function AccountProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>();
  const [access, setAccess] = useState<{ token: string; expiresAt: number }>();

  const save = async (next: Session | null) => {
    setSession(next);
    if (next) await SecureStore.setItemAsync(KEY, JSON.stringify(next), keychain);
    else await SecureStore.deleteItemAsync(KEY, keychain);
  };

  useEffect(() => {
    void SecureStore.getItemAsync(KEY, keychain).then(
      (raw) => setSession(raw ? (JSON.parse(raw) as Session) : null),
      () => setSession(null),
    );
  }, []);

  const value: AccountValue = {
    user: session === undefined ? undefined : (session?.user ?? null),

    async signIn(create) {
      const verifier = base64url(randomBytes(32));
      const state = base64url(randomBytes(16));
      const params = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        scope: SCOPES,
        state,
        code_challenge: base64url(sha256(utf8ToBytes(verifier))),
        code_challenge_method: "S256",
      });
      const page = `${API}/oauth/authorize?${params.toString()}`;
      // Create an account starts on Clerk's sign-up page, which then continues the same sign-in.
      const url = create ? `${PORTAL}/sign-up?redirect_url=${encodeURIComponent(page)}` : page;
      let callback: string;
      try {
        callback = await authorize(url);
      } catch (e) {
        return (e as { code?: string }).code === "ERR_CANCELED" ? undefined : (e as Error).message;
      }
      // React Native's URL has no searchParams.
      const query = callback.split("?")[1] ?? "";
      const answer = new Map(
        query.split("&").map((pair) => pair.split("=").map((p) => decodeURIComponent(p.replaceAll("+", " "))) as [string, string]),
      );
      const code = answer.get("code");
      if (answer.get("state") !== state || !code)
        return answer.get("error_description") ?? "Sign-in didn't finish. Try again.";
      try {
        const fresh = await token({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT,
        });
        if (!fresh.refreshToken) return "Clerk sent no refresh token.";
        const user = await userinfo(fresh.access.token);
        setAccess(fresh.access);
        await save({ refreshToken: fresh.refreshToken, user });
        return undefined;
      } catch (e) {
        return (e as Error).message;
      }
    },

    async signOut() {
      const held = session;
      setAccess(undefined);
      await save(null);
      // Revokes this phone's refresh token only: other devices stay signed in.
      if (held)
        await fetch(`${API}/oauth/token/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: CLIENT_ID, token: held.refreshToken }).toString(),
        }).catch(() => undefined);
    },

    async accessToken() {
      if (access && access.expiresAt - 60_000 > Date.now()) return access.token;
      if (!session) return undefined;
      try {
        const fresh = await token({ grant_type: "refresh_token", refresh_token: session.refreshToken });
        setAccess(fresh.access);
        // Each refresh also refreshes the profile, so a sign-in from before the picture gets it.
        const user = await userinfo(fresh.access.token).catch(() => session.user);
        await save({ user, refreshToken: fresh.refreshToken ?? session.refreshToken });
        return fresh.access.token;
      } catch (e) {
        // Revoked, such as by signing out everywhere: signed out here too.
        if (e instanceof ClerkError && e.revoked) await save(null);
        return undefined;
      }
    },
  };
  return <AccountContext value={value}>{children}</AccountContext>;
}

export function SignIn() {
  const c = useColors();
  const { signIn } = useAccount();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const go = async (create: boolean) => {
    setBusy(true);
    setError(undefined);
    setError(await signIn(create));
    setBusy(false);
  };
  return (
    <View style={[styles.page, { backgroundColor: c.background }]}>
      <SkyBanner bar={insets.top + 64} solid={insets.top + 64} fade={180} />
      <View style={{ flex: 1, justifyContent: "center", gap: 14 }}>
        <Mark size={56} />
        <Text style={{ fontFamily: font.brand, fontSize: 34, color: c.foreground, marginTop: 10 }}>
          Parallax
        </Text>
        <T muted style={{ fontSize: 17, lineHeight: 25 }}>
          Every thread on every one of your computers, from your phone.
        </T>
      </View>
      <View style={{ gap: 12 }}>
        <Button
          label={busy ? "Signing in…" : "Sign in"}
          primary
          disabled={busy}
          onPress={() => void go(false)}
        />
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void go(true)}
          style={{ alignSelf: "center", padding: 10 }}
        >
          <T style={{ fontSize: 15, color: c.accent }}>Create an account</T>
        </Pressable>
        {error && (
          <T alert style={{ color: c.danger, fontSize: 14, textAlign: "center" }}>
            {error}
          </T>
        )}
      </View>
    </View>
  );
}

/** The user's full name, or undefined when Clerk has none. */
export const nameOf = (user: User | null | undefined) =>
  [user?.given_name, user?.family_name].filter(Boolean).join(" ") || undefined;

/**
 * The signed-in user's profile picture, as round as iOS draws one: their picture, else their
 * initials, else (signed out, as the development shortcut is) a person.
 */
export function Avatar({ size = 36 }: { size?: number }) {
  const c = useColors();
  const { user } = useAccount();
  const name = nameOf(user);
  const shape = { width: size, height: size, borderRadius: size / 2 };
  if (user?.picture) return <Image source={{ uri: user.picture }} style={[shape, { backgroundColor: c.selected }]} />;
  return (
    <View style={[shape, { alignItems: "center", justifyContent: "center", backgroundColor: name ? c.accent : c.selected }]}>
      {name ? (
        <T style={{ color: "#ffffff", fontSize: size * 0.38, fontWeight: "600" }}>{initials(name)}</T>
      ) : (
        <Icon icon={UserRound} size={size * 0.5} color={c.mutedForeground} />
      )}
    </View>
  );
}

/** Settings' account section: who's signed in, their account page, and Sign out. */
export function AccountSection() {
  const { user, signOut } = useAccount();
  const name = nameOf(user);
  return (
    <Section title="Parallax account">
      <Row
        icon={UserRound}
        title={name || "Signed in"}
        detail={user?.email}
        chevron
        onPress={() => void Linking.openURL(`${PORTAL}/user`)}
      />
      <Row
        icon={LockKeyhole}
        title="Security and account deletion"
        chevron
        onPress={() => void Linking.openURL(`${PORTAL}/user/security`)}
      />
      <Row
        icon={LogOut}
        title="Sign out"
        destructive
        last
        onPress={() =>
          Alert.alert("Sign out of Parallax?", "Your computers stay on this phone.", [
            { text: "Cancel", style: "cancel" },
            { text: "Sign out", style: "destructive", onPress: () => void signOut() },
          ])
        }
      />
    </Section>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 28, paddingTop: 80, paddingBottom: 56 },
});
