// Sign-in with Clerk (PLX-702), off unless the build sets EXPO_PUBLIC_CLERK=1. Pairing doesn't
// need it; the relay (PLX-652) will. Clerk's native views ask for whatever the Clerk app requires
// and manage the account, deleting it included, as the App Store requires of an app that makes one.
import { ClerkProvider, useAuth } from "@clerk/expo";
import { AuthView, UserProfileView } from "@clerk/expo/native";
import { tokenCache } from "@clerk/expo/token-cache";
import { useEffect, useState, type ReactNode } from "react";
import { Modal } from "react-native";

import { Button } from "./ui";

export const CLERK = process.env.EXPO_PUBLIC_CLERK === "1";
/** The development instance's publishable key, which is public. */
const PUBLISHABLE_KEY = "pk_test_YWRqdXN0ZWQtbWFzdG9kb24tODcwNS5jbGVyay5hY2NvdW50cy5kZXYk";

export function AccountProvider({ children }: { children: ReactNode }) {
  if (!CLERK) return children;
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY} tokenCache={tokenCache}>
      {children}
    </ClerkProvider>
  );
}

export function Account() {
  const { isSignedIn } = useAuth();
  const [open, setOpen] = useState(false);
  // Signing in or out finishes the sheet.
  useEffect(() => setOpen(false), [isSignedIn]);
  const close = () => setOpen(false);
  return (
    <>
      <Button label={isSignedIn ? "Manage account" : "Sign in"} onPress={() => setOpen(true)} />
      <Modal
        visible={open}
        presentationStyle="pageSheet"
        animationType="slide"
        onRequestClose={close}
      >
        {isSignedIn ? (
          <UserProfileView style={{ flex: 1 }} onDismiss={close} />
        ) : (
          <AuthView mode="signInOrUp" onDismiss={close} />
        )}
      </Modal>
    </>
  );
}
