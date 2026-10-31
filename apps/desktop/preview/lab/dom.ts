// How the lab reaches the real composer in the open thread (PLX-1206): its box, its editor, and
// the words in it, so the liquid body can take them over and give them back in place.

/** The real composer's box: the form around its Attach button. */
export const composerBox = () =>
  document.querySelector<HTMLFormElement>('button[aria-label="Attach files"]')?.closest("form") ??
  null;

/** The box's editor, where the lab types as a person would. */
export const editorOf = (box: HTMLElement) =>
  box.querySelector<HTMLElement>('[contenteditable="true"]') ?? undefined;

/** The editor's wrapper, which holds the text and its placeholder but not the buttons. */
export const textAreaOf = (box: HTMLElement) =>
  editorOf(box)?.closest<HTMLElement>('[class~="group/scroll"]') ?? undefined;

/** Resolves after `ms`, or rejects once `signal` aborts, so a script stops where it is. */
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

/** Types `text` into the box's editor a character at a time, as the editor's own input. */
export async function typeInto(box: HTMLElement, text: string, signal?: AbortSignal, perChar = 24) {
  editorOf(box)?.focus();
  for (const char of text) {
    document.execCommand("insertText", false, char);
    await sleep(perChar, signal);
  }
}

/** Puts `text` in the box at once. */
export function insertText(box: HTMLElement, text: string) {
  editorOf(box)?.focus();
  document.execCommand("insertText", false, text);
}

/** Empties the box's editor. */
export function clearEditor(box: HTMLElement) {
  editorOf(box)?.focus();
  document.execCommand("selectAll");
  document.execCommand("delete");
}

/** Drops `files` on the box, as the OS would, so the composer adds them its own way. */
export function dropFiles(box: HTMLElement, files: File[]) {
  const data = new DataTransfer();
  for (const file of files) data.items.add(file);
  box.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
}

export interface Word {
  text: string;
  /** Its box, in the form's own coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Each word in the editor and where it sits, so a copy can be laid exactly over it. */
export function wordsIn(box: HTMLElement): { words: Word[]; font: Partial<CSSStyleDeclaration> } {
  const editor = editorOf(box);
  const origin = box.getBoundingClientRect();
  const words: Word[] = [];
  if (!editor) return { words, font: {} };
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    for (const match of text.matchAll(/\S+/g)) {
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const rect = range.getClientRects()[0];
      if (!rect) continue;
      words.push({
        text: match[0],
        x: rect.left - origin.left,
        y: rect.top - origin.top,
        width: rect.width,
        height: rect.height,
      });
    }
  }
  const style = getComputedStyle(editor.querySelector("p") ?? editor);
  return {
    words,
    font: {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      letterSpacing: style.letterSpacing,
      color: style.color,
    },
  };
}
