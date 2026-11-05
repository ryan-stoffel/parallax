import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearNotice, dialogState, finish, showAlert, showMenu, showPrompt } from "./dialogStore";

beforeEach(() => {
  while (dialogState().dialog) finish();
  const shown = dialogState().notice;
  if (shown) clearNotice(shown.id);
});

describe("dialogStore", () => {
  it("shows a button-less alert as a notice, and blocks only for buttons", () => {
    showAlert("Couldn't save", "No space left");
    expect(dialogState().dialog).toBeUndefined();
    expect(dialogState().notice).toMatchObject({ title: "Couldn't save", message: "No space left" });
    showAlert("Remove it?", undefined, [{ text: "Remove", style: "destructive" }]);
    expect(dialogState().dialog?.kind).toBe("alert");
  });

  it("keeps a newer notice when an older one's timer ends", () => {
    showAlert("First");
    const first = dialogState().notice!.id;
    showAlert("Second");
    clearNotice(first);
    expect(dialogState().notice?.title).toBe("Second");
  });

  it("shows dialogs one at a time, and a button can open the next", () => {
    const next = vi.fn(() => showAlert("Sure?", undefined, [{ text: "Yes" }]));
    showMenu([{ label: "Close", onPress: next }]);
    showAlert("Queued", undefined, [{ text: "OK" }]);
    expect(dialogState().dialog?.kind).toBe("menu");
    finish(next);
    expect(next).toHaveBeenCalledOnce();
    expect(dialogState().dialog).toMatchObject({ title: "Queued" });
    finish();
    expect(dialogState().dialog).toMatchObject({ title: "Sure?" });
  });

  it("gives a prompt with a function Cancel and OK, passing what was typed", () => {
    const answer = vi.fn();
    showPrompt("Rename thread", undefined, answer, "plain-text", "Old");
    const dialog = dialogState().dialog;
    if (dialog?.kind !== "prompt") throw new Error("not a prompt");
    expect(dialog.value).toBe("Old");
    expect(dialog.buttons.map((b) => b.text)).toEqual(["Cancel", "OK"]);
    dialog.buttons[1]!.onPress?.("New");
    expect(answer).toHaveBeenCalledWith("New");
  });
});
