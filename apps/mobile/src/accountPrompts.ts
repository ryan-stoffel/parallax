// The dialogs of approving devices and computers for account sign-in (0091): iOS's own alerts.

import { t } from "i18next";
import {  } from "react-native";

import type { RouteChoices } from "../../desktop/src/preload/routeList";
import { Limited } from "./access";
import { Denied, type AccountHosts, type Listed } from "./accountHosts";
import { showAlert, showPrompt } from "./dialogStore";
import { PHONE } from "./phone";
import { askEach, type Asked } from "./setup";

/** A 6-digit code as both ends show it: `482 915`. */
export const formatCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/**
 * A new computer's code dialog: the code `name` shows, in its Settings or `plx connect`, typed here, or, with
 * `onAsk`, a code to compare with that computer or with a device that already uses it.
 */
export function askSetupCode(name: string, onCode: (code: string) => void, onAsk?: () => void) {
  showPrompt(
    t("Set up {{name}}", { name }),
    t("Type the 6-digit code from Show setup code in its Settings > Connections, or from plx connect."),
    [
      { text: t("Cancel"), style: "cancel" },
      ...(onAsk ? [{ text: t("Compare Codes Instead"), onPress: onAsk }] : []),
      { text: t("Set Up"), onPress: (code?: string) => onCode((code ?? "").replace(/\D/g, "")) },
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
  { hostId, name, choices }: { hostId: string; name: string; choices: RouteChoices },
  handlers: { onWaiting: (code: string) => void; done: () => void; failed: (message: string) => void },
) {
  const failed = (e: unknown) => {
    showAlert(t("Couldn't set up {{name}}", { name }), (e as Error).message);
    handlers.failed((e as Error).message);
  };
  askSetupCode(
    name,
    (code) => {
      if (code.length !== 6) return failed(new Error(t("The code has 6 digits.")));
      accounts.setup(hostId, choices, code).then(handlers.done, failed);
    },
    () =>
      void accounts
        .compare(
          hostId,
          choices,
          (code) => {
            handlers.onWaiting(code);
            return askToAllow(name, code);
          },
          () => showConfirm(name),
        )
        .then(handlers.done, failed),
  );
}

/** A new computer's code to compare: resolves to whether the user allowed it. */
export function askToAllow(name: string, code: string): Promise<boolean> {
  return new Promise((resolve) =>
    showAlert(
      t("Add {{name}}?", { name }),
      `${formatCode(code)}\n\n${t("Allow it only if {{name}} shows this code. Another code, or none, means something else is answering.", { name })}`,
      [
        { text: t("Deny"), style: "destructive", onPress: () => resolve(false) },
        { text: t("Allow"), onPress: () => resolve(true) },
      ],
    ),
  );
}

/**
 * Sets up a computer no other device uses yet, with the code its `plx connect` shows: asks which
 * of `computers` that is first, if there's more than one. `started` and `ended` bracket the run,
 * and `done` follows once this phone may use it.
 */
export function enterSetupCode(
  accounts: AccountHosts,
  computers: Listed[],
  handlers: { started: () => void; ended: () => void; done: (hostId: string) => void },
) {
  const enter = ({ hostId, name }: Listed) =>
    askSetupCode(name, (code) => {
      const failed = (e: unknown) => {
        handlers.ended();
        showAlert(t("Couldn't set up {{name}}", { name }), (e as Error).message);
      };
      if (code.length !== 6) return showAlert(t("Couldn't set up {{name}}", { name }), t("The code has 6 digits."));
      handlers.started();
      accounts.setup(hostId, { routes: [] }, code).then(() => {
        handlers.ended();
        handlers.done(hostId);
      }, failed);
    });
  if (computers.length === 1) return enter(computers[0]!);
  showAlert(t("Which computer shows the code?"), undefined, [
    ...computers.map((computer) => ({ text: computer.name, onPress: () => enter(computer) })),
    { text: t("Cancel"), style: "cancel" as const },
  ]);
}

/**
 * A new phone asks to use the account's computers on its own (0091): `hosts` in turn until one
 * lets it in on another device, which `onWaiting`'s code matches. One Allow covers them all, as
 * that device copies this phone's key to the rest. While one can still be holding its request, it
 * stays with that one, so a lost connection doesn't start another. Past that, a computer that won't
 * answer is passed over. A denied or lapsed request, or a limit, stops it until the user asks again.
 */
export async function allowThisPhone(
  accounts: AccountHosts,
  hosts: Listed[],
  onWaiting: (hostId: string, code: string, allow: () => void) => void,
): Promise<Asked> {
  const asked = (host: Listed) => accounts.asked(host.hostId);
  const askable = accounts.askable(hosts);
  return askEach(
    [...askable.filter(asked), ...askable.filter((host) => !asked(host))],
    (host) =>
      accounts.ask(
        host.hostId,
        { routes: [] },
        (code, allow) => onWaiting(host.hostId, code, allow),
        () => showConfirm(host.name),
      ),
    // A phone that got in another way, as with a typed code, has no more to ask.
    (error, host) =>
      error instanceof Denied || error instanceof Limited || accounts.waiting(host.hostId) || accounts.usesAny,
    (error) => {
      if (accounts.usesAny) return;
      if (error instanceof Denied || error instanceof Limited) void accounts.stopAsking(error.message);
    },
  );
}

/**
 * This phone's own request to use `name`, waiting on another device that shows `code`, or on
 * `name` itself while it's being set up, where `onAllow` takes the user's word that it shows the
 * same.
 */
export function showWaiting(name: string, code: string, onAllow: () => void) {
  showAlert(
    t("Approve this phone"),
    `${formatCode(code)}\n\n${t("On a computer or phone that already uses {{name}}, allow this {{phone}}. If you're setting up {{name}} and it shows this code, tap Allow.", { name, phone: PHONE })}`,
    [
      { text: t("Not Now"), style: "cancel" },
      { text: t("Allow"), onPress: onAllow },
    ],
  );
}

/** The user allowed `name`'s code here, and `name` must confirm too, as its setup named no device. */
export function showConfirm(name: string) {
  showAlert(
    t("Confirm on that computer"),
    t("Press Enter in {{name}}'s terminal, or Allow in its Parallax, to finish.", { name }),
    [{ text: t("OK") }],
  );
}

/** Another device asks to use the user's computers: "Allow <device>? <code>". */
export function confirmDevice(device: string, code: string, onAllow: () => void, onDeny: () => void) {
  showAlert(
    t("Allow {{device}}?", { device }),
    `${formatCode(code)}\n\n${t("Allow it only if {{device}} shows the same code. It gets full control of your computers.", { device })}`,
    [
      { text: t("Deny"), style: "destructive", onPress: onDeny },
      { text: t("Allow"), onPress: onAllow },
    ],
  );
}
