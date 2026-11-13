// What the app's own dialogs, menus, and notices (Dialogs.tsx) show. Called like iOS's Alert from
// anywhere, including code outside a component. Dialogs and menus wait their turn, one at a time.
// A notice doesn't block anything, so the latest replaces the last. Pure, for the test.
import { t } from "i18next";
import type { LucideIcon } from "lucide-react-native";

export interface DialogButton {
  text: string;
  style?: "default" | "cancel" | "destructive";
  /** A prompt's button hears what was typed. */
  onPress?: (value?: string) => void;
}

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  detail?: string;
  destructive?: boolean;
  checked?: boolean;
  onPress: () => void;
}

export type Dialog =
  | { kind: "alert"; title: string; message?: string; buttons: DialogButton[] }
  | {
      kind: "prompt";
      title: string;
      message?: string;
      buttons: DialogButton[];
      secure: boolean;
      value: string;
      keyboardType?: "default" | "number-pad";
    }
  | { kind: "menu"; title?: string; items: MenuItem[] };

export interface Notice {
  id: number;
  title: string;
  message?: string;
}

let queue: Dialog[] = [];
let notice: Notice | undefined;
let noticeId = 0;
let state = { dialog: queue[0], notice };
const listeners = new Set<() => void>();

function changed() {
  state = { dialog: queue[0], notice };
  for (const listener of listeners) listener();
}

export const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const dialogState = () => state;

function open(dialog: Dialog) {
  queue = [...queue, dialog];
  changed();
}

/** Puts the current dialog away, then runs what its button does, which can open the next. */
export function finish(run?: () => void) {
  queue = queue.slice(1);
  changed();
  run?.();
}

/** Dismisses the notice `id`, unless a newer one took its place. */
export function clearNotice(id: number) {
  if (notice?.id !== id) return;
  notice = undefined;
  changed();
}

/** Says something. With buttons it's a dialog that waits for one, and without it's a notice. */
export function showAlert(title: string, message?: string, buttons?: DialogButton[]) {
  if (buttons?.length) return open({ kind: "alert", title, message, buttons });
  notice = { id: ++noticeId, title, message };
  changed();
}

/** Asks for one line of text. A function hears it from an OK button, beside Cancel. */
export function showPrompt(
  title: string,
  message?: string,
  answer?: ((value: string) => void) | DialogButton[],
  type: "plain-text" | "secure-text" = "plain-text",
  value = "",
  keyboardType?: "default" | "number-pad",
) {
  const buttons: DialogButton[] = Array.isArray(answer)
    ? answer
    : [{ text: t("Cancel"), style: "cancel" }, { text: t("OK"), onPress: (text) => answer?.(text ?? "") }];
  open({ kind: "prompt", title, message, buttons, secure: type === "secure-text", value, keyboardType });
}

/** A sheet of choices from the bottom. A tap outside or a drag down puts it away. */
export function showMenu(items: MenuItem[], title?: string) {
  open({ kind: "menu", title, items });
}
