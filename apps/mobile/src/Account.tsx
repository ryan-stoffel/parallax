// Sign-in with Clerk (PLX-702, 0067), which App.tsx bundles only when the build sets
// EXPO_PUBLIC_CLERK=1. Pairing doesn't need it; the relay (PLX-652) will. Clerk's JS only:
// package.json keeps its native module and UI out of the build, which would add about 23 MB.
// The Clerk app asks for an email and a password, and a sign-up for a first and last name and
// the code Clerk emails. Deleting the account is here because the App Store requires it of an
// app that makes one.
import { ClerkProvider, useClerk, useSignIn, useSignUp, useUser } from "@clerk/expo";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, Modal, Pressable, StyleSheet, TextInput, View } from "react-native";

import { keychain } from "./host";
import { font } from "./theme";
import { Button, T, useColors } from "./ui";

/** The development instance's publishable key, which is public (desktop: main/account.ts). */
const PUBLISHABLE_KEY = "pk_test_YWRqdXN0ZWQtbWFzdG9kb24tODcwNS5jbGVyay5hY2NvdW50cy5kZXYk";

/** Clerk's client token, in the Keychain on this phone only, as host.ts keeps plxd's. */
const tokenCache = {
  getToken: (key: string) => SecureStore.getItemAsync(key, keychain),
  saveToken: (key: string, token: string) => SecureStore.setItemAsync(key, token, keychain),
  clearToken: (key: string) => SecureStore.deleteItemAsync(key, keychain),
};

export function AccountProvider({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY} tokenCache={tokenCache}>
      {children}
    </ClerkProvider>
  );
}

type Step = "signIn" | "signUp" | "verify";
type Answer = Promise<{ error: { message: string } | null }>;

export function Account() {
  const c = useColors();
  const { user } = useUser();
  const { signOut } = useClerk();
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("signIn");
  const [form, setForm] = useState({ first: "", last: "", email: "", password: "", code: "" });
  const [busy, setBusy] = useState(false);
  // Signing in or up finishes the sheet, and a sign-out or deletion starts it over.
  const signedIn = !!user;
  useEffect(() => {
    setOpen(false);
    setStep("signIn");
  }, [signedIn]);
  const [error, setError] = useState<string>();

  /** Runs Clerk's steps in order, stopping at the first error, which it shows. */
  async function run(...steps: (() => Answer)[]) {
    setBusy(true);
    setError(undefined);
    try {
      for (const step of steps) {
        const { error } = await step();
        if (error) return setError(error.message);
      }
      return true;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const input = [styles.input, { color: c.foreground, borderColor: c.border }];
  const field = (key: keyof typeof form, label: string, secure = false) => (
    <TextInput
      key={key}
      accessibilityLabel={label}
      placeholder={label}
      placeholderTextColor={c.faintForeground}
      onChangeText={(value) => setForm((f) => ({ ...f, [key]: value }))}
      autoCapitalize={key === "first" || key === "last" ? "words" : "none"}
      autoCorrect={false}
      secureTextEntry={secure}
      keyboardType={key === "email" ? "email-address" : key === "code" ? "number-pad" : "default"}
      textContentType={key === "code" ? "oneTimeCode" : key === "password" ? "password" : undefined}
      style={input}
    />
  );

  if (user)
    return (
      <View style={styles.box}>
        <T>Signed in as {user.primaryEmailAddress?.emailAddress}</T>
        <View style={styles.row}>
          <Button label="Sign out" onPress={() => void signOut()} />
          <Button
            label="Delete account"
            onPress={() =>
              Alert.alert("Delete your Parallax account?", "This can't be undone.", [
                { text: "Cancel", style: "cancel" },
                { text: "Delete", style: "destructive", onPress: () => void user.delete() },
              ])
            }
          />
        </View>
      </View>
    );

  const { first, last, email, password, code } = form;
  // Closing starts over, rather than reopening on a code that may have expired.
  const close = () => {
    setOpen(false);
    setStep("signIn");
  };
  return (
    <>
      <Button label="Sign in" onPress={() => setOpen(true)} />
      <Modal
        visible={open}
        presentationStyle="pageSheet"
        animationType="slide"
        onRequestClose={close}
      >
        <View style={[styles.sheet, { backgroundColor: c.background }]}>
          <View style={styles.row}>
            <T medium style={{ fontSize: 20, flex: 1 }}>
              Parallax account
            </T>
            <Pressable accessibilityRole="button" onPress={close} hitSlop={12}>
              <T style={{ color: c.accent }}>Close</T>
            </Pressable>
          </View>
          {step === "signUp" && field("first", "First name")}
          {step === "signUp" && field("last", "Last name")}
          {step !== "verify" && field("email", "Email")}
          {step !== "verify" && field("password", "Password", true)}
          {step === "verify" && (
            <>
              <T muted>Enter the code Clerk sent to {email}.</T>
              {field("code", "Code")}
            </>
          )}
          {step === "signIn" && (
            <Button
              label="Continue"
              primary
              disabled={busy}
              onPress={() =>
                void run(
                  () => signIn.password({ identifier: email.trim(), password }),
                  () => signIn.finalize(),
                )
              }
            />
          )}
          {step === "signUp" && (
            <Button
              label="Create account"
              primary
              disabled={busy}
              onPress={() =>
                void run(
                  () =>
                    signUp.create({
                      emailAddress: email.trim(),
                      password,
                      firstName: first.trim(),
                      lastName: last.trim(),
                    }),
                  () => signUp.verifications.sendEmailCode(),
                ).then((ok) => ok && setStep("verify"))
              }
            />
          )}
          {step === "verify" && (
            <Button
              label="Verify"
              primary
              disabled={busy}
              onPress={() =>
                void run(
                  () => signUp.verifications.verifyEmailCode({ code: code.trim() }),
                  () => signUp.finalize(),
                )
              }
            />
          )}
          {step !== "verify" && (
            <Pressable
              accessibilityRole="button"
              onPress={() => setStep(step === "signIn" ? "signUp" : "signIn")}
            >
              <T style={{ fontSize: 14, color: c.accent }}>
                {step === "signIn" ? "Create an account" : "I have an account"}
              </T>
            </Pressable>
          )}
          {error && (
            <T alert style={{ color: c.danger, fontSize: 13 }}>
              {error}
            </T>
          )}
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  box: { gap: 10 },
  sheet: { flex: 1, padding: 24, gap: 10 },
  row: { flexDirection: "row", gap: 8 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontFamily: font.regular,
    fontSize: 16,
  },
});
