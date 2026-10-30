// The dialogs of approving devices and computers for account sign-in (0091): iOS's own alerts.

import { Alert } from "react-native";

import type { AccountHosts } from "./accountHosts";

/** A 6-digit code as both ends show it: `482 915`. */
export const formatCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/**
 * A new computer's code dialog: the code `plx connect` shows on `name`, typed here, or, with
 * `onAsk`, approving this phone from a device that already uses it.
 */
export function askSetupCode(name: string, onCode: (code: string) => void, onAsk: () => void) {
  Alert.prompt(
    `Set up ${name}`,
    "Type the 6-digit code that plx connect shows on it.",
    [
      { text: "Cancel", style: "cancel" },
      { text: "Approve from Another Device", onPress: onAsk },
      { text: "Set Up", isPreferred: true, onPress: (code?: string) => onCode((code ?? "").replace(/\D/g, "")) },
    ],
    "plain-text",
    "",
    "number-pad",
  );
}

/**
 * Sets up the account computer `hostId`, named `name`, from the code dialog: with the code typed,
 * or by asking a device that already uses it, which waits there with `onWaiting`'s code. Calls
 * `done` once this phone may use it, or `failed` with a message for people.
 */
export function setUpComputer(
  accounts: AccountHosts,
  { hostId, name, routes }: { hostId: string; name: string; routes: string[] },
  handlers: { onWaiting: (code: string) => void; done: () => void; failed: (message: string) => void },
) {
  const failed = (e: unknown) => {
    Alert.alert(`Couldn't set up ${name}`, (e as Error).message);
    handlers.failed((e as Error).message);
  };
  askSetupCode(
    name,
    (code) => {
      if (code.length !== 6) return failed(new Error("The code has 6 digits."));
      accounts.setup(hostId, routes, code).then(handlers.done, failed);
    },
    () =>
      void accounts
        .ask(hostId, routes, (code) => {
          handlers.onWaiting(code);
          showWaiting(name, code);
        })
        .then(handlers.done, failed),
  );
}

/** This phone's own request to use `name`, waiting on another device that shows `code`. */
export function showWaiting(name: string, code: string) {
  Alert.alert(
    "Approve this phone",
    `On a computer or phone that already uses ${name}, allow this iPhone. Both show ${formatCode(code)}.`,
  );
}

/** Another device asks to use the user's computers: "Allow <device>? <code>". */
export function confirmDevice(device: string, code: string, onAllow: () => void, onDeny: () => void) {
  Alert.alert(
    `Allow ${device}?`,
    `${formatCode(code)}\n\nAllow it only if ${device} shows the same code. It gets full control of your computers.`,
    [
      { text: "Deny", style: "destructive", onPress: onDeny },
      { text: "Allow", isPreferred: true, onPress: onAllow },
    ],
  );
}
